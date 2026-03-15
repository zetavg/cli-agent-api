import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveDataDir } from './config.js';

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export class FileSystemKvStore {
  constructor(
    readonly id: string,
    readonly version: string,
  ) {
    validateStoreId(id);
  }

  async get(key: string): Promise<string | undefined> {
    const filePath = this.resolveKeyPath(key);

    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const filePath = this.resolveKeyPath(key);
    const directoryPath = dirname(filePath);
    const tempPath = join(directoryPath, `.tmp-${randomUUID()}`);

    await mkdir(directoryPath, { recursive: true });
    await writeFile(tempPath, value, 'utf8');
    await rename(tempPath, filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKeyPath(key);

    try {
      await rm(filePath, { force: true });
    } finally {
      await cleanupEmptyDirectory(dirname(filePath), this.resolveRootPath());
    }
  }

  async claim(key: string): Promise<string | undefined> {
    const filePath = this.resolveKeyPath(key);
    const claimedPath = `${filePath}.claim-${randomUUID()}`;

    try {
      await rename(filePath, claimedPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }

    try {
      return await readFile(claimedPath, 'utf8');
    } finally {
      await rm(claimedPath, { force: true });
      await cleanupEmptyDirectory(dirname(filePath), this.resolveRootPath());
    }
  }

  private resolveRootPath(): string {
    return join(resolveDataDir(), this.id);
  }

  private resolveKeyPath(key: string): string {
    switch (this.version) {
      case 'v1':
        return resolveV1KeyPath(this.resolveRootPath(), key);
      default:
        throw new Error(
          `Unsupported file system KV store version: ${this.version}`,
        );
    }
  }
}

function resolveV1KeyPath(rootPath: string, key: string): string {
  validateStoreKey(key);

  return join(rootPath, key.slice(0, 2), key);
}

function validateStoreId(id: string): void {
  const segments = id.split('/');

  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !SAFE_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`Invalid file system KV store id: ${id}`);
  }
}

function validateStoreKey(key: string): void {
  if (key.length < 3 || !SAFE_SEGMENT_PATTERN.test(key)) {
    throw new Error(`Invalid file system KV store key: ${key}`);
  }
}

async function cleanupEmptyDirectory(
  directoryPath: string,
  rootPath: string,
): Promise<void> {
  let currentPath = directoryPath;

  while (currentPath.startsWith(rootPath) && currentPath !== rootPath) {
    try {
      await rmdir(currentPath);
    } catch (error) {
      if (isMissingFileError(error) || !isDirectoryNotEmptyError(error)) {
        return;
      }
    }

    currentPath = dirname(currentPath);
  }
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;

  return error instanceof Error && (code === 'ENOENT' || code === 'ENOTDIR');
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;

  return error instanceof Error && (code === 'ENOTEMPTY' || code === 'EEXIST');
}
