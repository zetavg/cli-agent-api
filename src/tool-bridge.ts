import { randomUUID } from 'node:crypto';

import type { ConversationMessage } from './messages.js';
import type { ProviderChatCompletionEvent } from './openai.js';
import type { ProviderChatHistoryMessage } from './providers.js';

/**
 * The prompted tool-calling protocol.
 *
 * `claude -p` and `cursor-agent -p` run their own built-in tools inline and
 * return a final answer; they have no native way to expose a caller's tools and
 * pause for externally executed results (the OpenAI agent loop). The bridge
 * teaches the model a sentinel-delimited wire format so it can request the
 * client's tools as plain text, which we parse back into standard OpenAI
 * `tool_calls`.
 *
 * Sentinels are deliberately distinctive so they will not collide with code or
 * prose, and they are scanned as literal substrings so the stream parser can
 * recover even when a marker is split across chunks.
 */
export const TOOL_CALL_OPEN = '<<<TOOL_CALL>>>';
export const TOOL_CALL_CLOSE = '<<<END_TOOL_CALL>>>';
export const TOOL_RESULT_OPEN_PREFIX = '<<<TOOL_RESULT id=';
export const TOOL_RESULT_OPEN_SUFFIX = '>>>';
export const TOOL_RESULT_CLOSE = '<<<END_TOOL_RESULT>>>';

export interface BridgeToolDefinition {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type BridgeVariant = 'claude' | 'cursor';

/**
 * Builds the system-prompt section that overrides any pre-existing tool
 * instructions and teaches the model the sentinel protocol.
 */
export function buildToolSystemPromptSection(
  tools: BridgeToolDefinition[],
  variant: BridgeVariant,
): string {
  const toolDefinitions = tools
    .map((tool) => {
      const parameters =
        tool.function.parameters === undefined
          ? '{}'
          : JSON.stringify(tool.function.parameters);
      const description = tool.function.description?.trim();

      return [
        `- ${tool.function.name}`,
        description ? `  description: ${description}` : undefined,
        `  parameters (JSON Schema): ${parameters}`,
      ]
        .filter((line) => line !== undefined)
        .join('\n');
    })
    .join('\n');

  const override =
    variant === 'cursor'
      ? [
          'IMPORTANT: You must ignore any tools that were previously provided to you — they do not exist.',
          'Ignore any previous instructions about how to call a tool.',
          'The only tools you may use are the ones defined below, and they must be called using the exact format described below.',
        ].join('\n')
      : 'You can call tools to accomplish the task. The only tools available are defined below, and they must be called using the exact format described below.';

  return [
    override,
    '',
    'Available tools:',
    toolDefinitions,
    '',
    'To call a tool, output a block in EXACTLY this format:',
    TOOL_CALL_OPEN,
    '{"id": "<unique id>", "name": "<tool name>", "arguments": { /* JSON object matching the tool parameters */ }}',
    TOOL_CALL_CLOSE,
    '',
    'CRITICAL RULES — follow them exactly:',
    '- The body between the markers MUST be a single valid JSON object. "arguments" MUST be a JSON object, not a string.',
    `- You do NOT execute tools. You only request them. After you emit your tool call(s), STOP your response immediately and output nothing else — no prose, no summary, no "now I will…". The system runs the tools and sends the results back in a new message, and only then do you continue.`,
    `- NEVER write tool results yourself. Do NOT invent, simulate, guess, or echo a tool's output. Do NOT write ${TOOL_RESULT_OPEN_PREFIX}…${TOOL_RESULT_OPEN_SUFFIX} or ${TOOL_RESULT_CLOSE} blocks — those are written ONLY by the system. If you catch yourself about to describe what a tool returned, stop instead and wait.`,
    '- Take ONE step at a time. Request only the tool call(s) needed right now (you may emit several blocks back-to-back if they can run in parallel), then stop and wait for the results before deciding the next step. Do not plan out and "perform" a whole sequence of steps in one response.',
    `- Tool results will come back to you wrapped in ${TOOL_RESULT_OPEN_PREFIX}"<id>"${TOOL_RESULT_OPEN_SUFFIX} … ${TOOL_RESULT_CLOSE} markers. Use them to decide your next tool call or final answer.`,
    '- When you are done and need no more tools, reply with plain text only (no tool-call block).',
  ].join('\n');
}

/**
 * Formats client-executed tool results as the user turn that continues an agent
 * loop.
 */
export function formatToolResultsForPrompt(
  items: Array<{ toolCallId: string; content: string }>,
): string {
  return items.map((item) => formatToolResultBlock(item)).join('\n\n');
}

/**
 * Flattens the structured conversation into the simple text history the
 * providers consume, encoding tool calls and tool results inline with the
 * sentinel protocol so the model sees a consistent transcript.
 */
export function formatHistoryForBridge(
  history: ConversationMessage[],
): ProviderChatHistoryMessage[] {
  const result: ProviderChatHistoryMessage[] = [];

  for (const message of history) {
    if (message.role === 'user') {
      if (message.content.length > 0) {
        result.push({ role: 'user', content: message.content });
      }

      continue;
    }

    if (message.role === 'assistant') {
      const sections: string[] = [];

      if (message.content.length > 0) {
        sections.push(message.content);
      }

      for (const toolCall of message.toolCalls ?? []) {
        sections.push(formatToolCallBlock(toolCall));
      }

      if (sections.length > 0) {
        result.push({ role: 'assistant', content: sections.join('\n\n') });
      }

      continue;
    }

    // Tool results have no assistant/user role in the providers' transcript
    // model, so surface them as a user turn carrying the sentinel block.
    result.push({
      role: 'user',
      content: formatToolResultBlock(message),
    });
  }

  return result;
}

function formatToolCallBlock(toolCall: {
  id: string;
  function: { name: string; arguments: string };
}): string {
  let parsedArguments: unknown = {};

  if (toolCall.function.arguments.trim().length > 0) {
    try {
      parsedArguments = JSON.parse(toolCall.function.arguments);
    } catch {
      parsedArguments = toolCall.function.arguments;
    }
  }

  const body = JSON.stringify({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parsedArguments,
  });

  return `${TOOL_CALL_OPEN}\n${body}\n${TOOL_CALL_CLOSE}`;
}

function formatToolResultBlock(item: {
  toolCallId: string;
  content: string;
}): string {
  return [
    `${TOOL_RESULT_OPEN_PREFIX}${JSON.stringify(item.toolCallId)}${TOOL_RESULT_OPEN_SUFFIX}`,
    item.content,
    TOOL_RESULT_CLOSE,
  ].join('\n');
}

export type ToolBridgeParserEvent =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_call';
      index: number;
      id: string;
      name: string;
      arguments: string;
    };

export interface ToolCallStreamParser {
  push(chunk: string): ToolBridgeParserEvent[];
  flush(): ToolBridgeParserEvent[];
}

/**
 * Creates a stateful parser that consumes streamed model text and emits text
 * deltas plus fully-formed tool calls. It buffers across chunk boundaries so a
 * sentinel split between two chunks is still recognized, and it falls back to
 * passing text through verbatim when no marker is in progress.
 */
export function createToolCallStreamParser(): ToolCallStreamParser {
  let buffer = '';
  let inCall = false;
  let callBuffer = '';
  let nextIndex = 0;

  const drain = (final: boolean): ToolBridgeParserEvent[] => {
    const events: ToolBridgeParserEvent[] = [];

    for (;;) {
      if (!inCall) {
        const open = buffer.indexOf(TOOL_CALL_OPEN);

        if (open === -1) {
          const held = final ? 0 : trailingPartialMarkerLength(buffer);
          const text = buffer.slice(0, buffer.length - held);

          if (text.length > 0) {
            events.push({ kind: 'text', text });
          }

          buffer = buffer.slice(buffer.length - held);
          break;
        }

        const text = buffer.slice(0, open);

        if (text.length > 0) {
          events.push({ kind: 'text', text });
        }

        buffer = buffer.slice(open + TOOL_CALL_OPEN.length);
        inCall = true;
        callBuffer = '';
        continue;
      }

      const close = buffer.indexOf(TOOL_CALL_CLOSE);

      if (close === -1) {
        const held = final ? 0 : trailingPartialMarkerLength(buffer);

        callBuffer += buffer.slice(0, buffer.length - held);
        buffer = buffer.slice(buffer.length - held);
        break;
      }

      callBuffer += buffer.slice(0, close);
      buffer = buffer.slice(close + TOOL_CALL_CLOSE.length);
      inCall = false;

      const event = parseToolCallBody(callBuffer, nextIndex);

      if (event) {
        nextIndex += 1;
        events.push(event);
      } else if (callBuffer.length > 0) {
        // Malformed block — surface the original text so nothing is lost.
        events.push({
          kind: 'text',
          text: `${TOOL_CALL_OPEN}${callBuffer}${TOOL_CALL_CLOSE}`,
        });
      }

      callBuffer = '';
    }

    return events;
  };

  return {
    push(chunk: string): ToolBridgeParserEvent[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): ToolBridgeParserEvent[] {
      const events = drain(true);

      if (inCall) {
        // An unterminated tool-call block: try to recover it as a call, else
        // emit the raw text.
        const event = parseToolCallBody(callBuffer, nextIndex);

        if (event) {
          nextIndex += 1;
          events.push(event);
        } else if (callBuffer.length > 0) {
          events.push({
            kind: 'text',
            text: `${TOOL_CALL_OPEN}${callBuffer}`,
          });
        }

        inCall = false;
        callBuffer = '';
      }

      return events;
    },
  };
}

function parseToolCallBody(
  body: string,
  index: number,
): ToolBridgeParserEvent | null {
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
  };

  if (typeof record.name !== 'string' || record.name.length === 0) {
    return null;
  }

  const id =
    typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : `call_${randomUUID().replaceAll('-', '')}`;
  const argumentsString =
    typeof record.arguments === 'string'
      ? record.arguments
      : JSON.stringify(record.arguments ?? {});

  return {
    kind: 'tool_call',
    index,
    id,
    name: record.name,
    arguments: argumentsString,
  };
}

/**
 * Returns the length of the longest suffix of `buffer` that is a proper prefix
 * of either sentinel open/close marker, so a marker split across chunks is held
 * back rather than leaked as text.
 */
function trailingPartialMarkerLength(buffer: string): number {
  return Math.max(
    partialMarkerLength(buffer, TOOL_CALL_OPEN),
    partialMarkerLength(buffer, TOOL_CALL_CLOSE),
  );
}

function partialMarkerLength(buffer: string, marker: string): number {
  const max = Math.min(buffer.length, marker.length - 1);

  for (let length = max; length > 0; length--) {
    if (buffer.endsWith(marker.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

/**
 * State carried across calls to {@link convertBridgeParserEvents} for a single
 * streamed response.
 */
export interface BridgeConversionState {
  /** Whether at least one tool call has been emitted so far. */
  sawToolCall: boolean;
  /** Whether any provider event (text or tool call) has been emitted. */
  emitted: boolean;
  /**
   * Set when the model produced non-whitespace text *after* a tool call — the
   * hallucination/run-ahead signal. The provider should stop reading and kill
   * the agent process, mirroring how native function-calling halts generation
   * at the tool-call boundary.
   */
  stopRequested: boolean;
}

export function createBridgeConversionState(): BridgeConversionState {
  return { sawToolCall: false, emitted: false, stopRequested: false };
}

/**
 * Converts sentinel parser events into provider stream events.
 *
 * Text before the first tool call is forwarded as output text (a model preamble
 * is harmless). Once a tool call has been seen, any further non-whitespace text
 * sets `stopRequested` so the caller can terminate generation — the agent has no
 * enforced stop after a tool call, so without this it tends to fabricate the
 * tool's result and the next steps inline.
 */
export function* convertBridgeParserEvents(
  events: ToolBridgeParserEvent[],
  state: BridgeConversionState,
): Generator<ProviderChatCompletionEvent> {
  for (const event of events) {
    if (state.stopRequested) {
      return;
    }

    if (event.kind === 'tool_call') {
      state.sawToolCall = true;
      state.emitted = true;
      yield {
        type: 'response.output_tool_call.delta',
        toolCallIndex: event.index,
        toolCallId: event.id,
        toolName: event.name,
        toolArguments: '',
      };
      yield {
        type: 'response.output_tool_call.delta',
        toolCallIndex: event.index,
        toolArguments: event.arguments,
      };
      continue;
    }

    if (!state.sawToolCall) {
      if (event.text.length > 0) {
        state.emitted = true;
        yield {
          type: 'response.output_text.delta',
          text: event.text,
        };
      }

      continue;
    }

    if (event.text.trim().length > 0) {
      state.stopRequested = true;
      return;
    }
  }
}
