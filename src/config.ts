export interface ServeCliOptions {
  host?: string;
  port?: string | number;
  apiKey?: string;
}

export interface ServeConfig {
  host: string;
  port: number;
  apiKeys: string[];
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8041;

export function resolveServeConfig(
  options: ServeCliOptions,
  env: Record<string, string | undefined> = process.env,
): ServeConfig {
  const host = options.host ?? env.HOST ?? DEFAULT_HOST;
  const portInput = options.port ?? env.PORT ?? DEFAULT_PORT;
  const apiKeyInput = options.apiKey ?? env.API_KEY ?? '';
  const port = parsePort(portInput);

  return {
    host,
    port,
    apiKeys: parseApiKeys(apiKeyInput),
  };
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
