import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type ChatCompletionMessage,
  extractConversationHistory,
  extractLatestTurn,
  toNativeProviderHistory,
} from '../src/messages.js';

function loadExampleRequest(name: string): {
  messages: ChatCompletionMessage[];
} {
  const path = join(import.meta.dirname, '..', 'examples', name);

  return JSON.parse(readFileSync(path, 'utf8')) as {
    messages: ChatCompletionMessage[];
  };
}

describe('extractLatestTurn', () => {
  test('returns the last user message text', () => {
    expect(
      extractLatestTurn([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Hello there!' },
      ]),
    ).toEqual({ kind: 'user', text: 'Hello there!' });
  });

  test('treats trailing tool messages as tool results', () => {
    expect(
      extractLatestTurn([
        { role: 'user', content: 'Do work' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'list_dir', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'file contents' },
        { role: 'tool', tool_call_id: 'call_b', content: 'dir listing' },
      ]),
    ).toEqual({
      kind: 'tool_results',
      items: [
        { toolCallId: 'call_a', content: 'file contents' },
        { toolCallId: 'call_b', content: 'dir listing' },
      ],
    });
  });

  test('throws when the last message is an assistant message', () => {
    expect(() =>
      extractLatestTurn([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]),
    ).toThrowError('The last message must be a user or tool message.');
  });

  test('throws on an empty message list', () => {
    expect(() => extractLatestTurn([])).toThrowError(
      '`messages` must contain at least one message.',
    );
  });

  test('does not treat a trailing tool result as a fresh user prompt (example 3)', () => {
    const { messages } = loadExampleRequest(
      'chat-completion-api-3-request.json',
    );
    const latestTurn = extractLatestTurn(messages);

    expect(latestTurn.kind).toBe('tool_results');

    if (latestTurn.kind !== 'tool_results') {
      throw new Error('Expected tool_results turn.');
    }

    expect(latestTurn.items).toEqual([
      {
        toolCallId: 'call_aCCVSkODWObdb15Ffa1YW6Ku',
        content: 'Successfully wrote todo list',
      },
    ]);
  });
});

describe('extractConversationHistory', () => {
  test('keeps user and assistant text and drops system messages', () => {
    expect(
      extractConversationHistory([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'First user prompt.' },
        { role: 'assistant', content: 'First assistant reply.' },
        { role: 'user', content: 'Latest user prompt.' },
      ]),
    ).toEqual([
      { role: 'user', content: 'First user prompt.' },
      { role: 'assistant', content: 'First assistant reply.' },
    ]);
  });

  test('preserves assistant tool_calls even with empty content', () => {
    const history = extractConversationHistory([
      { role: 'user', content: 'Do work' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'contents' },
      { role: 'user', content: 'Latest' },
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Do work' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', content: 'contents' },
    ]);
  });

  test('preserves tool calls and results from a real agent transcript (example 3)', () => {
    const { messages } = loadExampleRequest(
      'chat-completion-api-3-request.json',
    );
    const history = extractConversationHistory(messages);

    // The last turn (the single trailing tool message) is excluded.
    const toolMessages = history.filter((message) => message.role === 'tool');
    const assistantToolCalls = history.filter(
      (message) => message.role === 'assistant' && 'toolCalls' in message,
    );

    expect(toolMessages.length).toBeGreaterThan(0);
    expect(assistantToolCalls.length).toBeGreaterThan(0);
    // The assistant call that produced the trailing tool result is retained.
    expect(history.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call_aCCVSkODWObdb15Ffa1YW6Ku',
          type: 'function',
          function: expect.objectContaining({ name: 'manage_todo_list' }),
        },
      ],
    });
  });
});

describe('toNativeProviderHistory', () => {
  test('flattens to text-only user/assistant messages', () => {
    expect(
      toNativeProviderHistory([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', toolCallId: 'call_a', content: 'contents' },
        { role: 'assistant', content: 'done' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});
