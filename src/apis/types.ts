import type { Request, Response } from 'express';

import type { AgentProvider } from '../providers.js';

export interface ApiHandlerContext {
  toolMode?: 'native' | 'bridge';
}

export interface ApiHandler {
  method: 'post' | 'get';
  path: string;
  handle(
    request: Request,
    response: Response,
    provider: AgentProvider,
    signal: AbortSignal,
    context: ApiHandlerContext,
  ): Promise<void> | void;
}
