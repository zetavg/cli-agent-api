import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  ensureAgentWorkspaceDir,
  resolveAgentWorkspaceDir,
  resolveDataDir,
  resolveServeConfig,
  resolveXdgDataHome,
} from '../src/config.js';

describe('resolveServeConfig', () => {
  test('uses defaults when cli options and env are missing', () => {
    expect(resolveServeConfig({}, {})).toEqual({
      host: '127.0.0.1',
      port: 8041,
      apiKeys: [],
      dataDir: join(homedir(), '.local', 'share', 'cli-agent-api'),
      agentWorkspaceDir: join(
        homedir(),
        '.local',
        'share',
        'cli-agent-api',
        'agent-workspace',
      ),
      toolMode: 'native',
    });
  });

  test('prefers cli options over env vars', () => {
    expect(
      resolveServeConfig(
        {
          host: '0.0.0.0',
          port: '9000',
          apiKey: 'alpha, beta',
        },
        {
          HOST: '127.0.0.2',
          PORT: '8000',
          API_KEY: 'gamma',
        },
      ),
    ).toEqual({
      host: '0.0.0.0',
      port: 9000,
      apiKeys: ['alpha', 'beta'],
      dataDir: join(homedir(), '.local', 'share', 'cli-agent-api'),
      agentWorkspaceDir: join(
        homedir(),
        '.local',
        'share',
        'cli-agent-api',
        'agent-workspace',
      ),
      toolMode: 'native',
    });
  });

  test('uses XDG_DATA_HOME when DATA_DIR is not set', () => {
    expect(resolveXdgDataHome({ XDG_DATA_HOME: '/tmp/xdg-data' })).toBe(
      '/tmp/xdg-data',
    );
    expect(resolveDataDir({ XDG_DATA_HOME: '/tmp/xdg-data' })).toBe(
      '/tmp/xdg-data/cli-agent-api',
    );
    expect(
      resolveAgentWorkspaceDir({
        XDG_DATA_HOME: '/tmp/xdg-data',
      }),
    ).toBe('/tmp/xdg-data/cli-agent-api/agent-workspace');
  });

  test('prefers DATA_DIR over XDG_DATA_HOME', () => {
    expect(
      resolveServeConfig(
        {},
        {
          DATA_DIR: '/tmp/app-data',
          XDG_DATA_HOME: '/tmp/xdg-data',
        },
      ),
    ).toEqual({
      host: '127.0.0.1',
      port: 8041,
      apiKeys: [],
      dataDir: '/tmp/app-data',
      agentWorkspaceDir: '/tmp/app-data/agent-workspace',
      toolMode: 'native',
    });
  });

  test('creates the data dir and agent workspace under XDG_DATA_HOME', async () => {
    const xdgDataHome = join(
      mkdtempSync(join(tmpdir(), 'cli-agent-api-')),
      'xdg-data',
    );
    const agentWorkspaceDir = join(
      xdgDataHome,
      'cli-agent-api',
      'agent-workspace',
    );

    await expect(
      ensureAgentWorkspaceDir({ XDG_DATA_HOME: xdgDataHome }),
    ).resolves.toBe(agentWorkspaceDir);
    expect(existsSync(join(xdgDataHome, 'cli-agent-api'))).toBe(true);
    expect(existsSync(agentWorkspaceDir)).toBe(true);
  });
});
