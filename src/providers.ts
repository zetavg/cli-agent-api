import type {
  ProviderChatCompletionEvent,
  ProviderCompletionMetadata,
} from './openai.js';

export interface ProviderChatCompletionInput {
  model?: string;
  prompt: string;
}

export interface ProviderChatCompletionRun {
  metadata: ProviderCompletionMetadata;
  events: AsyncIterable<ProviderChatCompletionEvent>;
}

export interface AgentProvider {
  name: string;
  createChatCompletion(
    input: ProviderChatCompletionInput,
    signal: AbortSignal,
  ): ProviderChatCompletionRun;
}
