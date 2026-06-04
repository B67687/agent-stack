# agent-stack

**ACP protocol + `omp acp` agent backend.** Powers AI-native editors via `omp acp`.

| Layer               | Technology                             | Status      |
| ------------------- | -------------------------------------- | ----------- |
| **Protocol**        | ACP (JSON-RPC 2.0 over stdio)          | ✅ Stable   |
| **Agent backend**   | `omp acp` — model routing, auth, MCP   | ✅ Live     |
| **Editor frontend** | [Zed](https://zed.dev) via HTTP bridge | ✅ Working  |
| ~~Legacy frontend~~ | ~~Terax AI (Tauri/Rust)~~              | ➡️ Archived |

## Architecture

```
Zed (or any OpenAI-compatible client)
  │  POST /v1/chat/completions (HTTP/SSE)
  ▼
omp-acp-bridge    ← this repo
  │  ACP (stdin/stdout JSON-RPC)
  ▼
omp acp           ← agent backend
  │  model routing, auth, tool execution
  ▼
Model API (DeepSeek, Anthropic, local, etc.)
```

## Quick Start

### 1. Install `omp`

```bash
npm install -g @oh-my-pi/pi-coding-agent
# or: bun install -g @oh-my-pi/pi-coding-agent
```

### 2. Configure models

Create `~/.omp/agent/models.yml`:

```yaml
modelRoles:
  default: opencode-go/deepseek-v4-pro
  smol: opencode-zen/deepseek-v4-flash-free
  slow: opencode-go/deepseek-v4-pro
  plan: opencode-zen/deepseek-v4-flash-free
  commit: opencode-go/qwen-3.6-plus
```

Set your API key:

```bash
export DEEPSEEK_API_KEY=sk-...   # or whatever your provider needs
```

### 3. Start the bridge

```bash
node omp-acp-bridge/bridge.mjs
# Listening on http://127.0.0.1:7654
```

### 4. Connect Zed

In Zed `settings.json`:

```json
{
  "assistant": {
    "provider": "open_ai",
    "model": "acp-agent",
    "open_ai": {
      "api_url": "http://localhost:7654/v1/chat/completions",
      "api_key": "any-value-works"
    }
  }
}
```

## How It Works

### ACP Protocol (stdin/stdout)

JSON-RPC 2.0 messages over stdin/stdout:

```
→ {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1},"id":1}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{...}}}

→ {"jsonrpc":"2.0","method":"session/new","params":{"cwd":"/","mcpServers":[]},"id":2}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"...","availableModes":[...]}}

→ {"jsonrpc":"2.0","method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"message"}]},"id":3}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"chunk"}}}}
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

### Bridge Layer

`omp-acp-bridge` translates OpenAI-compatible HTTP requests into ACP protocol:

| OpenAI (HTTP)                         | ACP (stdio)                       |
| ------------------------------------- | --------------------------------- |
| `POST /v1/chat/completions`           | `session/prompt`                  |
| `{"messages": [...], "stream": true}` | streaming `session/update` events |
| SSE `data: {...}` chunks              | `agent_message_chunk` content     |
| `data: [DONE]`                        | `stopReason: "end_turn"`          |

## Related

- [agent-ui-vscodium](https://github.com/B67687/agent-ui-vscodium) — VSCodium fork (legacy, archived approach)
- [omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) — the agent CLI
- [Zed](https://zed.dev) — recommended editor frontend
