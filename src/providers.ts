import type {
  ProviderChatCompletionEvent,
  ProviderCompletionMetadata,
} from './openai.js';

export interface ProviderChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderToolDefinition {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ProviderChatCompletionInput {
  model?: string;
  prompt: string;
  systemPrompt?: string;
  history?: ProviderChatHistoryMessage[];
  /**
   * Client-provided tool definitions to expose through the prompted bridge.
   * Only set when {@link ProviderChatCompletionInput.toolMode} is `bridge`.
   */
  tools?: ProviderToolDefinition[];
  /**
   * `native` (default) lets the agent use its own built-in tools; `bridge`
   * disables them and exposes the client's tools via the prompted protocol.
   */
  toolMode?: 'native' | 'bridge';
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
