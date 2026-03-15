import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { FileSystemKvStore } from '../src/file-system-kv-store.js';

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
    return;
  }

  process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

describe('FileSystemKvStore', () => {
  test('reads missing keys as undefined', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await expect(store.get('abcdef')).resolves.toBeUndefined();
    await expect(store.claim('abcdef')).resolves.toBeUndefined();
  });

  test('writes values atomically using the v1 sharded layout', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    process.env.DATA_DIR = dataDir;

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await store.set('abcdef', 'session-123');

    expect(await store.get('abcdef')).toBe('session-123');
    expect(
      readFileSync(
        join(dataDir, 'claude/session_mapping/v1/ab/abcdef'),
        'utf8',
      ),
    ).toBe('session-123');
  });

  test('overwrites existing values', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await store.set('abcdef', 'session-123');
    await store.set('abcdef', 'session-456');

    expect(await store.get('abcdef')).toBe('session-456');
  });

  test('claims values atomically and removes the canonical entry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    process.env.DATA_DIR = dataDir;

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await store.set('abcdef', 'session-123');

    expect(await store.claim('abcdef')).toBe('session-123');
    expect(await store.get('abcdef')).toBeUndefined();
    expect(
      existsSync(join(dataDir, 'claude/session_mapping/v1/ab/abcdef')),
    ).toBe(false);
  });

  test('deletes existing keys and tolerates missing keys', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await store.set('abcdef', 'session-123');
    await store.delete('abcdef');
    await store.delete('abcdef');

    expect(await store.get('abcdef')).toBeUndefined();
  });

  test('isolates stores by id', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const firstStore = new FileSystemKvStore('claude/session_mapping/v1', 'v1');
    const secondStore = new FileSystemKvStore('claude/other_mapping/v1', 'v1');

    await firstStore.set('abcdef', 'session-123');
    await secondStore.set('abcdef', 'session-456');

    expect(await firstStore.get('abcdef')).toBe('session-123');
    expect(await secondStore.get('abcdef')).toBe('session-456');
  });

  test('rejects invalid store ids', () => {
    expect(() => new FileSystemKvStore('../claude', 'v1')).toThrowError(
      'Invalid file system KV store id: ../claude',
    );
  });

  test('rejects invalid keys', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v1');

    await expect(store.get('ab')).rejects.toThrowError(
      'Invalid file system KV store key: ab',
    );
    await expect(store.set('abc/def', 'session-123')).rejects.toThrowError(
      'Invalid file system KV store key: abc/def',
    );
  });

  test('rejects unsupported storage versions', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cli-agent-api-data-'));

    const store = new FileSystemKvStore('claude/session_mapping/v1', 'v9');

    await expect(store.get('abcdef')).rejects.toThrowError(
      'Unsupported file system KV store version: v9',
    );
  });
});
