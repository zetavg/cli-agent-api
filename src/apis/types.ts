import type { Request, Response } from 'express';

import type { AgentProvider } from '../providers.js';

export interface ApiHandler {
  method: 'post' | 'get';
  path: string;
  handle(
    request: Request,
    response: Response,
    provider: AgentProvider,
    signal: AbortSignal,
  ): Promise<void> | void;
}
