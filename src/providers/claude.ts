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
  usage?: Record<string, unknown>;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  permission_denials?: unknown;
  modelUsage?: unknown;
  [key: string]: unknown;
}

interface ClaudeCliRateLimitLine {
  type: 'rate_limit_event';
  rate_limit_info?: Record<string, unknown>;
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

export const DEFAULT_CLAUDE_TOOLS = ['WebSearch', 'WebFetch'] as const;

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
  const usageExtras: Record<string, unknown> = {};

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

      if (parsed.type === 'rate_limit_event') {
        if (parsed.rate_limit_info !== undefined) {
          usageExtras.rate_limit_info = parsed.rate_limit_info;
        }

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
        usage = normalizeClaudeUsage(parsed.usage, {
          ...usageExtras,
          ...extractClaudeUsageExtras(parsed),
        });
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
    '--tools',
    DEFAULT_CLAUDE_TOOLS.join(' '),
    '--allowedTools',
    DEFAULT_CLAUDE_TOOLS.join(' '),
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
):
  | ClaudeCliResultLine
  | ClaudeCliRateLimitLine
  | ClaudeCliSystemLine
  | ClaudeCliStreamLine
  | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as
      | ClaudeCliResultLine
      | ClaudeCliRateLimitLine
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

export function normalizeClaudeUsage(
  usage?: ClaudeCliResultLine['usage'],
  extras: Record<string, unknown> = {},
): ChatCompletionUsage | undefined {
  if (!usage && Object.keys(extras).length === 0) {
    return undefined;
  }

  const rawUsage = usage ?? {};
  const promptTokens = getNumber(rawUsage, 'input_tokens');
  const completionTokens = getNumber(rawUsage, 'output_tokens');

  return {
    ...rawUsage,
    ...extras,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens:
        getNumber(rawUsage, 'cache_read_input_tokens') ||
        getNumber(rawUsage, 'cached_input_tokens'),
      audio_tokens:
        getNumber(rawUsage, 'audio_input_tokens') ||
        getNumber(rawUsage, 'prompt_audio_tokens'),
    },
    completion_tokens_details: {
      reasoning_tokens:
        getNumber(rawUsage, 'reasoning_output_tokens') ||
        getNumber(rawUsage, 'reasoning_tokens'),
      audio_tokens:
        getNumber(rawUsage, 'audio_output_tokens') ||
        getNumber(rawUsage, 'completion_audio_tokens'),
      accepted_prediction_tokens: getNumber(
        rawUsage,
        'accepted_prediction_tokens',
      ),
      rejected_prediction_tokens: getNumber(
        rawUsage,
        'rejected_prediction_tokens',
      ),
    },
  };
}

function extractClaudeUsageExtras(
  line: ClaudeCliResultLine,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};

  for (const key of [
    'duration_ms',
    'duration_api_ms',
    'num_turns',
    'total_cost_usd',
    'permission_denials',
    'modelUsage',
  ]) {
    const value = line[key];

    if (value !== undefined) {
      extras[key] = value;
    }
  }

  return extras;
}

function getNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];

  return typeof candidate === 'number' ? candidate : 0;
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
