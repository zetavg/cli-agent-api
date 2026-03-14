import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildClaudeArgs,
  createClaudeResumeSession,
  DEFAULT_CLAUDE_TOOLS,
  encodeClaudeProjectPath,
  normalizeClaudeUsage,
  parseClaudeLine,
  resolveClaudeProjectsDirectory,
  resolveClaudeWorkingDirectory,
  seedClaudeResumeSession,
} from '../src/index.js';

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

  test('resolves the Claude working directory to agent-workspace', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-'));
    const workspaceDir = join(baseDir, 'agent-workspace');

    mkdirSync(workspaceDir);

    expect(resolveClaudeWorkingDirectory(baseDir)).toBe(workspaceDir);
  });

  test('encodes Claude project paths the same way as the CLI session directory', () => {
    expect(
      encodeClaudeProjectPath(
        '/Users/z/Projects/cli-agent-api/agent-workspace',
      ),
    ).toBe('-Users-z-Projects-cli-agent-api-agent-workspace');
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
      model: 'sonnet',
      now: new Date('2026-03-14T12:00:00.000Z'),
      version: 'test-version',
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
      cwd: '/tmp/demo/agent-workspace',
      sessionId: 'session-123',
      version: 'test-version',
    });
    expect(lines[2]).toMatchObject({
      parentUuid: lines[1].uuid,
      type: 'assistant',
      message: {
        model: 'sonnet',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Hi there',
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      cwd: '/tmp/demo/agent-workspace',
      sessionId: 'session-123',
      version: 'test-version',
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
        model: 'sonnet',
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
        version: 'test-version',
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
