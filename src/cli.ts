#!/usr/bin/env node

import { createServer as createHttpServer } from 'node:http';

import { Command } from 'commander';

import {
  ensureServeConfigDirectories,
  resolveServeConfig,
  type ServeCliOptions,
} from './config.js';
import { serializeError, writeLog } from './logger.js';
import { createServer } from './server.js';

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name('cli-agent-api')
    .description('Wrap CLI coding agents behind standard APIs.');

  program
    .command('serve')
    .description('Start the API server.')
    .option('--host <host>', 'Host to bind to')
    .option('--port <port>', 'Port to bind to')
    .option('--api-key <apiKeys>', 'Comma-separated bearer tokens to require')
    .option(
      '--tool-mode <mode>',
      'Tool handling mode: "native" (agent uses its own tools) or "bridge" (expose client-provided tools)',
    )
    .action(async (options: ServeCliOptions) => {
      const config = resolveServeConfig(options);
      await ensureServeConfigDirectories(config);
      const app = createServer({
        apiKeys: config.apiKeys,
        toolMode: config.toolMode,
      });
      const server = createHttpServer(app);

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          resolve();
        });
      });

      writeLog({
        level: 'info',
        event: 'server.started',
        message: `listening on http://${config.host}:${config.port}`,
        host: config.host,
        port: config.port,
        apiKeyCount: config.apiKeys.length,
        dataDir: config.dataDir,
        agentWorkspaceDir: config.agentWorkspaceDir,
        toolMode: config.toolMode,
      });
    });

  await program.parseAsync(argv);
}

void runCli().catch((error: unknown) => {
  const details = serializeError(error);

  writeLog({
    level: 'error',
    event: 'process.error',
    message:
      details.message === undefined
        ? 'process error'
        : `process error: ${details.message}`,
    error: details,
  });
  process.exitCode = 1;
});
