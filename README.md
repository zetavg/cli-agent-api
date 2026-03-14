# cli-agent-api

Wrap CLI coding agents behind OpenAI-style APIs.

## MVP scope

- Claude Code only
- `POST /claude/v1/chat/completions`
- Streaming and non-streaming responses
- Only the last message is forwarded to the CLI

## Run

```bash
pnpm exec cli-agent-api serve
```

Options:

- `--host` defaults to `127.0.0.1` or `HOST`
- `--port` defaults to `8041` or `PORT`
- `--api-key` reads comma-separated bearer tokens from the flag or `API_KEY`

Example:

```bash
cli-agent-api serve --port 8041 --api-key alpha,beta
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
      { "role": "developer", "content": [{ "type": "text", "text": "Ignored" }] },
      { "role": "user", "content": [{ "type": "text", "text": "Hello there!" }] }
    ]
  }'
```

Only the final `messages` entry is converted into the Claude CLI prompt.

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
