import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { chatCompletionsHandler } from './apis/chat-completions.js';
import type { ApiHandler } from './apis/types.js';
import { ClaudeProvider } from './providers/claude.js';
import {
  createRequestLogContext,
  durationMs,
  formatDurationMs,
  serializeError,
  writeLog,
} from './logger.js';
import type { AgentProvider } from './providers.js';

export interface ServerOptions {
  apiKeys?: string[];
  providers?: AgentProvider[];
  apiHandlers?: ApiHandler[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();
  const providers = new Map(
    (options.providers ?? [new ClaudeProvider()]).map((provider) => [
      provider.name,
      provider,
    ]),
  );
  const apiHandlers = options.apiHandlers ?? [chatCompletionsHandler];
  const apiKeys = new Set(options.apiKeys ?? []);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(createRequestLoggingMiddleware());
  app.use(createCorsMiddleware());
  app.use(createAuthMiddleware(apiKeys));

  for (const handler of apiHandlers) {
    const route = `/:provider${handler.path}`;

    app[handler.method](route, async (request, response, next) => {
      try {
        const provider = providers.get(getRouteParam(request.params.provider));

        if (!provider) {
          throw new HttpError(
            404,
            'provider_not_found',
            'Unsupported provider.',
          );
        }

        await handler.handle(
          request,
          response,
          provider,
          createRequestAbortSignal(request, response),
        );
      } catch (error) {
        next(error);
      }
    });
  }

  app.use('/:provider/*rest', (request, response) => {
    const provider = providers.get(getRouteParam(request.params.provider));

    if (!provider) {
      sendError(response, 404, 'provider_not_found', 'Unsupported provider.');
      return;
    }

    sendError(response, 404, 'not_found', 'Unsupported API route.');
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof HttpError) {
        for (const [name, value] of Object.entries(error.headers)) {
          response.setHeader(name, value);
        }

        logHttpError(_request, response, error, error.status, error.code);
        sendError(response, error.status, error.code, error.message);
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Internal server error.';
      const status = isBadRequestError(error) ? 400 : 500;
      const code =
        status === 400 ? 'invalid_request_error' : 'internal_server_error';

      logHttpError(_request, response, error, status, code);
      sendError(response, status, code, message);
    },
  );

  return app;
}

function createRequestLoggingMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    const context = createRequestLogContext();

    response.locals.requestId = context.requestId;

    writeLog({
      level: 'info',
      event: 'http.request',
      message: `${request.method} ${request.originalUrl}`,
      requestId: context.requestId,
      method: request.method,
      path: request.path,
    });

    response.on('finish', () => {
      const elapsedMs = durationMs(context.startedAt);

      writeLog({
        level: 'info',
        event: 'http.response',
        message: `${request.method} ${request.originalUrl} ${response.statusCode} ${formatDurationMs(elapsedMs)}`,
        requestId: context.requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: elapsedMs,
      });
    });

    next();
  };
}

function createCorsMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(getCorsHeaders())) {
      response.setHeader(name, value);
    }

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    next();
  };
}

function createAuthMiddleware(apiKeys: Set<string>) {
  return (request: Request, response: Response, next: NextFunction) => {
    try {
      authorizeRequest(request.header('authorization'), apiKeys);
      next();
    } catch (error) {
      if (error instanceof HttpError) {
        for (const [name, value] of Object.entries(error.headers)) {
          response.setHeader(name, value);
        }

        logHttpError(request, response, error, error.status, error.code);
        sendError(response, error.status, error.code, error.message);
        return;
      }

      next(error);
    }
  };
}

export function authorizeRequest(
  authorizationHeader: string | undefined,
  apiKeys: Set<string>,
) {
  if (apiKeys.size === 0) {
    return;
  }

  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'invalid_api_key', 'Missing bearer token.', {
      'WWW-Authenticate': 'Bearer',
    });
  }

  const apiKey = authorizationHeader.slice('Bearer '.length);

  if (!apiKeys.has(apiKey)) {
    throw new HttpError(401, 'invalid_api_key', 'Invalid API key.', {
      'WWW-Authenticate': 'Bearer',
    });
  }
}

export function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function logHttpError(
  request: Request,
  response: Response,
  error: unknown,
  status: number,
  code: string,
) {
  const details = serializeError(error);

  writeLog({
    level: 'error',
    event: 'http.error',
    message: `${request.method} ${request.originalUrl} ${status} ${code} ${details.message ?? 'error'}`,
    requestId: response.locals.requestId,
    method: request.method,
    url: request.originalUrl,
    statusCode: status,
    code,
    error: details,
  });
}

function createRequestAbortSignal(
  request: Request,
  response: Response,
): AbortSignal {
  const controller = new AbortController();

  request.on('aborted', () => {
    controller.abort();
  });
  response.on('close', () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });

  return controller.signal;
}

function isBadRequestError(error: unknown): boolean {
  return (
    (error instanceof Error && error.message.startsWith('`messages`')) ||
    (error instanceof Error && error.message.startsWith('The last message'))
  );
}

function getRouteParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
) {
  response.status(status).json({
    error: {
      message,
      type: code,
      code,
    },
  });
}
