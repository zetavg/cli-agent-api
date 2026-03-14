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
  prompt_tokens_details: {
    cached_tokens: number;
    audio_tokens: number;
  };
  completion_tokens_details: {
    reasoning_tokens: number;
    audio_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
  [key: string]: unknown;
}

export function createEmptyUsage(): ChatCompletionUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
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

export interface ProviderToolCallDeltaEvent {
  type: 'response.output_tool_call.delta';
  toolCallIndex: number;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: string;
}

export interface ProviderToolResultDeltaEvent {
  type: 'response.output_tool_result.delta';
  toolCallIndex: number;
  toolCallId: string;
  toolOutput: string;
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
  | ProviderToolCallDeltaEvent
  | ProviderToolResultDeltaEvent
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
    usage: usage ?? createEmptyUsage(),
  };
}

export function createChatCompletionStreamChunk(
  metadata: ProviderCompletionMetadata,
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      result?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  },
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

export function createChatCompletionUsageStreamChunk(
  metadata: ProviderCompletionMetadata,
  usage?: ChatCompletionUsage,
) {
  return {
    id: metadata.id,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [],
    usage: usage ?? createEmptyUsage(),
  };
}

export function toSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
