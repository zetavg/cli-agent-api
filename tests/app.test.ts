import { describe, expect, test } from 'vitest';

import {
  prepareChatCompletion,
  serializeChatCompletionStream,
} from '../src/apis/chat-completions.js';
import type {
  AgentProvider,
  ProviderChatCompletionInput,
  ProviderChatCompletionRun,
} from '../src/providers.js';
import { authorizeRequest, getCorsHeaders } from '../src/server.js';

class StubProvider implements AgentProvider {
  readonly name = 'claude';

  createChatCompletion(
    input: ProviderChatCompletionInput,
    _signal: AbortSignal,
  ): ProviderChatCompletionRun {
    return {
      metadata: {
        id: 'chatcmpl_test',
        model: input.model ?? 'claude-code',
        created: 123,
      },
      events: (async function* () {
        yield {
          type: 'response.metadata' as const,
          model: 'claude-sonnet-4-6',
        };
        yield {
          type: 'response.output_reasoning.delta' as const,
          reasoningId: 'reasoning-0',
          reasoningIndex: 0,
          reasoningText: 'Thinking... ',
          format: 'anthropic-claude-v1',
        };
        yield {
          type: 'response.output_reasoning.delta' as const,
          reasoningId: 'reasoning-0',
          reasoningIndex: 0,
          reasoningText: 'about search.',
          signature: 'sig_123',
          format: 'anthropic-claude-v1',
        };
        yield {
          type: 'response.output_tool_call.delta' as const,
          toolCallIndex: 0,
          toolCallId: 'toolu_test',
          toolName: 'WebSearch',
          toolArguments: '',
        };
        yield {
          type: 'response.output_tool_call.delta' as const,
          toolCallIndex: 0,
          toolArguments: '{"query":"Hello there!"}',
        };
        yield {
          type: 'response.output_tool_result.delta' as const,
          toolCallIndex: 0,
          toolCallId: 'toolu_test',
          toolOutput: 'search results here',
        };
        yield {
          type: 'response.output_text.delta' as const,
          text: `echo:${input.prompt}`,
        };
        yield {
          type: 'response.completed' as const,
          finishReason: 'stop' as const,
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
            prompt_tokens_details: {
              cached_tokens: 0,
              audio_tokens: 0,
            },
            completion_tokens_details: {
              reasoning_tokens: 0,
              audio_tokens: 0,
              accepted_prediction_tokens: 0,
              rejected_prediction_tokens: 0,
            },
            total_cost_usd: 0.42,
          },
        };
      })(),
    };
  }
}

describe('chat completions flow', () => {
  test('uses only the last message as the prompt', async () => {
    const result = await prepareChatCompletion(
      new StubProvider(),
      {
        model: 'sonnet',
        messages: [
          {
            role: 'developer',
            content: [{ type: 'text', text: 'ignore this' }],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello there!' }],
          },
        ],
      },
      new AbortController().signal,
    );

    expect(result.type).toBe('json');

    if (result.type !== 'json') {
      throw new Error('Expected JSON result.');
    }

    expect(result.body.choices[0].message.content).toBe('echo:Hello there!');
    expect(result.body.model).toBe('claude-sonnet-4-6');
    expect(result.body.choices[0].message.reasoning).toBe(
      'Thinking... about search.',
    );
    expect(result.body.choices[0].message.reasoning_content).toBe(
      'Thinking... about search.',
    );
    expect(result.body.choices[0].message.reasoning_details).toEqual([
      {
        type: 'reasoning.text',
        id: 'reasoning-0',
        format: 'anthropic-claude-v1',
        index: 0,
        text: 'Thinking... about search.',
        signature: 'sig_123',
      },
    ]);
    expect(result.body.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
      prompt_tokens_details: {
        cached_tokens: 0,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
      total_cost_usd: 0.42,
    });
  });

  test('passes system and developer messages as a system prompt', async () => {
    let capturedInput: ProviderChatCompletionInput | undefined;

    class CapturingProvider extends StubProvider {
      override createChatCompletion(
        input: ProviderChatCompletionInput,
        signal: AbortSignal,
      ): ProviderChatCompletionRun {
        capturedInput = input;
        return super.createChatCompletion(input, signal);
      }
    }

    await prepareChatCompletion(
      new CapturingProvider(),
      {
        model: 'sonnet',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'System message.' }],
          },
          {
            role: 'developer',
            content: [{ type: 'text', text: 'Developer message.' }],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello there!' }],
          },
        ],
      },
      new AbortController().signal,
    );

    expect(capturedInput).toEqual({
      model: 'sonnet',
      prompt: 'Hello there!',
      systemPrompt: 'System message.\nDeveloper message.',
    });
  });

  test('streams server-sent events', async () => {
    const result = await prepareChatCompletion(
      new StubProvider(),
      {
        stream: true,
        messages: [{ role: 'user', content: 'Hello there!' }],
      },
      new AbortController().signal,
    );
    const chunks: string[] = [];

    expect(result.type).toBe('stream');

    if (result.type !== 'stream') {
      throw new Error('Expected stream result.');
    }

    for await (const chunk of serializeChatCompletionStream(result.run)) {
      chunks.push(chunk);
    }

    const text = chunks.join('');
    expect(text).toContain('"model":"claude-sonnet-4-6"');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"reasoning":"Thinking... "');
    expect(text).toContain('"reasoning_content":"Thinking... "');
    expect(text).toContain(
      '"reasoning_details":[{"type":"reasoning.text","id":"reasoning-0","format":"anthropic-claude-v1","index":0,"text":"Thinking... ","signature":null}]',
    );
    expect(text).toContain(
      '"tool_calls":[{"index":0,"id":"toolu_test","type":"function","function":{"name":"WebSearch","arguments":""}}]',
    );
    expect(text).toContain(
      '"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"Hello there!\\"}"}}]',
    );
    expect(text).toContain(
      '"tool_calls":[{"index":0,"id":"toolu_test","result":"search results here"}]',
    );
    expect(text).toContain('"content":"echo:Hello there!"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"choices":[]');
    expect(text).toContain(
      '"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5',
    );
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('authorization', () => {
  test('accepts valid bearer tokens', () => {
    expect(() =>
      authorizeRequest('Bearer beta', new Set(['alpha', 'beta'])),
    ).not.toThrow();
  });

  test('rejects missing bearer tokens when auth is enabled', () => {
    expect(() => authorizeRequest(undefined, new Set(['alpha']))).toThrowError(
      'Missing bearer token.',
    );
  });
});

describe('cors', () => {
  test('returns permissive cors headers', () => {
    expect(getCorsHeaders()).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
  });
});
