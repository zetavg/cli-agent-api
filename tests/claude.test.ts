import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildClaudeArgs,
  normalizeClaudeUsage,
  parseClaudeLine,
  resolveClaudeWorkingDirectory,
} from '../src/index.js';

describe('Claude adapter helpers', () => {
  test('builds the expected claude CLI arguments', () => {
    expect(
      buildClaudeArgs({
        model: 'sonnet',
        prompt: 'Hello there!',
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      'sonnet',
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
    expect(parseClaudeLine('not-json')).toBeNull();
  });

  test('resolves the Claude working directory to agent-workspace', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-'));
    const workspaceDir = join(baseDir, 'agent-workspace');

    mkdirSync(workspaceDir);

    expect(resolveClaudeWorkingDirectory(baseDir)).toBe(workspaceDir);
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
