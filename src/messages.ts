export interface ChatCompletionMessage {
  role: string;
  content: string | ChatCompletionContentPart[];
}

export interface ChatCompletionContentPart {
  type: string;
  text?: string;
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
