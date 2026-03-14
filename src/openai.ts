import { randomUUID } from 'node:crypto';

export interface ChatCompletionsRequestBody {
  model?: string;
  stream?: boolean;
  messages?: unknown;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ProviderCompletionMetadata {
  id: string;
  model: string;
  created: number;
}

export interface ProviderTextDeltaEvent {
  type: 'response.output_text.delta';
  text: string;
}

export interface ProviderMetadataEvent {
  type: 'response.metadata';
  model: string;
}

export interface ProviderCompletedEvent {
  type: 'response.completed';
  finishReason: 'stop' | 'length';
  usage?: ChatCompletionUsage;
}

export type ProviderChatCompletionEvent =
  | ProviderMetadataEvent
  | ProviderTextDeltaEvent
  | ProviderCompletedEvent;

export function createCompletionMetadata(
  model?: string,
): ProviderCompletionMetadata {
  return {
    id: `chatcmpl_${randomUUID().replaceAll('-', '')}`,
    model: model ?? 'claude-code',
    created: Math.floor(Date.now() / 1000),
  };
}

export function createChatCompletionResponse(
  metadata: ProviderCompletionMetadata,
  content: string,
  finishReason: 'stop' | 'length',
  usage?: ChatCompletionUsage,
) {
  return {
    id: metadata.id,
    object: 'chat.completion',
    created: metadata.created,
    model: metadata.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export function createChatCompletionStreamChunk(
  metadata: ProviderCompletionMetadata,
  delta: { role?: 'assistant'; content?: string },
  finishReason: 'stop' | 'length' | null = null,
) {
  return {
    id: metadata.id,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

export function toSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
