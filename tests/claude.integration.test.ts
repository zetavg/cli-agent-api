import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { collectChatCompletion } from '../src/apis/chat-completions.js';
import { FileSystemKvStore } from '../src/file-system-kv-store.js';
import {
  CLAUDE_SESSION_MAPPING_STORE_ID,
  CLAUDE_SESSION_MAPPING_STORE_VERSION,
  ClaudeProvider,
  createClaudeSessionHistoryHash,
} from '../src/index.js';
import type {
  ProviderChatCompletionInput,
  ProviderChatHistoryMessage,
} from '../src/providers.js';

const runClaudeIntegrationTests = process.env.CLAUDE_INTEGRATION_TESTS === '1';
const describeClaudeIntegration = runClaudeIntegrationTests
  ? describe.sequential
  : describe.skip;
const TEST_MODEL = 'haiku';

describeClaudeIntegration('Claude provider integration', () => {
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

      const oldResponse = await runClaudeProviderCompletion({
        history: oldHistory,
        prompt,
      });
      const oldSessionId = await getMappedSessionId(
        extendHistory(oldHistory, prompt, oldResponse),
      );

      expect(oldResponse).toBe(oldMarker);
      expect(oldSessionId).toBeDefined();

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

      const newResponse = await runClaudeProviderCompletion({
        history: newHistory,
        prompt,
      });
      const newSessionId = await getMappedSessionId(
        extendHistory(newHistory, prompt, newResponse),
      );

      expect(newResponse).toBe(newMarker);
      expect(newResponse).not.toBe(oldMarker);
      expect(newSessionId).toBeDefined();
      expect(newSessionId).not.toBe(oldSessionId);
    });
  }, 120_000);

  test('reflects edits to old user messages in the resumed history', async () => {
    await withIntegrationDataDir(async () => {
      const prompt =
        'What animal did I say was my favorite? Reply with only the animal.';
      const originalHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'My favorite animal is FALCON.',
        },
        {
          role: 'assistant',
          content: 'Understood.',
        },
      ];
      const originalResponse = await runClaudeProviderCompletion({
        history: originalHistory,
        prompt,
      });
      const originalSessionId = await getMappedSessionId(
        extendHistory(originalHistory, prompt, originalResponse),
      );

      const editedHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'My favorite animal is OTTER.',
        },
        {
          role: 'assistant',
          content: 'Understood.',
        },
      ];
      const editedResponse = await runClaudeProviderCompletion({
        history: editedHistory,
        prompt,
      });
      const editedSessionId = await getMappedSessionId(
        extendHistory(editedHistory, prompt, editedResponse),
      );

      expect(originalResponse).toBe('FALCON');
      expect(editedResponse).toBe('OTTER');
      expect(originalSessionId).toBeDefined();
      expect(editedSessionId).toBeDefined();
      expect(editedSessionId).not.toBe(originalSessionId);
    });
  }, 120_000);

  test('reflects edits to old assistant messages in the resumed history', async () => {
    await withIntegrationDataDir(async () => {
      const prompt = 'What safe word did you say? Reply with only the word.';
      const originalHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'Pick a safe word and remember it.',
        },
        {
          role: 'assistant',
          content: 'The safe word is ALBATROSS.',
        },
      ];
      const originalResponse = await runClaudeProviderCompletion({
        history: originalHistory,
        prompt,
      });
      const originalSessionId = await getMappedSessionId(
        extendHistory(originalHistory, prompt, originalResponse),
      );

      const editedHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'Pick a safe word and remember it.',
        },
        {
          role: 'assistant',
          content: 'The safe word is COBALT.',
        },
      ];
      const editedResponse = await runClaudeProviderCompletion({
        history: editedHistory,
        prompt,
      });
      const editedSessionId = await getMappedSessionId(
        extendHistory(editedHistory, prompt, editedResponse),
      );

      expect(originalResponse).toBe('ALBATROSS');
      expect(editedResponse).toBe('COBALT');
      expect(originalSessionId).toBeDefined();
      expect(editedSessionId).toBeDefined();
      expect(editedSessionId).not.toBe(originalSessionId);
    });
  }, 120_000);

  test('reuses the same Claude session when extending unchanged history', async () => {
    await withIntegrationDataDir(async () => {
      const initialHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'Remember the project codename AZURE.',
        },
        {
          role: 'assistant',
          content: 'I will remember AZURE.',
        },
      ];
      const firstPrompt =
        'What project codename did I ask you to remember? Reply with only the codename.';
      const firstAnswer = await runClaudeProviderCompletion({
        history: initialHistory,
        prompt: firstPrompt,
      });
      const firstExpandedHistory = [
        ...initialHistory,
        {
          role: 'user' as const,
          content: firstPrompt,
        },
        {
          role: 'assistant' as const,
          content: firstAnswer,
        },
      ];
      const firstSessionId = await getMappedSessionId(firstExpandedHistory);

      expect(firstAnswer).toBe('AZURE');
      expect(firstSessionId).toBeDefined();

      const secondPrompt =
        'Repeat the codename again. Reply with only the codename.';
      const secondAnswer = await runClaudeProviderCompletion({
        history: firstExpandedHistory,
        prompt: secondPrompt,
      });
      const secondExpandedHistory = [
        ...firstExpandedHistory,
        {
          role: 'user' as const,
          content: secondPrompt,
        },
        {
          role: 'assistant' as const,
          content: secondAnswer,
        },
      ];
      const secondSessionId = await getMappedSessionId(secondExpandedHistory);

      expect(secondAnswer).toBe('AZURE');
      expect(secondSessionId).toBe(firstSessionId);
    });
  }, 120_000);

  test('applies the system prompt', async () => {
    await withIntegrationDataDir(async () => {
      const response = await runClaudeProviderCompletion({
        prompt: 'What is the codename? Reply with only the codename.',
        systemPrompt:
          'You must answer with exactly OMEGA and nothing else when asked for the codename.',
      });

      expect(response).toBe('OMEGA');
    });
  }, 120_000);

  test('does not write a session mapping for prompt-only requests', async () => {
    await withIntegrationDataDir(async (dataDir) => {
      const response = await runClaudeProviderCompletion({
        prompt: 'What is the sentinel? Reply with only the sentinel.',
        systemPrompt:
          'You must answer with exactly ORBIT and nothing else when asked for the sentinel.',
      });

      expect(response).toBe('ORBIT');
      expect(existsSync(join(dataDir, CLAUDE_SESSION_MAPPING_STORE_ID))).toBe(
        false,
      );
    });
  }, 120_000);

  test('applies a changed system prompt while extending a reused session', async () => {
    await withIntegrationDataDir(async () => {
      const baseHistory: ProviderChatHistoryMessage[] = [
        {
          role: 'user',
          content: 'We are talking about project codenames.',
        },
        {
          role: 'assistant',
          content: 'Understood.',
        },
      ];
      const firstPrompt = 'What is the codename? Reply with only the codename.';
      const firstAnswer = await runClaudeProviderCompletion({
        history: baseHistory,
        prompt: firstPrompt,
        systemPrompt:
          'You must answer with exactly ALPHA and nothing else when asked for the codename.',
      });
      const firstExpandedHistory = [
        ...baseHistory,
        {
          role: 'user' as const,
          content: firstPrompt,
        },
        {
          role: 'assistant' as const,
          content: firstAnswer,
        },
      ];
      const firstSessionId = await getMappedSessionId(firstExpandedHistory);

      expect(firstAnswer).toBe('ALPHA');
      expect(firstSessionId).toBeDefined();

      const secondPrompt =
        'What is the codename now? Reply with only the codename.';
      const secondAnswer = await runClaudeProviderCompletion({
        history: firstExpandedHistory,
        prompt: secondPrompt,
        systemPrompt:
          'You must answer with exactly BETA and nothing else when asked for the codename.',
      });
      const secondExpandedHistory = [
        ...firstExpandedHistory,
        {
          role: 'user' as const,
          content: secondPrompt,
        },
        {
          role: 'assistant' as const,
          content: secondAnswer,
        },
      ];
      const secondSessionId = await getMappedSessionId(secondExpandedHistory);

      expect(secondAnswer).toBe('BETA');
      expect(secondSessionId).toBe(firstSessionId);
    });
  }, 120_000);
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

async function runClaudeProviderCompletion(
  input: Omit<ProviderChatCompletionInput, 'model'>,
): Promise<string> {
  const provider = new ClaudeProvider();
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
    CLAUDE_SESSION_MAPPING_STORE_ID,
    CLAUDE_SESSION_MAPPING_STORE_VERSION,
  );

  return (await store.get(createClaudeSessionHistoryHash(history)))?.trim();
}

function extendHistory(
  history: ProviderChatHistoryMessage[],
  prompt: string,
  answer: string,
): ProviderChatHistoryMessage[] {
  return [
    ...history,
    {
      role: 'user',
      content: prompt,
    },
    {
      role: 'assistant',
      content: answer,
    },
  ];
}
