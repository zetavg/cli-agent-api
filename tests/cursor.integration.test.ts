import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { collectChatCompletion } from '../src/apis/chat-completions.js';
import { FileSystemKvStore } from '../src/file-system-kv-store.js';
import {
  CURSOR_SESSION_MAPPING_STORE_ID,
  CURSOR_SESSION_MAPPING_STORE_VERSION,
  CursorProvider,
  createCursorSessionHistoryHash,
} from '../src/index.js';
import type {
  ProviderChatCompletionInput,
  ProviderChatHistoryMessage,
} from '../src/providers.js';

const runCursorIntegrationTests = process.env.CURSOR_INTEGRATION_TESTS === '1';
const describeCursorIntegration = runCursorIntegrationTests
  ? describe.sequential
  : describe.skip;
const TEST_MODEL = process.env.CURSOR_INTEGRATION_MODEL ?? 'composer-2.5-fast';

describeCursorIntegration('Cursor provider integration', () => {
  test('does not leak unrelated old conversation history into a fresh history', async () => {
    await withIntegrationDataDir(async () => {
      const oldMarker = 'MARKER-OLD-FALCON';
      const newMarker = 'MARKER-NEW-OTTER';
      const prompt =
        'What marker did I ask you to remember? Reply with only the marker.';
      const oldHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: `Remember this exact marker: ${oldMarker}`,
        },
        {
          role: 'assistant',
          content: `I will remember ${oldMarker}.`,
        },
      ];

      const oldResponse = await runCursorProviderCompletion({
        history: oldHistory,
        prompt,
      });

      expect(oldResponse).toContain(oldMarker);

      const newHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: `Remember this exact marker: ${newMarker}`,
        },
        {
          role: 'assistant',
          content: `I will remember ${newMarker}.`,
        },
      ];

      const newResponse = await runCursorProviderCompletion({
        history: newHistory,
        prompt,
      });

      expect(newResponse).toContain(newMarker);
      expect(newResponse).not.toContain(oldMarker);
    });
  }, 180_000);

  test('reuses the same Cursor session when extending unchanged history', async () => {
    await withIntegrationDataDir(async () => {
      const firstPrompt =
        'Remember the project codename AZURE, then reply with only the codename.';
      const firstAnswer = await runCursorProviderCompletion({
        prompt: firstPrompt,
      });
      const firstHistory: ProviderChatHistoryMessage[] = [
        { role: 'user', content: firstPrompt },
        { role: 'assistant', content: firstAnswer },
      ];
      const firstSessionId = await getMappedSessionId(firstHistory);

      expect(firstAnswer).toContain('AZURE');
      expect(firstSessionId).toBeDefined();

      const secondPrompt =
        'What project codename did I ask you to remember? Reply with only the codename.';
      const secondAnswer = await runCursorProviderCompletion({
        history: firstHistory,
        prompt: secondPrompt,
      });
      const secondSessionId = await getMappedSessionId([
        ...firstHistory,
        { role: 'user', content: secondPrompt },
        { role: 'assistant', content: secondAnswer },
      ]);

      expect(secondAnswer).toContain('AZURE');
      expect(secondSessionId).toBe(firstSessionId);
    });
  }, 180_000);

  test('applies the system prompt', async () => {
    await withIntegrationDataDir(async () => {
      const response = await runCursorProviderCompletion({
        prompt: 'What is the codename? Reply with only the codename.',
        systemPrompt:
          'You must answer with exactly OMEGA and nothing else when asked for the codename.',
      });

      expect(response).toContain('OMEGA');
    });
  }, 180_000);
});

async function withIntegrationDataDir<T>(
  callback: (dataDir: string) => Promise<T>,
): Promise<T> {
  const originalDataDir = process.env.DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-integration-'));

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

async function runCursorProviderCompletion(
  input: Omit<ProviderChatCompletionInput, 'model'>,
): Promise<string> {
  const provider = new CursorProvider();
  const result = await collectChatCompletion(
    provider.createChatCompletion(
      {
        ...input,
        model: TEST_MODEL,
      },
      new AbortController().signal,
    ),
  );

  return result.choices[0].message.content.trim();
}

async function getMappedSessionId(
  history: ProviderChatHistoryMessage[],
): Promise<string | undefined> {
  const store = new FileSystemKvStore(
    CURSOR_SESSION_MAPPING_STORE_ID,
    CURSOR_SESSION_MAPPING_STORE_VERSION,
  );

  return (await store.get(createCursorSessionHistoryHash(history)))?.trim();
}
