import type { ProviderChatHistoryMessage } from './providers.js';

export interface ChatCompletionMessage {
  role: string;
  content: string | ChatCompletionContentPart[];
}

export interface ChatCompletionContentPart {
  type: string;
  text?: string;
}

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

export function extractLatestUserPrompt(
  messages: ChatCompletionMessage[],
): string {
  const lastMessage = messages.at(-1);

  if (!lastMessage) {
    throw new Error('`messages` must contain at least one message.');
  }

  const prompt = normalizeMessageContent(lastMessage.content).trim();

  if (prompt.length === 0) {
    throw new Error('The last message must contain text content.');
  }

  return prompt;
}

export function extractConversationHistory(
  messages: ChatCompletionMessage[],
): ProviderChatHistoryMessage[] {
  const conversationMessages = messages.filter(
    (message) => message.role !== 'system' && message.role !== 'developer',
  );

  if (conversationMessages.length <= 1) {
    return [];
  }

  return conversationMessages.slice(0, -1).flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    const content = normalizeMessageContent(message.content).trim();

    if (content.length === 0) {
      return [];
    }

    return [
      {
        role: message.role,
        content,
      },
    ];
  });
}

function normalizeMessageContent(
  content: string | ChatCompletionContentPart[],
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}
