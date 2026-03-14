import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ServeCliOptions {
  host?: string;
  port?: string | number;
  apiKey?: string;
}

type AppEnv = Record<string, string | undefined>;

export interface ServeConfig {
  host: string;
  port: number;
  apiKeys: string[];
  dataDir: string;
  agentWorkspaceDir: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8041;

export function resolveServeConfig(
  options: ServeCliOptions,
  env: AppEnv = process.env,
): ServeConfig {
  const host = options.host ?? env.HOST ?? DEFAULT_HOST;
  const portInput = options.port ?? env.PORT ?? DEFAULT_PORT;
  const apiKeyInput = options.apiKey ?? env.API_KEY ?? '';
  const port = parsePort(portInput);
  const dataDir = resolveDataDir(env);

  return {
    host,
    port,
    apiKeys: parseApiKeys(apiKeyInput),
    dataDir,
    agentWorkspaceDir: resolveAgentWorkspaceDir(env),
  };
}

export function resolveXdgDataHome(env: AppEnv = process.env): string {
  return (
    resolveOptionalPath(env.XDG_DATA_HOME) ?? join(homedir(), '.local', 'share')
  );
}

export function resolveDataDir(env: AppEnv = process.env): string {
  return (
    resolveOptionalPath(env.DATA_DIR) ??
    join(resolveXdgDataHome(env), 'cli-agent-api')
  );
}

export function resolveAgentWorkspaceDir(env: AppEnv = process.env): string {
  return join(resolveDataDir(env), 'agent-workspace');
}

function parsePort(value: number | string): number {
  const port = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function parseApiKeys(value: string): string[] {
  return value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return resolve(trimmed);
}
