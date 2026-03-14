import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  ProviderChatHistoryMessage,
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

interface ClaudeCliUserLine {
  type: 'user';
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      tool_use_id?: string;
      content?: string;
    }>;
  };
}

interface ClaudeCliStreamLine {
  type: 'stream_event';
  event?: {
    type?: string;
    index?: number;
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      thinking?: string;
      signature?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      partial_json?: string;
      thinking?: string;
      signature?: string;
    };
  };
}

export const DEFAULT_CLAUDE_TOOLS = ['WebSearch', 'WebFetch'] as const;
const DEFAULT_CLAUDE_SESSION_VERSION = 'synthetic';

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
  const resumeSession = await seedClaudeResumeSession(input, cwd);
  const subprocess = execa(
    'claude',
    buildClaudeArgs(input, resumeSession?.sessionId),
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      reject: false,
      cancelSignal: signal,
    },
  );
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
  const toolCallIndexes = new Map<number, number>();
  const toolCallIds = new Map<string, number>();
  const reasoningIndexes = new Map<number, number>();
  let nextReasoningIndex = 0;
  let nextToolCallIndex = 0;

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

      if (parsed.type === 'user') {
        const toolResultDelta = extractClaudeToolResultDelta(
          parsed,
          toolCallIds,
        );

        if (toolResultDelta) {
          yield toolResultDelta;
        }

        continue;
      }

      if (parsed.type === 'rate_limit_event') {
        if (parsed.rate_limit_info !== undefined) {
          usageExtras.rate_limit_info = parsed.rate_limit_info;
        }

        continue;
      }

      if (parsed.type === 'stream_event') {
        const reasoningDelta = extractClaudeReasoningDelta(
          parsed,
          reasoningIndexes,
          () => nextReasoningIndex++,
        );

        if (reasoningDelta) {
          yield reasoningDelta;
          continue;
        }

        const toolCallDelta = extractClaudeToolCallDelta(
          parsed,
          toolCallIndexes,
          toolCallIds,
          () => nextToolCallIndex++,
        );

        if (toolCallDelta) {
          yield toolCallDelta;
          continue;
        }

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

export function buildClaudeArgs(
  input: ProviderChatCompletionInput,
  resumeSessionId?: string,
): string[] {
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

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  if (input.systemPrompt) {
    args.push('--system-prompt', input.systemPrompt);
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

export function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9_-]/g, '-');
}

export function resolveClaudeProjectsDirectory(
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
): string {
  return join(claudeConfigDir, 'projects');
}

export interface ClaudeResumeSessionSeed {
  sessionId: string;
  filePath: string;
  content: string;
}

export function createClaudeResumeSession(options: {
  history: ProviderChatHistoryMessage[];
  cwd: string;
  sessionId?: string;
  claudeConfigDir?: string;
  model?: string;
  now?: Date;
  version?: string;
}): ClaudeResumeSessionSeed | undefined {
  const history = options.history
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (history.length === 0) {
    return undefined;
  }

  const sessionId = options.sessionId ?? randomUUID();
  const version = options.version ?? DEFAULT_CLAUDE_SESSION_VERSION;
  const filePath = join(
    resolveClaudeProjectsDirectory(options.claudeConfigDir),
    encodeClaudeProjectPath(options.cwd),
    `${sessionId}.jsonl`,
  );
  const startedAt = options.now ?? new Date();
  let previousUuid: string | null = null;
  let timestampOffsetMs = 0;
  let lastUserPrompt: string | undefined;
  const lines: string[] = [];

  for (const message of history) {
    const uuid = randomUUID();
    const timestamp = new Date(
      startedAt.getTime() + timestampOffsetMs,
    ).toISOString();

    timestampOffsetMs += 1;

    // Note: we commented out some fields that seems to not affect the ability of Claude CLI to restore the session.

    if (message.role === 'user') {
      lines.push(
        JSON.stringify({
          type: 'file-history-snapshot',
          messageId: uuid,
          snapshot: {
            messageId: uuid,
            trackedFileBackups: {},
            timestamp,
          },
          isSnapshotUpdate: false,
        }),
      );
      lines.push(
        JSON.stringify({
          parentUuid: previousUuid,
          // isSidechain: false,
          // promptId: randomUUID(),
          type: 'user',
          message: {
            role: 'user',
            content: message.content,
          },
          uuid,
          timestamp,
          // permissionMode: 'default',
          userType: 'external',
          // cwd: options.cwd,
          sessionId,
          // version,
          __restored: true,
        }),
      );
      lastUserPrompt = message.content;
      previousUuid = uuid;
      continue;
    }

    lines.push(
      JSON.stringify({
        parentUuid: previousUuid,
        // isSidechain: false,
        message: {
          // model: options.model ?? 'claude-code',
          // id: `msg_${randomUUID().replaceAll('-', '')}`,
          // type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: message.content,
            },
          ],
          // stop_reason: 'end_turn',
          // stop_sequence: null,
        },
        // requestId: `req_${randomUUID().replaceAll('-', '')}`,
        type: 'assistant',
        uuid,
        timestamp,
        userType: 'external',
        // cwd: options.cwd,
        sessionId,
        // version,
        __restored: true,
      }),
    );
    previousUuid = uuid;
  }

  if (lastUserPrompt) {
    lines.push(
      JSON.stringify({
        type: 'last-prompt',
        lastPrompt: lastUserPrompt,
        sessionId,
      }),
    );
  }

  return {
    sessionId,
    filePath,
    content: `${lines.join('\n')}\n`,
  };
}

export async function seedClaudeResumeSession(
  input: Pick<ProviderChatCompletionInput, 'history' | 'model'>,
  cwd: string,
  options: {
    claudeConfigDir?: string;
    sessionId?: string;
    now?: Date;
    version?: string;
  } = {},
): Promise<ClaudeResumeSessionSeed | undefined> {
  const session = createClaudeResumeSession({
    history: input.history ?? [],
    cwd,
    claudeConfigDir: options.claudeConfigDir,
    sessionId: options.sessionId,
    model: input.model,
    now: options.now,
    version: options.version,
  });

  if (!session) {
    return undefined;
  }

  await mkdir(dirname(session.filePath), { recursive: true });
  await writeFile(session.filePath, session.content, 'utf8');

  return session;
}

export function parseClaudeLine(
  line: string,
):
  | ClaudeCliResultLine
  | ClaudeCliRateLimitLine
  | ClaudeCliSystemLine
  | ClaudeCliUserLine
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
      | ClaudeCliUserLine
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

function extractClaudeReasoningDelta(
  line: ClaudeCliStreamLine,
  reasoningIndexes: Map<number, number>,
  createReasoningIndex: () => number,
): ProviderChatCompletionEvent | null {
  const event = line.event;

  if (
    event?.type === 'content_block_start' &&
    typeof event.index === 'number' &&
    event.content_block?.type === 'thinking'
  ) {
    reasoningIndexes.set(event.index, createReasoningIndex());
    return null;
  }

  if (
    event?.type === 'content_block_delta' &&
    typeof event.index === 'number' &&
    event.delta?.type === 'thinking_delta' &&
    typeof event.delta.thinking === 'string'
  ) {
    const reasoningIndex = getReasoningIndex(
      reasoningIndexes,
      event.index,
      createReasoningIndex,
    );

    return {
      type: 'response.output_reasoning.delta',
      reasoningId: createReasoningId(reasoningIndex),
      reasoningIndex,
      reasoningText: event.delta.thinking,
      format: 'anthropic-claude-v1',
    };
  }

  if (
    event?.type === 'content_block_delta' &&
    typeof event.index === 'number' &&
    event.delta?.type === 'signature_delta' &&
    typeof event.delta.signature === 'string'
  ) {
    const reasoningIndex = getReasoningIndex(
      reasoningIndexes,
      event.index,
      createReasoningIndex,
    );

    return {
      type: 'response.output_reasoning.delta',
      reasoningId: createReasoningId(reasoningIndex),
      reasoningIndex,
      signature: event.delta.signature,
      format: 'anthropic-claude-v1',
    };
  }

  return null;
}

function extractClaudeToolCallDelta(
  line: ClaudeCliStreamLine,
  toolCallIndexes: Map<number, number>,
  toolCallIds: Map<string, number>,
  createToolCallIndex: () => number,
): ProviderChatCompletionEvent | null {
  const event = line.event;

  if (
    event?.type === 'content_block_start' &&
    typeof event.index === 'number' &&
    event.content_block?.type === 'tool_use' &&
    typeof event.content_block.id === 'string' &&
    typeof event.content_block.name === 'string'
  ) {
    const toolCallIndex = createToolCallIndex();

    toolCallIndexes.set(event.index, toolCallIndex);
    toolCallIds.set(event.content_block.id, toolCallIndex);

    return {
      type: 'response.output_tool_call.delta',
      toolCallIndex,
      toolCallId: event.content_block.id,
      toolName: event.content_block.name,
      toolArguments: '',
    };
  }

  if (
    event?.type === 'content_block_delta' &&
    typeof event.index === 'number' &&
    event.delta?.type === 'input_json_delta' &&
    typeof event.delta.partial_json === 'string'
  ) {
    const toolCallIndex = toolCallIndexes.get(event.index);

    if (toolCallIndex === undefined) {
      return null;
    }

    return {
      type: 'response.output_tool_call.delta',
      toolCallIndex,
      toolArguments: event.delta.partial_json,
    };
  }

  return null;
}

function extractClaudeToolResultDelta(
  line: ClaudeCliUserLine,
  toolCallIds: Map<string, number>,
): ProviderChatCompletionEvent | null {
  const content = line.message?.content;

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (
      part.type === 'tool_result' &&
      typeof part.tool_use_id === 'string' &&
      typeof part.content === 'string'
    ) {
      const toolCallIndex = toolCallIds.get(part.tool_use_id);

      if (toolCallIndex === undefined) {
        return null;
      }

      return {
        type: 'response.output_tool_result.delta',
        toolCallIndex,
        toolCallId: part.tool_use_id,
        toolOutput: part.content,
      };
    }
  }

  return null;
}

function getReasoningIndex(
  reasoningIndexes: Map<number, number>,
  streamIndex: number,
  createReasoningIndex: () => number,
): number {
  const current = reasoningIndexes.get(streamIndex);

  if (current !== undefined) {
    return current;
  }

  const next = createReasoningIndex();

  reasoningIndexes.set(streamIndex, next);

  return next;
}

function createReasoningId(reasoningIndex: number): string {
  return `reasoning-${reasoningIndex}`;
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
