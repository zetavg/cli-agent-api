import type {
  ProviderChatCompletionEvent,
  ProviderCompletionMetadata,
} from './openai.js';

export interface ProviderChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderChatCompletionInput {
  model?: string;
  prompt: string;
  systemPrompt?: string;
  history?: ProviderChatHistoryMessage[];
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
