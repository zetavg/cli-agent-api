import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { FileSystemKvStore } from '../src/file-system-kv-store.js';
import {
  buildClaudeArgs,
  claimClaudeResumeSession,
  CLAUDE_SESSION_MAPPING_STORE_ID,
  CLAUDE_SESSION_MAPPING_STORE_VERSION,
  createClaudeResumeSession,
  createClaudeSessionHistoryHash,
  DEFAULT_CLAUDE_TOOLS,
  encodeClaudeProjectPath,
  ensureClaudeWorkingDirectory,
  normalizeClaudeUsage,
  parseClaudeLine,
  parseClaudeSessionHistory,
  prepareClaudeResumeSession,
  resolveClaudeProjectsDirectory,
  resolveClaudeSessionFilePath,
  resolveClaudeWorkingDirectory,
  seedClaudeResumeSession,
  updateClaudeSessionMapping,
} from '../src/index.js';

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

describe('Claude adapter helpers', () => {
  test('builds the expected claude CLI arguments', () => {
    expect(
      buildClaudeArgs(
        {
          model: 'sonnet',
          prompt: 'Hello there!',
          systemPrompt: 'You are an AI agent.',
        },
        'session-123',
      ),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools',
      DEFAULT_CLAUDE_TOOLS.join(' '),
      '--allowedTools',
      DEFAULT_CLAUDE_TOOLS.join(' '),
      '--model',
      'sonnet',
      '--resume',
      'session-123',
      '--system-prompt',
      'You are an AI agent.',
      'Hello there!',
    ]);
  });

  test('parses stream-json lines and ignores invalid lines', () => {
    expect(
      parseClaudeLine(
        '{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}',
      ),
    ).toEqual({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}',
      ),
    ).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'Hi',
        },
      },
    });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_test","name":"WebSearch"}}}',
      ),
    ).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_test',
          name: 'WebSearch',
        },
      },
    });
    expect(
      parseClaudeLine(
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_test","type":"tool_result","content":"search results here"}]}}',
      ),
    ).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_test',
            type: 'tool_result',
            content: 'search results here',
          },
        ],
      },
    });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Thinking... "}}}',
      ),
    ).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Thinking... ',
        },
      },
    });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}}',
      ),
    ).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'signature_delta',
          signature: 'sig_123',
        },
      },
    });
    expect(parseClaudeLine('not-json')).toBeNull();
  });

  test('ensures the Claude working directory under agent-workspace exists', async () => {
    const xdgDataHome = join(
      mkdtempSync(join(tmpdir(), 'cli-agent-api-data-')),
      'xdg-data',
    );
    const workspaceDir = join(xdgDataHome, 'cli-agent-api', 'agent-workspace');
    const ensuredWorkspaceDir = await ensureClaudeWorkingDirectory({
      XDG_DATA_HOME: xdgDataHome,
    });
    const resolvedWorkspaceDir = realpathSync(workspaceDir);

    expect(ensuredWorkspaceDir).toBe(resolvedWorkspaceDir);
    expect(resolveClaudeWorkingDirectory({ XDG_DATA_HOME: xdgDataHome })).toBe(
      resolvedWorkspaceDir,
    );
    expect(existsSync(workspaceDir)).toBe(true);
  });

  test('encodes Claude project paths the same way as the CLI session directory', () => {
    expect(
      encodeClaudeProjectPath(
        '/Users/z/Projects/cli-agent-api/agent-workspace',
      ),
    ).toBe('-Users-z-Projects-cli-agent-api-agent-workspace');
  });

  test('encodes Claude project paths using the canonical real path when available', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-claude-'));
    const realWorkspaceDir = join(rootDir, 'real', 'agent-workspace');
    const symlinkRootDir = join(rootDir, 'link');

    mkdirSync(realWorkspaceDir, { recursive: true });
    symlinkSync(join(rootDir, 'real'), symlinkRootDir, 'dir');

    expect(
      encodeClaudeProjectPath(join(symlinkRootDir, 'agent-workspace')),
    ).toBe(encodeClaudeProjectPath(realWorkspaceDir));
  });

  test('creates a synthetic Claude resume session from history', () => {
    const session = createClaudeResumeSession({
      history: [
        {
          role: 'user',
          content: 'Hello',
        },
        {
          role: 'assistant',
          content: 'Hi there',
        },
      ],
      cwd: '/tmp/demo/agent-workspace',
      claudeConfigDir: '/tmp/.claude',
      sessionId: 'session-123',
      now: new Date('2026-03-14T12:00:00.000Z'),
    });

    expect(session).toBeDefined();
    expect(session?.filePath).toBe(
      '/tmp/.claude/projects/-tmp-demo-agent-workspace/session-123.jsonl',
    );

    const lines = session!.content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      type: 'file-history-snapshot',
      isSnapshotUpdate: false,
    });
    expect(lines[1]).toMatchObject({
      parentUuid: null,
      type: 'user',
      message: {
        role: 'user',
        content: 'Hello',
      },
      sessionId: 'session-123',
      userType: 'external',
      __restored: true,
    });
    expect(lines[2]).toMatchObject({
      parentUuid: lines[1].uuid,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Hi there',
          },
        ],
      },
      sessionId: 'session-123',
      userType: 'external',
      __restored: true,
    });
    expect(lines[3]).toEqual({
      type: 'last-prompt',
      lastPrompt: 'Hello',
      sessionId: 'session-123',
    });
  });

  test('writes a synthetic Claude resume session to disk', async () => {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
    const cwd = '/tmp/demo/agent-workspace';
    const session = await seedClaudeResumeSession(
      {
        history: [
          {
            role: 'user',
            content: 'Hello',
          },
        ],
      },
      cwd,
      {
        claudeConfigDir,
        sessionId: 'session-456',
        now: new Date('2026-03-14T12:00:00.000Z'),
      },
    );

    expect(resolveClaudeProjectsDirectory(claudeConfigDir)).toBe(
      join(claudeConfigDir, 'projects'),
    );
    expect(session?.filePath).toBe(
      join(
        claudeConfigDir,
        'projects',
        '-tmp-demo-agent-workspace',
        'session-456.jsonl',
      ),
    );
    expect(readFileSync(session!.filePath, 'utf8')).toBe(session?.content);
  });

  test('parses plain Claude session history and ignores partial thinking lines', () => {
    expect(
      parseClaudeSessionHistory(
        `{"type":"user","message":{"role":"user","content":"Hello"}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":""}],"stop_reason":null}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}],"stop_reason":"end_turn"}}\n`,
      ),
    ).toEqual([
      {
        role: 'user',
        content: 'Hello',
      },
      {
        role: 'assistant',
        content: 'Hi there',
      },
    ]);
  });

  test('parses final assistant text lines even when stop_reason is null', () => {
    expect(
      parseClaudeSessionHistory(
        `{"type":"user","message":{"role":"user","content":"Hello"}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Working"}],"stop_reason":null}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}],"stop_reason":null}}\n{"type":"last-prompt","lastPrompt":"Hello"}\n`,
      ),
    ).toEqual([
      {
        role: 'user',
        content: 'Hello',
      },
      {
        role: 'assistant',
        content: 'Hi there',
      },
    ]);
  });

  test('refuses to parse Claude session history with unsupported tool content', () => {
    expect(
      parseClaudeSessionHistory(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"WebSearch"}],"stop_reason":"tool_use"}}\n',
      ),
    ).toBeNull();
  });

  test('claims a mapped Claude session when the on-disk history hash matches', async () => {
    await withTempDataDir(async () => {
      const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
      const sessionMappingStore = new FileSystemKvStore(
        CLAUDE_SESSION_MAPPING_STORE_ID,
        CLAUDE_SESSION_MAPPING_STORE_VERSION,
      );
      const history = [
        {
          role: 'user' as const,
          content: 'Hello',
        },
        {
          role: 'assistant' as const,
          content: 'Hi there',
        },
      ];
      const historyHash = createClaudeSessionHistoryHash(history);
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const session = createClaudeResumeSession({
        history,
        cwd: '/tmp/demo/agent-workspace',
        claudeConfigDir,
        sessionId,
      });

      mkdirSync(dirname(session!.filePath), { recursive: true });
      writeFileSync(session!.filePath, session!.content, 'utf8');
      await sessionMappingStore.set(historyHash, sessionId);

      await expect(
        claimClaudeResumeSession({
          historyHash,
          cwd: '/tmp/demo/agent-workspace',
          claudeConfigDir,
          sessionMappingStore,
        }),
      ).resolves.toEqual({
        sessionId,
        filePath: session!.filePath,
        content: '',
        historyHash,
      });
      await expect(
        sessionMappingStore.get(historyHash),
      ).resolves.toBeUndefined();
    });
  });

  test('falls back to a fresh synthetic session when a claimed mapping is stale', async () => {
    await withTempDataDir(async () => {
      const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
      const sessionMappingStore = new FileSystemKvStore(
        CLAUDE_SESSION_MAPPING_STORE_ID,
        CLAUDE_SESSION_MAPPING_STORE_VERSION,
      );
      const history = [
        {
          role: 'user' as const,
          content: 'Hello',
        },
      ];
      const historyHash = createClaudeSessionHistoryHash(history);

      await sessionMappingStore.set(
        historyHash,
        '22222222-2222-2222-2222-222222222222',
      );

      const preparedSession = await prepareClaudeResumeSession(
        {
          history,
        },
        '/tmp/demo/agent-workspace',
        {
          claudeConfigDir,
          sessionMappingStore,
          now: new Date('2026-03-14T12:00:00.000Z'),
        },
      );

      expect(preparedSession).toBeDefined();
      expect(preparedSession?.sessionId).not.toBe(
        '22222222-2222-2222-2222-222222222222',
      );
      expect(preparedSession?.historyHash).toBe(historyHash);
      expect(
        existsSync(
          resolveClaudeSessionFilePath(
            preparedSession!.sessionId,
            '/tmp/demo/agent-workspace',
            claudeConfigDir,
          ),
        ),
      ).toBe(true);
      await expect(
        sessionMappingStore.get(historyHash),
      ).resolves.toBeUndefined();
    });
  });

  test('writes a new Claude session mapping from the updated session file', async () => {
    await withTempDataDir(async () => {
      const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
      const sessionMappingStore = new FileSystemKvStore(
        CLAUDE_SESSION_MAPPING_STORE_ID,
        CLAUDE_SESSION_MAPPING_STORE_VERSION,
      );
      const sessionId = '33333333-3333-3333-3333-333333333333';
      const filePath = resolveClaudeSessionFilePath(
        sessionId,
        '/tmp/demo/agent-workspace',
        claudeConfigDir,
      );

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        '{"type":"file-history-snapshot","messageId":"user-1","snapshot":{"messageId":"user-1","trackedFileBackups":{},"timestamp":"2026-03-14T12:00:00.000Z"},"isSnapshotUpdate":false}\n' +
          '{"type":"user","message":{"role":"user","content":"Hello"},"uuid":"user-1","timestamp":"2026-03-14T12:00:00.000Z","sessionId":"33333333-3333-3333-3333-333333333333","userType":"external","__restored":true}\n' +
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]},"uuid":"assistant-1","timestamp":"2026-03-14T12:00:00.001Z","sessionId":"33333333-3333-3333-3333-333333333333","userType":"external","__restored":true}\n' +
          '{"type":"queue-operation","operation":"enqueue","sessionId":"33333333-3333-3333-3333-333333333333","content":"What next?"}\n' +
          '{"type":"user","message":{"role":"user","content":"What next?"},"uuid":"user-2","timestamp":"2026-03-14T12:00:01.000Z","sessionId":"33333333-3333-3333-3333-333333333333","userType":"external"}\n' +
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":""}],"stop_reason":null},"uuid":"assistant-2a","timestamp":"2026-03-14T12:00:01.100Z","sessionId":"33333333-3333-3333-3333-333333333333","userType":"external"}\n' +
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Carry on"}],"stop_reason":"end_turn"},"uuid":"assistant-2b","timestamp":"2026-03-14T12:00:02.000Z","sessionId":"33333333-3333-3333-3333-333333333333","userType":"external"}\n',
        'utf8',
      );

      await updateClaudeSessionMapping(
        {
          sessionId,
          filePath,
        },
        {
          sessionMappingStore,
        },
      );

      await expect(
        sessionMappingStore.get(
          createClaudeSessionHistoryHash([
            {
              role: 'user',
              content: 'Hello',
            },
            {
              role: 'assistant',
              content: 'Hi there',
            },
            {
              role: 'user',
              content: 'What next?',
            },
            {
              role: 'assistant',
              content: 'Carry on',
            },
          ]),
        ),
      ).resolves.toBe(sessionId);
    });
  });

  test('does not write a Claude session mapping for unsupported updated session files', async () => {
    await withTempDataDir(async (dataDir) => {
      const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
      const sessionMappingStore = new FileSystemKvStore(
        CLAUDE_SESSION_MAPPING_STORE_ID,
        CLAUDE_SESSION_MAPPING_STORE_VERSION,
      );
      const sessionId = '44444444-4444-4444-4444-444444444444';
      const filePath = resolveClaudeSessionFilePath(
        sessionId,
        '/tmp/demo/agent-workspace',
        claudeConfigDir,
      );

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"WebSearch"}],"stop_reason":"tool_use"}}\n',
        'utf8',
      );

      await updateClaudeSessionMapping(
        {
          sessionId,
          filePath,
        },
        {
          sessionMappingStore,
        },
      );

      expect(existsSync(join(dataDir, CLAUDE_SESSION_MAPPING_STORE_ID))).toBe(
        false,
      );
    });
  });

  test('normalizes Claude usage and preserves extra fields', () => {
    expect(
      normalizeClaudeUsage(
        {
          input_tokens: 1910,
          output_tokens: 10,
          cache_read_input_tokens: 12,
          service_tier: 'standard',
        },
        {
          total_cost_usd: 0.25,
          rate_limit_info: {
            status: 'allowed',
          },
        },
      ),
    ).toEqual({
      input_tokens: 1910,
      output_tokens: 10,
      cache_read_input_tokens: 12,
      service_tier: 'standard',
      total_cost_usd: 0.25,
      rate_limit_info: {
        status: 'allowed',
      },
      prompt_tokens: 1910,
      completion_tokens: 10,
      total_tokens: 1920,
      prompt_tokens_details: {
        cached_tokens: 12,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    });
  });
});
