import type { ProviderChatHistoryMessage } from './providers.js';

export interface ChatCompletionToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionMessage {
  role: string;
  content?: string | ChatCompletionContentPart[] | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionContentPart {
  type: string;
  text?: string;
}

/**
 * The new turn the server must act on. It is either a fresh user message or the
 * results of tool calls the client executed on the server's behalf (the OpenAI
 * agent loop posts these back as `role: "tool"` messages).
 */
export type LatestTurn =
  | { kind: 'user'; text: string }
  | {
      kind: 'tool_results';
      items: Array<{ toolCallId: string; content: string }>;
    };

/**
 * A conversation message preserved for history. Unlike {@link
 * ProviderChatHistoryMessage}, this keeps the structured tool-calling fields so
 * the bridge can reconstruct a faithful transcript.
 */
export type ConversationMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ChatCompletionToolCall[];
    }
  | { role: 'tool'; toolCallId: string; content: string };

export function extractSystemPrompt(
  messages: ChatCompletionMessage[],
): string | undefined {
  const prompt = messages
    .filter(
      (message) => message.role === 'system' || message.role === 'developer',
    )
    .map((message) => normalizeMessageContent(message.content).trim())
    .filter((content) => content.length > 0)
    .join('\n');

  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Determines the new turn from the trailing messages. A trailing run of
 * `role: "tool"` messages is treated as tool results (the continuation of an
 * agent loop); otherwise the last message must be a user message.
 */
export function extractLatestTurn(
  messages: ChatCompletionMessage[],
): LatestTurn {
  const lastMessage = messages.at(-1);

  if (!lastMessage) {
    throw new Error('`messages` must contain at least one message.');
  }

  if (lastMessage.role === 'tool') {
    const items: Array<{ toolCallId: string; content: string }> = [];

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];

      if (message.role !== 'tool') {
        break;
      }

      items.unshift({
        toolCallId: message.tool_call_id ?? '',
        content: normalizeMessageContent(message.content),
      });
    }

    return { kind: 'tool_results', items };
  }

  if (lastMessage.role !== 'user') {
    throw new Error('The last message must be a user or tool message.');
  }

  const text = normalizeMessageContent(lastMessage.content).trim();

  if (text.length === 0) {
    throw new Error('The last message must contain text content.');
  }

  return { kind: 'user', text };
}

/**
 * Returns the prior conversation (everything except system/developer messages
 * and the messages that form the latest turn), preserving tool calls and tool
 * results so the bridge can rebuild the transcript.
 */
export function extractConversationHistory(
  messages: ChatCompletionMessage[],
): ConversationMessage[] {
  const conversationMessages = messages.filter(
    (message) => message.role !== 'system' && message.role !== 'developer',
  );

  const historyMessages = conversationMessages.slice(
    0,
    conversationMessages.length - countLatestTurnMessages(conversationMessages),
  );

  return historyMessages.flatMap((message): ConversationMessage[] => {
    if (message.role === 'user') {
      const content = normalizeMessageContent(message.content).trim();

      return content.length > 0 ? [{ role: 'user', content }] : [];
    }

    if (message.role === 'assistant') {
      const content = normalizeMessageContent(message.content).trim();
      const toolCalls = normalizeToolCalls(message.tool_calls);

      if (content.length === 0 && toolCalls.length === 0) {
        return [];
      }

      return [
        {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      ];
    }

    if (message.role === 'tool') {
      return [
        {
          role: 'tool',
          toolCallId: message.tool_call_id ?? '',
          content: normalizeMessageContent(message.content),
        },
      ];
    }

    return [];
  });
}

/**
 * Flattens the structured conversation into the simple text history the
 * providers consume in native mode. Tool calls and tool results are dropped,
 * matching the original text-only behavior.
 */
export function toNativeProviderHistory(
  history: ConversationMessage[],
): ProviderChatHistoryMessage[] {
  return history.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    if (message.content.length === 0) {
      return [];
    }

    return [
      {
        role: message.role,
        content: message.content,
      },
    ];
  });
}

function countLatestTurnMessages(messages: ChatCompletionMessage[]): number {
  const lastMessage = messages.at(-1);

  if (!lastMessage) {
    return 0;
  }

  if (lastMessage.role !== 'tool') {
    return 1;
  }

  let count = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'tool') {
      break;
    }

    count += 1;
  }

  return count;
}

function normalizeToolCalls(
  toolCalls: ChatCompletionToolCall[] | undefined,
): ChatCompletionToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.filter(
    (toolCall) =>
      typeof toolCall?.id === 'string' &&
      typeof toolCall.function?.name === 'string',
  );
}

function normalizeMessageContent(
  content: string | ChatCompletionContentPart[] | null | undefined,
): string {
  if (content === null || content === undefined) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}
