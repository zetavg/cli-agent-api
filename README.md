# cli-agent-api

Wrap CLI coding agents behind OpenAI-style APIs.

## MVP scope

- Claude Code only
- `POST /claude/v1/chat/completions`
- Streaming and non-streaming responses
- Generic route shape is `/:provider/<rest>`, but only `claude` + `/v1/chat/completions` is implemented today

## Requirements

- Node.js 22+
- `pnpm`
- `claude` available on `PATH`

Path defaults:

- `XDG_DATA_HOME` defaults to `$HOME/.local/share`
- `DATA_DIR` defaults to `$XDG_DATA_HOME/cli-agent-api`
- Claude is started with `cwd` set to `$DATA_DIR/agent-workspace`
- The server creates `$DATA_DIR` and `$DATA_DIR/agent-workspace` automatically when needed

## Run

```bash
pnpm exec cli-agent-api serve
```

Options:

- `--host` defaults to `127.0.0.1` or `HOST`
- `--port` defaults to `8041` or `PORT`
- `--api-key` reads comma-separated bearer tokens from the flag or `API_KEY`

Authentication is disabled when no API key is configured. When enabled, requests must send `Authorization: Bearer <token>`.

Example:

```bash
cli-agent-api serve --port 8041 --api-key alpha,beta
```

The server writes newline-delimited JSON logs to stdout. Every line includes `timestamp`, `level`, `event`, and `message`.

## HTTP behavior

- CORS is currently open to all origins with `Access-Control-Allow-Origin: *`
- `OPTIONS` preflight requests are handled automatically
- Unsupported providers return `404 provider_not_found`
- Unsupported provider routes return `404 not_found`

The permissive CORS policy is convenient for browser-based clients like Open WebUI, but it is less safe. If you expose the server beyond localhost, use API keys at minimum.

## Request behavior

- The last message is used as the new Claude prompt
- The last message must contain text content
- `system` and `developer` messages are not written into Claude history; their text is concatenated and forwarded to Claude as `--system-prompt`
- Earlier text `user` and `assistant` messages are serialized into a synthetic Claude session under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- When prior history exists, Claude is invoked with `--resume <session-id>` plus the new prompt
- Non-text or unsupported history messages are ignored during session seeding

## Claude behavior

Claude is invoked in print mode with stream-json output and these default tools enabled:

- `WebSearch`
- `WebFetch`

Equivalent CLI flags:

```bash
claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --tools "WebSearch WebFetch" \
  --allowedTools "WebSearch WebFetch"
```

## Request example

```bash
curl http://127.0.0.1:8041/claude/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer alpha' \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [
      { "role": "developer", "content": [{ "type": "text", "text": "You are an AI agent." }] },
      { "role": "user", "content": [{ "type": "text", "text": "Hello there!" }] }
    ]
  }'
```

This becomes roughly:

```bash
claude ... --system-prompt "You are an AI agent." "Hello there!"
```

## Response behavior

Non-streaming responses return standard chat completion objects plus:

- `usage` is always present
- OpenAI-style token fields are included
- extra Claude usage fields are preserved when available, such as cost, duration, quota, or provider-specific metadata

Streaming responses return SSE chat completion chunks and always end with:

- a final chunk containing `finish_reason`
- a separate final chunk with `choices: []` and `usage`
- `data: [DONE]`

## Streaming extensions

The server currently emits a few nonstandard Chat Completions fields because Claude Code exposes richer agent state than the base API:

- `delta.reasoning`
- `delta.reasoning_content`
- `delta.reasoning_details`
- `delta.tool_calls`
- `delta.tool_calls[].result`

The matching non-streaming assistant message may also include:

- `message.reasoning`
- `message.reasoning_content`
- `message.reasoning_details`

These fields are useful for compatible clients, but generic OpenAI-compatible UIs may ignore them. In particular, `tool_calls[].result` is not part of the standard OpenAI tool-calling flow.

## Architecture notes

- Provider-specific process management lives under `src/providers/`
- API surface handlers live under `src/apis/`
- The server is wired through handler/provider registries so adding `/v1/responses` or new providers should not require rewriting the core server
- Current exported provider support is Claude only

## Development

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm build
```
