import { describe, expect, test } from 'vitest';

import type { ProviderChatCompletionEvent } from '../src/openai.js';
import {
  buildToolSystemPromptSection,
  convertBridgeParserEvents,
  createBridgeConversionState,
  createToolCallStreamParser,
  formatHistoryForBridge,
  formatToolResultsForPrompt,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  type ToolBridgeParserEvent,
} from '../src/tool-bridge.js';

function runParser(chunks: string[]): ToolBridgeParserEvent[] {
  const parser = createToolCallStreamParser();
  const events: ToolBridgeParserEvent[] = [];

  for (const chunk of chunks) {
    events.push(...parser.push(chunk));
  }

  events.push(...parser.flush());

  return events;
}

function call(body: string): string {
  return `${TOOL_CALL_OPEN}\n${body}\n${TOOL_CALL_CLOSE}`;
}

describe('createToolCallStreamParser', () => {
  test('passes plain text through unchanged', () => {
    expect(runParser(['Hello ', 'world'])).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ]);
  });

  test('parses a single tool call emitted in one chunk', () => {
    const events = runParser([
      call('{"id":"call_1","name":"read_file","arguments":{"path":"a.ts"}}'),
    ]);

    expect(events).toEqual([
      {
        kind: 'tool_call',
        index: 0,
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
      },
    ]);
  });

  test('recognizes markers split across chunk boundaries', () => {
    const full = call('{"id":"call_1","name":"ping","arguments":{}}');
    const mid = Math.floor(full.length / 2);
    const events = runParser([full.slice(0, mid), full.slice(mid)]);

    expect(events).toEqual([
      {
        kind: 'tool_call',
        index: 0,
        id: 'call_1',
        name: 'ping',
        arguments: '{}',
      },
    ]);
  });

  test('handles text before and after a tool call', () => {
    const events = runParser([
      'Let me check. ',
      call('{"id":"call_1","name":"ping","arguments":{}}'),
      ' Done.',
    ]);

    expect(events).toEqual([
      { kind: 'text', text: 'Let me check. ' },
      {
        kind: 'tool_call',
        index: 0,
        id: 'call_1',
        name: 'ping',
        arguments: '{}',
      },
      { kind: 'text', text: ' Done.' },
    ]);
  });

  test('parses multiple back-to-back tool calls', () => {
    const events = runParser([
      call('{"id":"call_1","name":"a","arguments":{}}') +
        '\n' +
        call('{"id":"call_2","name":"b","arguments":{"x":1}}'),
    ]);

    const toolCalls = events.filter((event) => event.kind === 'tool_call');

    expect(toolCalls).toEqual([
      { kind: 'tool_call', index: 0, id: 'call_1', name: 'a', arguments: '{}' },
      {
        kind: 'tool_call',
        index: 1,
        id: 'call_2',
        name: 'b',
        arguments: '{"x":1}',
      },
    ]);
  });

  test('generates an id when the model omits one', () => {
    const events = runParser([call('{"name":"ping","arguments":{}}')]);

    expect(events).toHaveLength(1);
    const [event] = events;

    if (event.kind !== 'tool_call') {
      throw new Error('Expected a tool call.');
    }

    expect(event.id).toMatch(/^call_/);
    expect(event.name).toBe('ping');
  });

  test('surfaces a malformed tool-call block as text', () => {
    const events = runParser([call('not json at all')]);

    expect(events).toEqual([
      {
        kind: 'text',
        text: `${TOOL_CALL_OPEN}\nnot json at all\n${TOOL_CALL_CLOSE}`,
      },
    ]);
  });

  test('does not leak a partial opening marker as text', () => {
    const parser = createToolCallStreamParser();
    // First chunk ends with a prefix of the opening marker.
    const first = parser.push('answer <<<TOOL_C');

    expect(first).toEqual([{ kind: 'text', text: 'answer ' }]);

    const rest = parser.push('ALL>>>\n{"name":"ping","arguments":{}}\n');
    const flushed = parser.flush();
    const toolCalls = [...rest, ...flushed].filter(
      (event) => event.kind === 'tool_call',
    );

    expect(toolCalls).toHaveLength(1);
  });

  test('recovers an unterminated tool-call block on flush', () => {
    const parser = createToolCallStreamParser();
    parser.push(`${TOOL_CALL_OPEN}\n{"name":"ping","arguments":{}}`);
    const flushed = parser.flush();

    expect(flushed).toEqual([
      {
        kind: 'tool_call',
        index: 0,
        id: expect.any(String),
        name: 'ping',
        arguments: '{}',
      },
    ]);
  });
});

describe('formatToolResultsForPrompt', () => {
  test('wraps each result in sentinel markers keyed by tool call id', () => {
    const prompt = formatToolResultsForPrompt([
      { toolCallId: 'call_1', content: 'result one' },
      { toolCallId: 'call_2', content: 'result two' },
    ]);

    expect(prompt).toContain('<<<TOOL_RESULT id="call_1">>>');
    expect(prompt).toContain('result one');
    expect(prompt).toContain('<<<TOOL_RESULT id="call_2">>>');
    expect(prompt).toContain('result two');
    expect(prompt).toContain('<<<END_TOOL_RESULT>>>');
  });

  test('round-trips through the stream parser for the model to consume', () => {
    // A prior assistant tool call followed by its result, as the bridge encodes
    // history, should be parseable back into the same call.
    const history = formatHistoryForBridge([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'contents' },
    ]);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      role: 'assistant',
      content: call(
        '{"id":"call_1","name":"read_file","arguments":{"path":"a"}}',
      ),
    });
    expect(history[1].role).toBe('user');
    expect(history[1].content).toContain('<<<TOOL_RESULT id="call_1">>>');
  });
});

describe('buildToolSystemPromptSection', () => {
  test('lists tools and the call format for claude', () => {
    const section = buildToolSystemPromptSection(
      [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      'claude',
    );

    expect(section).toContain('read_file');
    expect(section).toContain('Read a file');
    expect(section).toContain(TOOL_CALL_OPEN);
    expect(section).toContain(TOOL_CALL_CLOSE);
  });

  test('adds a stronger override for cursor', () => {
    const section = buildToolSystemPromptSection(
      [{ type: 'function', function: { name: 'read_file' } }],
      'cursor',
    );

    expect(section.toLowerCase()).toContain('ignore');
    expect(section).toContain('read_file');
  });

  test('instructs the model not to fabricate tool results', () => {
    const section = buildToolSystemPromptSection(
      [{ type: 'function', function: { name: 'read_file' } }],
      'claude',
    );

    expect(section.toLowerCase()).toContain('never write tool results');
    expect(section.toLowerCase()).toContain('stop');
  });
});

describe('convertBridgeParserEvents', () => {
  function convert(
    events: ToolBridgeParserEvent[],
    state = createBridgeConversionState(),
  ): { events: ProviderChatCompletionEvent[]; state: typeof state } {
    return { events: [...convertBridgeParserEvents(events, state)], state };
  }

  test('forwards preamble text before any tool call', () => {
    const { events, state } = convert([
      { kind: 'text', text: 'Let me check. ' },
    ]);

    expect(events).toEqual([
      { type: 'response.output_text.delta', text: 'Let me check. ' },
    ]);
    expect(state.sawToolCall).toBe(false);
    expect(state.stopRequested).toBe(false);
  });

  test('emits a tool call as two tool_call deltas', () => {
    const { events, state } = convert([
      {
        kind: 'tool_call',
        index: 0,
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a"}',
      },
    ]);

    expect(events).toEqual([
      {
        type: 'response.output_tool_call.delta',
        toolCallIndex: 0,
        toolCallId: 'call_1',
        toolName: 'read_file',
        toolArguments: '',
      },
      {
        type: 'response.output_tool_call.delta',
        toolCallIndex: 0,
        toolArguments: '{"path":"a"}',
      },
    ]);
    expect(state.sawToolCall).toBe(true);
  });

  test('ignores whitespace between batched tool calls without stopping', () => {
    const state = createBridgeConversionState();
    state.sawToolCall = true;

    const { events } = convert([{ kind: 'text', text: '\n\n' }], state);

    expect(events).toEqual([]);
    expect(state.stopRequested).toBe(false);
  });

  test('requests a stop on non-whitespace text after a tool call', () => {
    const state = createBridgeConversionState();
    state.sawToolCall = true;

    const { events } = convert(
      [{ kind: 'text', text: 'Now I will pretend the tool returned…' }],
      state,
    );

    // Run-ahead text is dropped, and the caller is told to stop generation.
    expect(events).toEqual([]);
    expect(state.stopRequested).toBe(true);
  });

  test('stops at the boundary between a tool call and fabricated output', () => {
    const state = createBridgeConversionState();

    const { events } = convert(
      [
        {
          kind: 'tool_call',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          arguments: '{}',
        },
        { kind: 'text', text: 'The weather is sunny (made up).' },
      ],
      state,
    );

    // The tool call is emitted; the fabricated continuation is not.
    expect(events).toEqual([
      {
        type: 'response.output_tool_call.delta',
        toolCallIndex: 0,
        toolCallId: 'call_1',
        toolName: 'get_weather',
        toolArguments: '',
      },
      {
        type: 'response.output_tool_call.delta',
        toolCallIndex: 0,
        toolArguments: '{}',
      },
    ]);
    expect(state.stopRequested).toBe(true);
  });
});
