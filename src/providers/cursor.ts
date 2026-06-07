import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { execa, execaSync } from 'execa';

import {
  ensureAgentWorkspaceDir,
  resolveAgentWorkspaceDir,
} from '../config.js';
import { FileSystemKvStore } from '../file-system-kv-store.js';
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

interface CursorCliSystemLine {
  type: 'system';
  subtype?: string;
  model?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface CursorCliUserLine {
  type: 'user';
  message?: {
    role?: string;
    content?: unknown;
  };
  session_id?: string;
}

interface CursorCliThinkingLine {
  type: 'thinking';
  subtype?: string;
  text?: string;
  session_id?: string;
}

interface CursorCliAssistantLine {
  type: 'assistant';
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  session_id?: string;
  timestamp_ms?: number;
}

interface CursorCliToolCallEntry {
  args?: unknown;
  result?: unknown;
}

interface CursorCliToolCallLine {
  type: 'tool_call';
  subtype?: string;
  call_id?: string;
  tool_call?: Record<string, CursorCliToolCallEntry>;
  session_id?: string;
}

interface CursorCliResultLine {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  request_id?: string;
  usage?: Record<string, unknown>;
  duration_ms?: number;
  duration_api_ms?: number;
  [key: string]: unknown;
}

type CursorCliLine =
  | CursorCliSystemLine
  | CursorCliUserLine
  | CursorCliThinkingLine
  | CursorCliAssistantLine
  | CursorCliToolCallLine
  | CursorCliResultLine;

interface CursorSessionEvent {
  type: 'cursor.session';
  sessionId: string;
}

interface CursorResultEvent {
  type: 'cursor.result';
  usage?: ChatCompletionUsage;
  fallbackText: string;
}

export type CursorStreamEvent =
  | ProviderChatCompletionEvent
  | CursorSessionEvent
  | CursorResultEvent;

export const CURSOR_SESSION_MAPPING_STORE_ID = 'cursor/session_mapping/v1';
export const CURSOR_SESSION_MAPPING_STORE_VERSION = 'v1';
export const CURSOR_REASONING_FORMAT = 'cursor-agent-v1';

const CURSOR_ASSISTANT_THINK_TAG_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const CURSOR_ASSISTANT_THINKING_TAG_PATTERN =
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;

export interface PreparedCursorResumeSession {
  sessionId: string;
  historyHash: string;
}

export interface ResolvedCursorCommand {
  command: string;
  baseArgs: string[];
}

export class CursorProvider implements AgentProvider {
  readonly name = 'cursor';

  createChatCompletion(
    input: ProviderChatCompletionInput,
    signal: AbortSignal,
  ): ProviderChatCompletionRun {
    const metadata = createCompletionMetadata(input.model ?? 'cursor-agent');

    return {
      metadata,
      events: streamCursorChatCompletion(input, signal),
    };
  }
}

export async function* streamCursorChatCompletion(
  input: ProviderChatCompletionInput,
  signal: AbortSignal,
): AsyncIterable<ProviderChatCompletionEvent> {
  const cwd = await ensureCursorWorkingDirectory();
  const normalizedHistory = normalizeCursorResumeHistory(input.history ?? []);
  const resumeSession = await prepareCursorResumeSession(input);
  const promptToSend = resumeSession
    ? input.prompt
    : normalizedHistory.length > 0
      ? composeCursorColdStartPrompt(input, normalizedHistory)
      : composeCursorFreshPrompt(input);
  const { command, baseArgs } = resolveCursorCommand();
  const subprocess = execa(
    command,
    [
      ...baseArgs,
      ...buildCursorArgs(input, resumeSession?.sessionId, promptToSend),
    ],
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
    throw new Error('Failed to capture Cursor CLI stdout.');
  }

  const stderrChunks: string[] = [];
  let sawTextDelta = false;
  let assistantText = '';
  let fallbackText = '';
  let usage: ChatCompletionUsage | undefined;
  let capturedSessionId: string | undefined;

  void consumeStderr(subprocess.stderr, stderrChunks);

  try {
    const lines = createInterface({
      input: stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const event of transformCursorLines(lines, () =>
      stderrChunks.join('').trim(),
    )) {
      if (event.type === 'cursor.session') {
        capturedSessionId = event.sessionId;
        continue;
      }

      if (event.type === 'cursor.result') {
        usage = event.usage;
        fallbackText = event.fallbackText;
        continue;
      }

      if (event.type === 'response.output_text.delta') {
        sawTextDelta = true;
        assistantText += event.text;
      }

      yield event;
    }

    const result = await subprocess;

    if (result.exitCode !== 0) {
      throw new Error(
        stderrChunks.join('').trim() ||
          `Cursor CLI exited with code ${result.exitCode}.`,
      );
    }

    if (!sawTextDelta && fallbackText.trim().length > 0) {
      assistantText = fallbackText;
      yield {
        type: 'response.output_text.delta',
        text: fallbackText,
      };
    }

    await tryUpdateCursorSessionMapping(
      resumeSession?.sessionId ?? capturedSessionId,
      input,
      assistantText,
    );

    yield {
      type: 'response.completed',
      finishReason: 'stop',
      usage,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Cursor CLI execution failed.';
    throw new Error(message, { cause: error });
  }
}

/**
 * Transforms Cursor stream-json NDJSON lines into provider events.
 *
 * Assistant text in `--stream-partial-output` mode arrives as incremental
 * deltas followed by a consolidated copy of the whole block. The consolidated
 * copy is detected by comparing it against the accumulated block text and is
 * skipped to avoid duplicating output.
 */
export async function* transformCursorLines(
  lines: Iterable<string> | AsyncIterable<string>,
  getStderr: () => string = () => '',
): AsyncIterable<CursorStreamEvent> {
  let blockAccumulator = '';
  let reasoningIndex = 0;
  let nextToolCallIndex = 0;
  let lastSessionId: string | undefined;
  const toolCallIndexes = new Map<string, number>();

  for await (const line of lines) {
    const parsed = parseCursorLine(line);

    if (!parsed) {
      continue;
    }

    if (
      typeof parsed.session_id === 'string' &&
      parsed.session_id.length > 0 &&
      parsed.session_id !== lastSessionId
    ) {
      lastSessionId = parsed.session_id;
      yield {
        type: 'cursor.session',
        sessionId: parsed.session_id,
      };
    }

    if (parsed.type === 'system') {
      if (
        parsed.subtype === 'init' &&
        typeof parsed.model === 'string' &&
        parsed.model.length > 0
      ) {
        yield {
          type: 'response.metadata',
          model: parsed.model,
        };
      }

      continue;
    }

    if (parsed.type === 'thinking') {
      if (
        parsed.subtype === 'delta' &&
        typeof parsed.text === 'string' &&
        parsed.text.length > 0
      ) {
        yield {
          type: 'response.output_reasoning.delta',
          reasoningId: `reasoning-${reasoningIndex}`,
          reasoningIndex,
          reasoningText: parsed.text,
          format: CURSOR_REASONING_FORMAT,
        };
      } else if (parsed.subtype === 'completed') {
        reasoningIndex += 1;
        blockAccumulator = '';
      }

      continue;
    }

    if (parsed.type === 'tool_call') {
      blockAccumulator = '';

      const toolCallDelta = extractCursorToolCallDelta(
        parsed,
        toolCallIndexes,
        () => nextToolCallIndex++,
      );

      if (toolCallDelta) {
        yield toolCallDelta;
      }

      const toolResultDelta = extractCursorToolResultDelta(
        parsed,
        toolCallIndexes,
      );

      if (toolResultDelta) {
        yield toolResultDelta;
      }

      continue;
    }

    if (parsed.type === 'assistant') {
      const text = extractCursorAssistantText(parsed);

      if (text.length === 0) {
        continue;
      }

      if (blockAccumulator.length > 0 && text === blockAccumulator) {
        blockAccumulator = '';
        continue;
      }

      blockAccumulator += text;
      yield {
        type: 'response.output_text.delta',
        text,
      };

      continue;
    }

    if (parsed.type === 'result') {
      if (parsed.is_error || parsed.subtype === 'error') {
        throw new Error(
          parsed.result || getStderr() || 'Cursor CLI failed.',
        );
      }

      yield {
        type: 'cursor.result',
        usage: normalizeCursorUsage(
          parsed.usage,
          extractCursorUsageExtras(parsed),
        ),
        fallbackText:
          typeof parsed.result === 'string' ? parsed.result : '',
      };
    }
  }
}

export function buildCursorArgs(
  input: ProviderChatCompletionInput,
  resumeSessionId: string | undefined,
  prompt: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--trust',
  ];

  if (isCursorForceEnabled(env)) {
    args.push('--force');
  }

  if (input.model) {
    args.push('--model', input.model);
  }

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  args.push(prompt);

  return args;
}

export function resolveCursorWorkingDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveCursorPath(resolveAgentWorkspaceDir(env));
}

export async function ensureCursorWorkingDirectory(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return resolveCursorPathAsync(await ensureAgentWorkspaceDir(env));
}

export function flattenCursorHistory(
  history: ProviderChatHistoryMessage[],
): string {
  return normalizeCursorResumeHistory(history)
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`,
    )
    .join('\n\n');
}

export function normalizeCursorResumeHistory(
  history: ProviderChatHistoryMessage[],
): ProviderChatHistoryMessage[] {
  return history
    .map((message) => ({
      role: message.role,
      content: normalizeCursorMessageContent(message),
    }))
    .filter((message) => message.content.length > 0);
}

export function createCursorSessionHistoryHash(
  history: ProviderChatHistoryMessage[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeCursorResumeHistory(history)))
    .digest('hex');
}

export async function prepareCursorResumeSession(
  input: Pick<ProviderChatCompletionInput, 'history'>,
  options: {
    sessionMappingStore?: FileSystemKvStore;
  } = {},
): Promise<PreparedCursorResumeSession | undefined> {
  const history = normalizeCursorResumeHistory(input.history ?? []);

  if (history.length === 0) {
    return undefined;
  }

  const historyHash = createCursorSessionHistoryHash(history);
  const sessionMappingStore =
    options.sessionMappingStore ??
    new FileSystemKvStore(
      CURSOR_SESSION_MAPPING_STORE_ID,
      CURSOR_SESSION_MAPPING_STORE_VERSION,
    );

  let mappedSessionId: string | undefined;

  try {
    mappedSessionId = (await sessionMappingStore.claim(historyHash))?.trim();
  } catch {
    return undefined;
  }

  if (!mappedSessionId || !isCursorSessionId(mappedSessionId)) {
    return undefined;
  }

  return {
    sessionId: mappedSessionId,
    historyHash,
  };
}

export async function updateCursorSessionMapping(
  sessionId: string,
  history: ProviderChatHistoryMessage[],
  options: {
    sessionMappingStore?: FileSystemKvStore;
  } = {},
): Promise<void> {
  const normalized = normalizeCursorResumeHistory(history);

  if (!isCursorSessionId(sessionId) || normalized.length === 0) {
    return;
  }

  const sessionMappingStore =
    options.sessionMappingStore ??
    new FileSystemKvStore(
      CURSOR_SESSION_MAPPING_STORE_ID,
      CURSOR_SESSION_MAPPING_STORE_VERSION,
    );

  await sessionMappingStore.set(
    createCursorSessionHistoryHash(normalized),
    sessionId,
  );
}

export function parseCursorLine(line: string): CursorCliLine | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CursorCliLine;
  } catch {
    return null;
  }
}

export function extractCursorToolName(
  toolCall: Record<string, CursorCliToolCallEntry> | undefined,
): string | undefined {
  if (!toolCall) {
    return undefined;
  }

  const key = Object.keys(toolCall)[0];

  if (!key) {
    return undefined;
  }

  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}

export function normalizeCursorUsage(
  usage?: CursorCliResultLine['usage'],
  extras: Record<string, unknown> = {},
): ChatCompletionUsage | undefined {
  if (!usage && Object.keys(extras).length === 0) {
    return undefined;
  }

  const rawUsage = usage ?? {};
  const promptTokens = getNumber(rawUsage, 'inputTokens');
  const completionTokens = getNumber(rawUsage, 'outputTokens');

  return {
    ...rawUsage,
    ...extras,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: getNumber(rawUsage, 'cacheReadTokens'),
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

function composeCursorFreshPrompt(input: ProviderChatCompletionInput): string {
  if (input.systemPrompt) {
    return `${input.systemPrompt}\n\n${input.prompt}`;
  }

  return input.prompt;
}

function composeCursorColdStartPrompt(
  input: ProviderChatCompletionInput,
  normalizedHistory: ProviderChatHistoryMessage[],
): string {
  const transcript = flattenCursorHistory(normalizedHistory);
  const sections: string[] = [];

  if (input.systemPrompt) {
    sections.push(input.systemPrompt);
  }

  sections.push(
    `Here is the conversation so far:\n\n${transcript}\n\nContinue the conversation by responding to the latest user message below.\n\nUser: ${input.prompt}`,
  );

  return sections.join('\n\n');
}

function extractCursorAssistantText(line: CursorCliAssistantLine): string {
  const content = line.message?.content;

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function extractCursorToolCallDelta(
  line: CursorCliToolCallLine,
  toolCallIndexes: Map<string, number>,
  createToolCallIndex: () => number,
): ProviderChatCompletionEvent | null {
  if (line.subtype !== 'started' || typeof line.call_id !== 'string') {
    return null;
  }

  const toolName = extractCursorToolName(line.tool_call);
  const entry = getCursorToolCallEntry(line.tool_call);
  const toolCallIndex = createToolCallIndex();

  toolCallIndexes.set(line.call_id, toolCallIndex);

  return {
    type: 'response.output_tool_call.delta',
    toolCallIndex,
    toolCallId: line.call_id,
    toolName,
    toolArguments: JSON.stringify(entry?.args ?? {}),
  };
}

function extractCursorToolResultDelta(
  line: CursorCliToolCallLine,
  toolCallIndexes: Map<string, number>,
): ProviderChatCompletionEvent | null {
  if (line.subtype !== 'completed' || typeof line.call_id !== 'string') {
    return null;
  }

  const entry = getCursorToolCallEntry(line.tool_call);

  if (entry?.result === undefined) {
    return null;
  }

  const toolCallIndex = toolCallIndexes.get(line.call_id);

  if (toolCallIndex === undefined) {
    return null;
  }

  return {
    type: 'response.output_tool_result.delta',
    toolCallIndex,
    toolCallId: line.call_id,
    toolOutput: JSON.stringify(entry.result),
  };
}

function getCursorToolCallEntry(
  toolCall: Record<string, CursorCliToolCallEntry> | undefined,
): CursorCliToolCallEntry | undefined {
  if (!toolCall) {
    return undefined;
  }

  const key = Object.keys(toolCall)[0];

  return key ? toolCall[key] : undefined;
}

function extractCursorUsageExtras(
  line: CursorCliResultLine,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};

  for (const key of ['duration_ms', 'duration_api_ms', 'request_id']) {
    const value = line[key];

    if (value !== undefined) {
      extras[key] = value;
    }
  }

  return extras;
}

async function tryUpdateCursorSessionMapping(
  sessionId: string | undefined,
  input: ProviderChatCompletionInput,
  assistantText: string,
): Promise<void> {
  if (!sessionId || assistantText.trim().length === 0) {
    return;
  }

  const fullHistory: ProviderChatHistoryMessage[] = [
    ...(input.history ?? []),
    {
      role: 'user',
      content: input.prompt,
    },
    {
      role: 'assistant',
      content: assistantText,
    },
  ];

  try {
    await updateCursorSessionMapping(sessionId, fullHistory);
  } catch {
    // Mapping failures should not affect the Cursor response path.
  }
}

function normalizeCursorMessageContent(
  message: ProviderChatHistoryMessage,
): string {
  if (message.role !== 'assistant') {
    return message.content.trim();
  }

  return stripCursorAssistantReasoning(message.content).trim();
}

function stripCursorAssistantReasoning(content: string): string {
  return content
    .replace(CURSOR_ASSISTANT_THINK_TAG_PATTERN, '')
    .replace(CURSOR_ASSISTANT_THINKING_TAG_PATTERN, '');
}

function isCursorForceEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const value = env.CURSOR_FORCE?.trim().toLowerCase();

  return value === '1' || value === 'true' || value === 'yes';
}

function isCursorSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function getNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];

  return typeof candidate === 'number' ? candidate : 0;
}

function resolveCursorPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function resolveCursorPathAsync(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
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

let cachedCursorCommand: ResolvedCursorCommand | undefined;

/**
 * Resolves the Cursor CLI command to use.
 * Prefers the standalone `cursor-agent` binary, then falls back to the
 * `cursor agent` subcommand, then to known default install locations.
 */
export function resolveCursorCommand(): ResolvedCursorCommand {
  if (cachedCursorCommand) {
    return cachedCursorCommand;
  }

  if (isCommandOnPath('cursor-agent')) {
    cachedCursorCommand = { command: 'cursor-agent', baseArgs: [] };
    return cachedCursorCommand;
  }

  if (isCommandOnPath('cursor')) {
    cachedCursorCommand = { command: 'cursor', baseArgs: ['agent'] };
    return cachedCursorCommand;
  }

  const homebrewCursorAgent = '/opt/homebrew/bin/cursor-agent';
  if (existsSync(homebrewCursorAgent)) {
    cachedCursorCommand = { command: homebrewCursorAgent, baseArgs: [] };
    return cachedCursorCommand;
  }

  const localCursorAgent = join(homedir(), '.local', 'bin', 'cursor-agent');
  if (existsSync(localCursorAgent)) {
    cachedCursorCommand = { command: localCursorAgent, baseArgs: [] };
    return cachedCursorCommand;
  }

  const localCursor = join(homedir(), '.local', 'bin', 'cursor');
  if (existsSync(localCursor)) {
    cachedCursorCommand = { command: localCursor, baseArgs: ['agent'] };
    return cachedCursorCommand;
  }

  cachedCursorCommand = { command: 'cursor-agent', baseArgs: [] };
  return cachedCursorCommand;
}

function isCommandOnPath(command: string): boolean {
  try {
    execaSync('which', [command]);
    return true;
  } catch {
    return false;
  }
}
