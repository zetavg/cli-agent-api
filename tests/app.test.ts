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
