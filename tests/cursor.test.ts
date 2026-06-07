import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { FileSystemKvStore } from '../src/file-system-kv-store.js';
import {
  buildCursorArgs,
  CURSOR_REASONING_FORMAT,
  CURSOR_SESSION_MAPPING_STORE_ID,
  CURSOR_SESSION_MAPPING_STORE_VERSION,
  createCursorSessionHistoryHash,
  ensureCursorWorkingDirectory,
  extractCursorToolName,
  flattenCursorHistory,
  normalizeCursorResumeHistory,
  normalizeCursorUsage,
  parseCursorLine,
  prepareCursorResumeSession,
  resolveCursorCommand,
  resolveCursorWorkingDirectory,
  transformCursorLines,
  updateCursorSessionMapping,
} from '../src/index.js';
import type { ProviderChatCompletionEvent } from '../src/openai.js';
import type { ProviderChatHistoryMessage } from '../src/providers.js';

const SESSION_ID = '5275e733-8cca-45b3-bba5-6a25e35b03db';

async function withTempDataDir<T>(
  callback: (dataDir: string) => Promise<T> | T,
): Promise<T> {
  const originalDataDir = process.env.DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

  process.env.DATA_DIR = dataDir;

  try {
    return await callback(dataDir);
  } finally {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  }
}

async function collectCursorEvents(
  lines: string[],
): Promise<Awaited<ReturnType<typeof toArray>>> {
  return toArray(transformCursorLines(lines));
}

async function toArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

function assistantDeltaLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION_ID,
    timestamp_ms: 1,
  });
}

function assistantFinalLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION_ID,
  });
}

function textDeltaValues(events: ProviderChatCompletionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.text);
}

describe('Cursor adapter helpers', () => {
  test('builds the expected cursor CLI arguments', () => {
    expect(
      buildCursorArgs(
        { model: 'gpt-5', prompt: 'Hello there!' },
        'session-123',
        'Hello there!',
        {},
      ),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--model',
      'gpt-5',
      '--resume',
      'session-123',
      'Hello there!',
    ]);
  });

  test('omits optional cursor CLI arguments when not provided', () => {
    expect(buildCursorArgs({ prompt: 'Hi' }, undefined, 'Hi', {})).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      'Hi',
    ]);
  });

  test('adds --force when CURSOR_FORCE is enabled', () => {
    expect(
      buildCursorArgs({ prompt: 'Hi' }, undefined, 'Hi', {
        CURSOR_FORCE: '1',
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--force',
      'Hi',
    ]);
  });

  test('parses stream-json lines and ignores invalid lines', () => {
    expect(
      parseCursorLine(
        '{"type":"system","subtype":"init","session_id":"abc","model":"Composer 2.5 Fast"}',
      ),
    ).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'Composer 2.5 Fast',
    });
    expect(
      parseCursorLine(
        '{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"/x"}}}}',
      ),
    ).toEqual({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_1',
      tool_call: { readToolCall: { args: { path: '/x' } } },
    });
    expect(parseCursorLine('not-json')).toBeNull();
    expect(parseCursorLine('   ')).toBeNull();
  });

  test('extracts the tool name from a tool_call object key', () => {
    expect(extractCursorToolName({ readToolCall: {} })).toBe('read');
    expect(extractCursorToolName({ shellToolCall: {} })).toBe('shell');
    expect(extractCursorToolName({ mystery: {} })).toBe('mystery');
    expect(extractCursorToolName(undefined)).toBeUndefined();
  });

  test('normalizes cursor usage into OpenAI-style token fields', () => {
    expect(
      normalizeCursorUsage(
        {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 8,
          cacheWriteTokens: 3,
        },
        { duration_ms: 1200, request_id: 'req_1' },
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 8,
      cacheWriteTokens: 3,
      duration_ms: 1200,
      request_id: 'req_1',
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 8,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    });
    expect(normalizeCursorUsage(undefined, {})).toBeUndefined();
  });

  test('normalizes assistant history by removing inline thinking tags', () => {
    expect(
      normalizeCursorResumeHistory([
        { role: 'user', content: 'What is your favorite food?' },
        {
          role: 'assistant',
          content: '<think>The user asked about food.</think>\nI do not eat.',
        },
        { role: 'assistant', content: '   ' },
      ]),
    ).toEqual([
      { role: 'user', content: 'What is your favorite food?' },
      { role: 'assistant', content: 'I do not eat.' },
    ]);
  });

  test('hashes assistant history the same with or without inline thinking tags', () => {
    expect(
      createCursorSessionHistoryHash([
        { role: 'user', content: 'I love all of them!' },
        {
          role: 'assistant',
          content: '<think>switched languages</think>\nTuna is excellent!',
        },
      ]),
    ).toBe(
      createCursorSessionHistoryHash([
        { role: 'user', content: 'I love all of them!' },
        { role: 'assistant', content: 'Tuna is excellent!' },
      ]),
    );
  });

  test('flattens conversation history into a labelled transcript', () => {
    expect(
      flattenCursorHistory([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ]),
    ).toBe('User: Hello\n\nAssistant: Hi there\n\nUser: How are you?');
  });

  test('resolves a cursor command with base args', () => {
    const resolved = resolveCursorCommand();

    expect(typeof resolved.command).toBe('string');
    expect(resolved.command.length).toBeGreaterThan(0);
    expect(Array.isArray(resolved.baseArgs)).toBe(true);

    if (resolved.command.endsWith('cursor')) {
      expect(resolved.baseArgs).toEqual(['agent']);
    } else {
      expect(resolved.baseArgs).toEqual([]);
    }
  });

  test('ensures the cursor working directory under agent-workspace exists', async () => {
    const xdgDataHome = join(
      mkdtempSync(join(tmpdir(), 'cli-agent-api-data-')),
      'xdg-data',
    );
    const workspaceDir = join(xdgDataHome, 'cli-agent-api', 'agent-workspace');
    const ensuredWorkspaceDir = await ensureCursorWorkingDirectory({
      XDG_DATA_HOME: xdgDataHome,
    });
    const resolvedWorkspaceDir = realpathSync(workspaceDir);

    expect(ensuredWorkspaceDir).toBe(resolvedWorkspaceDir);
    expect(resolveCursorWorkingDirectory({ XDG_DATA_HOME: xdgDataHome })).toBe(
      resolvedWorkspaceDir,
    );
    expect(existsSync(workspaceDir)).toBe(true);
  });
});

describe('Cursor stream-json transform', () => {
  test('emits deduped text deltas and skips the consolidated block copy', async () => {
    const events = await collectCursorEvents([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
        model: 'Composer 2.5 Fast',
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        session_id: SESSION_ID,
      }),
      assistantDeltaLine('alpha'),
      assistantDeltaLine(' beta'),
      assistantDeltaLine(' gamma'),
      assistantFinalLine('alpha beta gamma'),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'alpha beta gamma',
        session_id: SESSION_ID,
        request_id: 'req_1',
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
        },
        duration_ms: 100,
      }),
    ]);

    expect(events.filter((event) => event.type === 'cursor.session')).toEqual([
      { type: 'cursor.session', sessionId: SESSION_ID },
    ]);
    expect(
      events.find((event) => event.type === 'response.metadata'),
    ).toEqual({ type: 'response.metadata', model: 'Composer 2.5 Fast' });
    expect(textDeltaValues(events as ProviderChatCompletionEvent[])).toEqual([
      'alpha',
      ' beta',
      ' gamma',
    ]);

    const resultEvent = events.find((event) => event.type === 'cursor.result');

    expect(resultEvent).toMatchObject({
      type: 'cursor.result',
      fallbackText: 'alpha beta gamma',
    });
  });

  test('handles multiple text blocks interleaved with a tool call', async () => {
    const events = await collectCursorEvents([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
        model: 'Composer 2.5 Fast',
      }),
      assistantDeltaLine("I'll"),
      assistantDeltaLine(' read'),
      assistantDeltaLine(' it.'),
      assistantFinalLine("I'll read it."),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_1',
        tool_call: { readToolCall: { args: { path: '/x' } } },
        session_id: SESSION_ID,
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool_1',
        tool_call: {
          readToolCall: { args: { path: '/x' }, result: { content: 'hi' } },
        },
        session_id: SESSION_ID,
      }),
      assistantDeltaLine('Here'),
      assistantDeltaLine(' is'),
      assistantDeltaLine(' it'),
      assistantFinalLine('Here is it'),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: "I'll read it.Here is it",
        session_id: SESSION_ID,
      }),
    ]);

    expect(
      textDeltaValues(events as ProviderChatCompletionEvent[]).join(''),
    ).toBe("I'll read it.Here is it");

    const toolCallDelta = events.find(
      (event) => event.type === 'response.output_tool_call.delta',
    );

    expect(toolCallDelta).toEqual({
      type: 'response.output_tool_call.delta',
      toolCallIndex: 0,
      toolCallId: 'tool_1',
      toolName: 'read',
      toolArguments: JSON.stringify({ path: '/x' }),
    });

    const toolResultDelta = events.find(
      (event) => event.type === 'response.output_tool_result.delta',
    );

    expect(toolResultDelta).toEqual({
      type: 'response.output_tool_result.delta',
      toolCallIndex: 0,
      toolCallId: 'tool_1',
      toolOutput: JSON.stringify({ content: 'hi' }),
    });
  });

  test('maps thinking deltas to reasoning events', async () => {
    const events = await collectCursorEvents([
      JSON.stringify({
        type: 'thinking',
        subtype: 'delta',
        text: 'Considering options',
        session_id: SESSION_ID,
      }),
      JSON.stringify({
        type: 'thinking',
        subtype: 'completed',
        session_id: SESSION_ID,
      }),
      assistantDeltaLine('done'),
      assistantFinalLine('done'),
    ]);

    expect(
      events.find((event) => event.type === 'response.output_reasoning.delta'),
    ).toEqual({
      type: 'response.output_reasoning.delta',
      reasoningId: 'reasoning-0',
      reasoningIndex: 0,
      reasoningText: 'Considering options',
      format: CURSOR_REASONING_FORMAT,
    });
    expect(textDeltaValues(events as ProviderChatCompletionEvent[])).toEqual([
      'done',
    ]);
  });

  test('throws when the result line reports an error', async () => {
    await expect(
      collectCursorEvents([
        JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'something failed',
          session_id: SESSION_ID,
        }),
      ]),
    ).rejects.toThrow('something failed');
  });
});

describe('Cursor session mapping', () => {
  test('claims a stored session mapping for matching history', async () => {
    await withTempDataDir(async () => {
      const history: ProviderChatHistoryMessage[] = [
        { role: 'user', content: 'Remember AZURE.' },
        { role: 'assistant', content: 'I will remember AZURE.' },
      ];

      await updateCursorSessionMapping(SESSION_ID, history);

      const store = new FileSystemKvStore(
        CURSOR_SESSION_MAPPING_STORE_ID,
        CURSOR_SESSION_MAPPING_STORE_VERSION,
      );

      expect(
        (await store.get(createCursorSessionHistoryHash(history)))?.trim(),
      ).toBe(SESSION_ID);

      const claimed = await prepareCursorResumeSession({ history });

      expect(claimed?.sessionId).toBe(SESSION_ID);
    });
  });

  test('claim is destructive so a second resume attempt misses', async () => {
    await withTempDataDir(async () => {
      const history: ProviderChatHistoryMessage[] = [
        { role: 'user', content: 'Remember AZURE.' },
        { role: 'assistant', content: 'I will remember AZURE.' },
      ];

      await updateCursorSessionMapping(SESSION_ID, history);

      expect((await prepareCursorResumeSession({ history }))?.sessionId).toBe(
        SESSION_ID,
      );
      expect(await prepareCursorResumeSession({ history })).toBeUndefined();
    });
  });

  test('does not resume when there is no prior history', async () => {
    await withTempDataDir(async () => {
      expect(await prepareCursorResumeSession({ history: [] })).toBeUndefined();
    });
  });

  test('ignores invalid session ids when updating the mapping', async () => {
    await withTempDataDir(async (dataDir) => {
      await updateCursorSessionMapping('not-a-uuid', [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]);

      expect(
        existsSync(join(dataDir, CURSOR_SESSION_MAPPING_STORE_ID)),
      ).toBe(false);
    });
  });
});
