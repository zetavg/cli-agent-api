import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

import {
  type ChatCompletionMessage,
  extractConversationHistory,
  extractLatestTurn,
  extractSystemPrompt,
} from '../messages.js';
import {
  type ChatCompletionFinishReason,
  type ChatCompletionReasoningDetail,
  type ChatCompletionResponseToolCall,
  type ChatCompletionsRequestBody,
  type ChatCompletionUsage,
  createChatCompletionResponse,
  createChatCompletionStreamChunk,
  createChatCompletionUsageStreamChunk,
  toSseData,
} from '../openai.js';
import type {
  AgentProvider,
  ProviderChatCompletionInput,
} from '../providers.js';
import {
  formatHistoryForBridge,
  formatToolResultsForPrompt,
} from '../tool-bridge.js';

import type { ApiHandler, ApiHandlerContext } from './types.js';

export const chatCompletionsHandler: ApiHandler = {
  method: 'post',
  path: '/v1/chat/completions',
  handle: handleChatCompletions,
};

export async function handleChatCompletions(
  request: Request,
  response: Response,
  provider: AgentProvider,
  signal: AbortSignal,
  context: ApiHandlerContext = {},
) {
  const result = await prepareChatCompletion(
    provider,
    request.body as ChatCompletionsRequestBody,
    signal,
    { toolMode: context.toolMode },
  );

  if (result.type === 'stream') {
    await streamChatCompletion(response, result.run);
    return;
  }

  response.json(result.body);
}

export function normalizeMessages(value: unknown): ChatCompletionMessage[] {
  if (!Array.isArray(value)) {
    throw new Error('`messages` must be an array.');
  }

  return value as ChatCompletionMessage[];
}

export async function prepareChatCompletion(
  provider: AgentProvider,
  body: ChatCompletionsRequestBody,
  signal: AbortSignal,
  options: { toolMode?: 'native' | 'bridge' } = {},
) {
  const messages = normalizeMessages(body.messages);
  const systemPrompt = extractSystemPrompt(messages);
  const latestTurn = extractLatestTurn(messages);
  const conversation = extractConversationHistory(messages);

  const bridge =
    (options.toolMode ?? 'native') === 'bridge' &&
    Array.isArray(body.tools) &&
    body.tools.length > 0;

  const prompt =
    latestTurn.kind === 'user'
      ? latestTurn.text
      : bridge
        ? formatToolResultsForPrompt(latestTurn.items)
        : latestTurn.items.map((item) => item.content).join('\n\n');

  const history = bridge
    ? formatHistoryForBridge(conversation)
    : conversation.flatMap((message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.length > 0
          ? [{ role: message.role, content: message.content }]
          : [],
      );

  const input: ProviderChatCompletionInput = {
    model: typeof body.model === 'string' ? body.model : undefined,
    prompt,
    systemPrompt,
    history,
  };

  if (bridge) {
    input.tools = body.tools;
    input.toolMode = 'bridge';
  }

  const run = provider.createChatCompletion(input, signal);

  if (body.stream === true) {
    return {
      type: 'stream' as const,
      run,
    };
  }

  return {
    type: 'json' as const,
    body: await collectChatCompletion(run),
  };
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

export async function collectChatCompletion(
  providerRun: ReturnType<AgentProvider['createChatCompletion']>,
) {
  let content = '';
  let finishReason: ChatCompletionFinishReason = 'stop';
  let usage: ChatCompletionUsage | undefined;
  let reasoningText = '';
  const reasoningDetails = new Map<string, ChatCompletionReasoningDetail>();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolCallOrder: number[] = [];

  for await (const event of providerRun.events) {
    if (event.type === 'response.metadata') {
      providerRun.metadata.model = event.model;
      continue;
    }

    if (event.type === 'response.output_text.delta') {
      content += event.text;
      continue;
    }

    if (event.type === 'response.output_tool_call.delta') {
      let entry = toolCalls.get(event.toolCallIndex);

      if (!entry) {
        entry = { arguments: '' };
        toolCalls.set(event.toolCallIndex, entry);
        toolCallOrder.push(event.toolCallIndex);
      }

      if (event.toolCallId !== undefined) {
        entry.id = event.toolCallId;
      }

      if (event.toolName !== undefined) {
        entry.name = event.toolName;
      }

      if (event.toolArguments !== undefined) {
        entry.arguments += event.toolArguments;
      }

      continue;
    }

    if (event.type === 'response.output_tool_result.delta') {
      continue;
    }

    if (event.type === 'response.output_reasoning.delta') {
      if (event.reasoningText) {
        reasoningText += event.reasoningText;
      }

      const existing = reasoningDetails.get(event.reasoningId);

      reasoningDetails.set(event.reasoningId, {
        type: 'reasoning.text',
        id: event.reasoningId,
        format: event.format,
        index: event.reasoningIndex,
        text: `${existing?.text ?? ''}${event.reasoningText ?? ''}`,
        signature: event.signature ?? existing?.signature ?? null,
      });
      continue;
    }

    finishReason = event.finishReason;
    usage = event.usage;
  }

  const assembledToolCalls: ChatCompletionResponseToolCall[] = toolCallOrder
    .map((index) => toolCalls.get(index))
    .filter((entry): entry is ToolCallAccumulator => entry?.name !== undefined)
    .map((entry) => ({
      id: entry.id ?? `call_${randomUUID().replaceAll('-', '')}`,
      type: 'function',
      function: {
        name: entry.name as string,
        arguments: entry.arguments,
      },
    }));

  return createChatCompletionResponse(
    providerRun.metadata,
    content,
    finishReason,
    usage,
    reasoningText.length > 0 ? reasoningText : undefined,
    reasoningDetails.size > 0
      ? [...reasoningDetails.values()].sort((a, b) => a.index - b.index)
      : undefined,
    assembledToolCalls.length > 0 ? assembledToolCalls : undefined,
  );
}

export async function* serializeChatCompletionStream(
  providerRun: ReturnType<AgentProvider['createChatCompletion']>,
) {
  let sentRoleChunk = false;
  let usage: ChatCompletionUsage | undefined;
  let finishReason: ChatCompletionFinishReason = 'stop';

  const ensureRoleChunk = function* () {
    if (!sentRoleChunk) {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          role: 'assistant',
        }),
      );
      sentRoleChunk = true;
    }
  };

  for await (const event of providerRun.events) {
    if (event.type === 'response.metadata') {
      providerRun.metadata.model = event.model;
      continue;
    }

    yield* ensureRoleChunk();

    if (event.type === 'response.output_text.delta') {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          content: event.text,
        }),
      );
      continue;
    }

    if (event.type === 'response.output_tool_call.delta') {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          tool_calls: [
            {
              index: event.toolCallIndex,
              id: event.toolCallId,
              type:
                event.toolCallId !== undefined || event.toolName !== undefined
                  ? 'function'
                  : undefined,
              function:
                event.toolName !== undefined ||
                event.toolArguments !== undefined
                  ? {
                      name: event.toolName,
                      arguments: event.toolArguments,
                    }
                  : undefined,
            },
          ],
        }),
      );
      continue;
    }

    if (event.type === 'response.output_tool_result.delta') {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          tool_calls: [
            {
              index: event.toolCallIndex,
              id: event.toolCallId,
              result: event.toolOutput,
            },
          ],
        }),
      );
      continue;
    }

    if (event.type === 'response.output_reasoning.delta') {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          reasoning: event.reasoningText,
          reasoning_content: event.reasoningText,
          reasoning_details: [
            {
              type: 'reasoning.text',
              id: event.reasoningId,
              format: event.format,
              index: event.reasoningIndex,
              text: event.reasoningText,
              signature: event.signature ?? null,
            },
          ],
        }),
      );
      continue;
    }

    usage = event.usage;
    finishReason = event.finishReason;
  }

  yield* ensureRoleChunk();

  yield toSseData(
    createChatCompletionStreamChunk(providerRun.metadata, {}, finishReason),
  );

  yield toSseData(
    createChatCompletionUsageStreamChunk(providerRun.metadata, usage),
  );
  yield 'data: [DONE]\n\n';
}

async function streamChatCompletion(
  response: Response,
  providerRun: ReturnType<AgentProvider['createChatCompletion']>,
) {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  for await (const chunk of serializeChatCompletionStream(providerRun)) {
    response.write(chunk);
  }

  response.end();
}
