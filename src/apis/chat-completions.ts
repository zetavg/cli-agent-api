import type { Request, Response } from 'express';

import {
  type ChatCompletionMessage,
  extractLatestUserPrompt,
  extractSystemPrompt,
} from '../messages.js';
import {
  type ChatCompletionReasoningDetail,
  type ChatCompletionsRequestBody,
  createChatCompletionResponse,
  createChatCompletionStreamChunk,
  createChatCompletionUsageStreamChunk,
  toSseData,
} from '../openai.js';
import type { AgentProvider } from '../providers.js';

import type { ApiHandler } from './types.js';

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
) {
  const result = await prepareChatCompletion(
    provider,
    request.body as ChatCompletionsRequestBody,
    signal,
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
) {
  const messages = normalizeMessages(body.messages);
  const prompt = extractLatestUserPrompt(messages);
  const systemPrompt = extractSystemPrompt(messages);
  const run = provider.createChatCompletion(
    {
      model: typeof body.model === 'string' ? body.model : undefined,
      prompt,
      systemPrompt,
    },
    signal,
  );

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

export async function collectChatCompletion(
  providerRun: ReturnType<AgentProvider['createChatCompletion']>,
) {
  let content = '';
  let finishReason: 'stop' | 'length' = 'stop';
  let usage;
  let reasoningText = '';
  const reasoningDetails = new Map<string, ChatCompletionReasoningDetail>();

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

  return createChatCompletionResponse(
    providerRun.metadata,
    content,
    finishReason,
    usage,
    reasoningText.length > 0 ? reasoningText : undefined,
    reasoningDetails.size > 0
      ? [...reasoningDetails.values()].sort((a, b) => a.index - b.index)
      : undefined,
  );
}

export async function* serializeChatCompletionStream(
  providerRun: ReturnType<AgentProvider['createChatCompletion']>,
) {
  let sentRoleChunk = false;
  let usage;

  for await (const event of providerRun.events) {
    if (event.type === 'response.metadata') {
      providerRun.metadata.model = event.model;
      continue;
    }

    if (!sentRoleChunk) {
      yield toSseData(
        createChatCompletionStreamChunk(providerRun.metadata, {
          role: 'assistant',
        }),
      );
      sentRoleChunk = true;
    }

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

    yield toSseData(
      createChatCompletionStreamChunk(
        providerRun.metadata,
        {},
        event.finishReason,
      ),
    );
  }

  if (!sentRoleChunk) {
    yield toSseData(
      createChatCompletionStreamChunk(providerRun.metadata, {
        role: 'assistant',
      }),
    );
  }

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
