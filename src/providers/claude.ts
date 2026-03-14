import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { execa } from 'execa';

import {
  type ChatCompletionUsage,
  createCompletionMetadata,
  type ProviderChatCompletionEvent,
} from '../openai.js';
import type {
  AgentProvider,
  ProviderChatCompletionInput,
  ProviderChatCompletionRun,
} from '../providers.js';

interface ClaudeCliResultLine {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ClaudeCliSystemLine {
  type: 'system';
  subtype?: string;
  model?: string;
}

interface ClaudeCliStreamLine {
  type: 'stream_event';
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';

  createChatCompletion(
    input: ProviderChatCompletionInput,
    signal: AbortSignal,
  ): ProviderChatCompletionRun {
    const metadata = createCompletionMetadata(input.model ?? 'claude-code');

    return {
      metadata,
      events: streamClaudeChatCompletion(input, signal),
    };
  }
}

export async function* streamClaudeChatCompletion(
  input: ProviderChatCompletionInput,
  signal: AbortSignal,
): AsyncIterable<ProviderChatCompletionEvent> {
  const cwd = resolveClaudeWorkingDirectory();
  const subprocess = execa('claude', buildClaudeArgs(input), {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    reject: false,
    cancelSignal: signal,
  });
  const stdout = subprocess.stdout;

  if (!stdout) {
    throw new Error('Failed to capture Claude CLI stdout.');
  }

  const stderrChunks: string[] = [];
  let sawTextDelta = false;
  let fallbackText = '';
  let usage: ChatCompletionUsage | undefined;
  let finishReason: 'stop' | 'length' = 'stop';

  void consumeStderr(subprocess.stderr, stderrChunks);

  try {
    const lines = createInterface({
      input: stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of lines) {
      const parsed = parseClaudeLine(line);

      if (!parsed) {
        continue;
      }

      if (
        parsed.type === 'system' &&
        parsed.subtype === 'init' &&
        typeof parsed.model === 'string' &&
        parsed.model.length > 0
      ) {
        yield {
          type: 'response.metadata',
          model: parsed.model,
        };
        continue;
      }

      if (parsed.type === 'stream_event') {
        const deltaText = extractClaudeTextDelta(parsed);

        if (deltaText.length > 0) {
          sawTextDelta = true;
          yield {
            type: 'response.output_text.delta',
            text: deltaText,
          };
        }

        continue;
      }

      if (parsed.type === 'result') {
        if (parsed.is_error || parsed.subtype === 'error') {
          throw new Error(
            parsed.result ||
              stderrChunks.join('').trim() ||
              'Claude CLI failed.',
          );
        }

        fallbackText =
          typeof parsed.result === 'string' ? parsed.result : fallbackText;
        usage = normalizeClaudeUsage(parsed.usage);
        finishReason = mapClaudeStopReason(parsed.stop_reason);
      }
    }

    const result = await subprocess;

    if (result.exitCode !== 0) {
      throw new Error(
        stderrChunks.join('').trim() ||
          `Claude CLI exited with code ${result.exitCode}.`,
      );
    }

    if (!sawTextDelta && fallbackText.trim().length > 0) {
      yield {
        type: 'response.output_text.delta',
        text: fallbackText,
      };
    }

    yield {
      type: 'response.completed',
      finishReason,
      usage,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Claude CLI execution failed.';
    throw new Error(message, { cause: error });
  }
}

export function buildClaudeArgs(input: ProviderChatCompletionInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];

  if (input.model) {
    args.push('--model', input.model);
  }

  args.push(input.prompt);

  return args;
}

export function resolveClaudeWorkingDirectory(baseDir = process.cwd()): string {
  const cwd = resolve(baseDir, 'agent-workspace');

  if (!existsSync(cwd)) {
    throw new Error(`Claude workspace directory not found: ${cwd}`);
  }

  return cwd;
}

export function parseClaudeLine(
  line: string,
): ClaudeCliResultLine | ClaudeCliSystemLine | ClaudeCliStreamLine | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as
      | ClaudeCliResultLine
      | ClaudeCliSystemLine
      | ClaudeCliStreamLine;
  } catch {
    return null;
  }
}

function extractClaudeTextDelta(line: ClaudeCliStreamLine): string {
  const event = line.event;

  if (
    event?.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string'
  ) {
    return event.delta.text;
  }

  return '';
}

function normalizeClaudeUsage(
  usage?: ClaudeCliResultLine['usage'],
): ChatCompletionUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function mapClaudeStopReason(stopReason?: string): 'stop' | 'length' {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

async function consumeStderr(
  stream: Readable | undefined,
  sink: string[],
): Promise<void> {
  if (!stream) {
    return;
  }

  for await (const chunk of stream) {
    sink.push(String(chunk));
  }
}
