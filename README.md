# cli-agent-api

Wrap CLI coding agents behind OpenAI-style APIs.

## MVP scope

- Claude Code and Cursor CLI
- `POST /claude/v1/chat/completions`
- `POST /cursor/v1/chat/completions`
- Streaming and non-streaming responses
- Generic route shape is `/:provider/<rest>`; `claude` and `cursor` both implement `/v1/chat/completions` today

## Requirements

- Node.js 22+
- `pnpm`
- `claude` available on `PATH` (for the `claude` provider)
- `cursor-agent` or `cursor` available on `PATH` (for the `cursor` provider)

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
- `--tool-mode` is `native` (default) or `bridge`, falling back to `TOOL_MODE`

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

- The last message is used as the new turn:
  - a `user` message becomes the new prompt (it must contain text content)
  - one or more trailing `tool` messages are treated as the results of an in-progress tool call loop (see [Tool modes](#tool-modes)) instead of a prompt
- `system` and `developer` messages are not written into Claude history; their text is concatenated and forwarded to Claude as `--system-prompt`
- Earlier text `user` and `assistant` messages are serialized into a synthetic Claude session under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- When prior history exists, Claude is invoked with `--resume <session-id>` plus the new prompt
- Non-text or unsupported history messages are ignored during session seeding (in `native` mode)

## Tool modes

CLI coding agents drive their own built-in tools: `claude -p` and `cursor-agent -p` run a tool inline and return a final answer. The OpenAI Chat Completions API is the opposite — it is **client-driven**: the server proposes a tool call, halts with `finish_reason: "tool_calls"`, the client executes the tool, posts the result back as a `role: "tool"` message, and the server resumes. The `--tool-mode` flag picks how the server reconciles the two:

### `native` (default)

The agent uses its own built-in tools. Any `tools` array in the request is ignored. This is best for chat-style UIs (for example Open WebUI) where you want the agent to act autonomously. Behavior is unchanged from earlier versions.

### `bridge`

When a request includes a non-empty `tools` array, the server exposes **the client's tools** to the agent instead of the agent's own, so editor coding agents (VS Code Copilot Chat, Cursor IDE, OpenAI agent SDKs) keep control of execution. A request with no `tools` still falls back to native behavior.

Because the CLIs have no native hook for externally executed tools, the bridge teaches the model a sentinel-delimited protocol through the system prompt and parses it back into standard OpenAI `tool_calls`:

- The tool definitions are injected into the system prompt with instructions to call them by emitting:

  ```text
  <<<TOOL_CALL>>>
  {"id": "<id>", "name": "<tool name>", "arguments": { ... }}
  <<<END_TOOL_CALL>>>
  ```

- The server parses those blocks out of the model's streamed text and re-emits them as OpenAI `delta.tool_calls` (and `message.tool_calls` for non-streaming), ending the response with `finish_reason: "tool_calls"`.
- **The agent is stopped at the tool-call boundary.** A `claude -p` / `cursor-agent -p` process is a single-shot text generator with no built-in halt after a tool call, so left alone it tends to keep going and *fabricate* the tool's result (and the next steps) inline. To prevent that, the moment the parser sees a tool call followed by the model continuing with other text, the server kills the agent subprocess — mirroring how native function-calling halts token generation at the tool call. The client then executes the real tool and the loop continues on the next request.
- On the follow-up request, the client's `role: "tool"` results are formatted back into `<<<TOOL_RESULT id="...">>> ... <<<END_TOOL_RESULT>>>` blocks and fed to the agent (via `--resume` plus the new turn), so the loop continues.

Provider specifics in `bridge` mode:

- **Claude** is started with `--tools ""`, which disables every built-in tool, so the model can only call the client's tools through the protocol.
- **Cursor** has no flag to disable its built-in tools. The bridge relies on a stronger system-prompt override telling the model to ignore any previously provided tools and use only the bridged ones. This is best-effort — Cursor may still fall back to its own tools on some tasks. Prefer the `claude` provider for editor coding agents.

Reasoning/"thinking" output is not specially surfaced in either mode yet; that is planned alongside a future `/v1/responses` endpoint (the Responses API has a native place for reasoning items).

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

## Cursor behavior

The `cursor` provider wraps the Cursor CLI in print mode with stream-json output.

Equivalent CLI flags:

```bash
cursor-agent -p \
  --output-format stream-json \
  --stream-partial-output \
  --trust
```

- The CLI command is resolved by preferring `cursor-agent` on `PATH`, then falling back to `cursor agent`, then to known install locations (`/opt/homebrew/bin/cursor-agent`, `~/.local/bin/cursor-agent`, `~/.local/bin/cursor`). Both invocation styles share one argument builder.
- The model is forwarded with `--model` when provided. Use a slug from `cursor-agent --list-models` (for example `gpt-5`, `sonnet-4`, `composer-2.5`); when omitted, Cursor uses the account default.
- Cursor has no `--system-prompt` flag, so `system` and `developer` message text is prepended to the prompt for fresh sessions.
- Cursor stores chat history in an opaque database that cannot be seeded. Multi-turn continuity is handled by mapping a hash of the conversation history to the Cursor session id and resuming it with `--resume`. On a cache miss with prior history (cold start), the history is flattened into the prompt instead.
- Tool permissions: `--trust` is always passed for the managed workspace. In headless print mode, read-only tools run automatically and write/shell tools are rejected unless approved. Set `CURSOR_FORCE=1` to add `--force` (Run Everything); note that organization policy may disable this.

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

The same request against the `cursor` provider:

```bash
curl http://127.0.0.1:8041/cursor/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer alpha' \
  -d '{
    "model": "gpt-5",
    "stream": true,
    "messages": [
      { "role": "developer", "content": [{ "type": "text", "text": "You are an AI agent." }] },
      { "role": "user", "content": [{ "type": "text", "text": "Hello there!" }] }
    ]
  }'
```

This becomes roughly:

```bash
cursor-agent -p ... --model "gpt-5" "You are an AI agent.

Hello there!"
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
- Exported providers are Claude and Cursor

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

## Release and publish

Create a local package tarball:

```bash
pnpm run pack-package
```

Publish an existing tarball:

```bash
pnpm run publish-packed-package --tag latest
```

GitHub Actions now provides:

- `Checks` for lint, typecheck, and test
- `Pack Package` to build and upload `package.tgz`
- `Pack and Publish Package` to run checks, pack, and publish on GitHub release publish or manual dispatch

For GitHub Actions publishing, configure the `NPM` environment on the repository:

- `NPM_REGISTRY_SERVER` variable when publishing to a non-default registry
- `NPM_AUTH_TOKEN` secret when not using npm trusted publishing
