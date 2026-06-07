import { describe, expect, test } from 'vitest';

import {
  prepareChatCompletion,
  serializeChatCompletionStream,
} from '../src/apis/chat-completions.js';
import type {
  ChatCompletionsRequestBody,
  ProviderChatCompletionEvent,
} from '../src/openai.js';
import type {
  AgentProvider,
  ProviderChatCompletionInput,
  ProviderChatCompletionRun,
} from '../src/providers.js';
import { TOOL_CALL_OPEN } from '../src/tool-bridge.js';

/**
 * A provider stub that records the input it received and replays a scripted
 * sequence of provider events — standing in for a CLI provider that has already
 * parsed the prompted bridge protocol into structured tool-call deltas.
 */
class ScriptedProvider implements AgentProvider {
  readonly name = 'claude';
  lastInput?: ProviderChatCompletionInput;

  constructor(private readonly events: ProviderChatCompletionEvent[]) {}

  createChatCompletion(
    input: ProviderChatCompletionInput,
  ): ProviderChatCompletionRun {
    this.lastInput = input;
    const events = this.events;

    return {
      metadata: { id: 'chatcmpl_test', model: 'claude-test', created: 1 },
      events: (async function* () {
        yield { type: 'response.metadata', model: 'claude-test' };

        for (const event of events) {
          yield event;
        }
      })(),
    };
  }
}

const toolDefinition = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: {} },
  },
};

/** The provider events a real bridge provider emits for one tool-call turn. */
function toolCallTurn(preamble?: string): ProviderChatCompletionEvent[] {
  const events: ProviderChatCompletionEvent[] = [];

  if (preamble) {
    events.push({ type: 'response.output_text.delta', text: preamble });
  }

  events.push(
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
      toolArguments: '{"path":"README.md"}',
    },
    {
      type: 'response.completed',
      finishReason: 'tool_calls',
      usage: undefined,
    },
  );

  return events;
}

describe('bridge mode', () => {
  test('exposes client tools to the provider and disables native tools', async () => {
    const provider = new ScriptedProvider([
      { type: 'response.completed', finishReason: 'stop', usage: undefined },
    ]);

    await prepareChatCompletion(
      provider,
      {
        model: 'sonnet',
        tools: [toolDefinition],
        messages: [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'user', content: 'Read the README.' },
        ],
      } as ChatCompletionsRequestBody,
      new AbortController().signal,
      { toolMode: 'bridge' },
    );

    expect(provider.lastInput?.toolMode).toBe('bridge');
    expect(provider.lastInput?.tools).toEqual([toolDefinition]);
    expect(provider.lastInput?.prompt).toBe('Read the README.');
  });

  test('ignores client tools in native mode', async () => {
    const provider = new ScriptedProvider([
      { type: 'response.completed', finishReason: 'stop', usage: undefined },
    ]);

    await prepareChatCompletion(
      provider,
      {
        model: 'sonnet',
        tools: [toolDefinition],
        messages: [{ role: 'user', content: 'Read the README.' }],
      } as ChatCompletionsRequestBody,
      new AbortController().signal,
      { toolMode: 'native' },
    );

    expect(provider.lastInput?.toolMode).toBeUndefined();
    expect(provider.lastInput?.tools).toBeUndefined();
  });

  test('assembles tool_calls into a non-streaming response', async () => {
    const provider = new ScriptedProvider(toolCallTurn('Let me read it. '));

    const result = await prepareChatCompletion(
      provider,
      {
        tools: [toolDefinition],
        messages: [{ role: 'user', content: 'Read the README.' }],
      } as ChatCompletionsRequestBody,
      new AbortController().signal,
      { toolMode: 'bridge' },
    );

    if (result.type !== 'json') {
      throw new Error('Expected a JSON result.');
    }

    const choice = result.body.choices[0];

    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('Let me read it. ');
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
    ]);
  });

  test('streams tool_calls deltas and finishes with tool_calls', async () => {
    const provider = new ScriptedProvider(toolCallTurn());

    const result = await prepareChatCompletion(
      provider,
      {
        stream: true,
        tools: [toolDefinition],
        messages: [{ role: 'user', content: 'Read the README.' }],
      } as ChatCompletionsRequestBody,
      new AbortController().signal,
      { toolMode: 'bridge' },
    );

    if (result.type !== 'stream') {
      throw new Error('Expected a stream result.');
    }

    const chunks: string[] = [];

    for await (const chunk of serializeChatCompletionStream(result.run)) {
      chunks.push(chunk);
    }

    const text = chunks.join('');

    expect(text).toContain(
      '"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]',
    );
    expect(text).toContain(
      '"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]',
    );
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('forwards tool results from a follow-up request as a sentinel prompt', async () => {
    const provider = new ScriptedProvider([
      { type: 'response.output_text.delta', text: 'All done.' },
      { type: 'response.completed', finishReason: 'stop', usage: undefined },
    ]);

    await prepareChatCompletion(
      provider,
      {
        tools: [toolDefinition],
        messages: [
          { role: 'user', content: 'Read the README.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '# Title' },
        ],
      } as ChatCompletionsRequestBody,
      new AbortController().signal,
      { toolMode: 'bridge' },
    );

    expect(provider.lastInput?.prompt).toContain(
      '<<<TOOL_RESULT id="call_1">>>',
    );
    expect(provider.lastInput?.prompt).toContain('# Title');
    // The prior assistant tool call is preserved in the bridged history.
    expect(
      provider.lastInput?.history?.some((message) =>
        message.content.includes(TOOL_CALL_OPEN),
      ),
    ).toBe(true);
  });
});
