# agent-stack

**ACP protocol + `omp acp` agent stack.** Powers AI-native editor UIs — integrates with Terax AI and custom frontends.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Frontend (Terax AI / Custom)                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Provider: "acp"                                      │  │
│  │  Model: "acp-agent"                                   │  │
│  │  → invoke("acp_initialize")                           │  │
│  │  → invoke("acp_send", "session/new")                  │  │
│  │  → invoke("acp_send", "session/prompt")               │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
├─────────────────────┼───────────────────────────────────────┤
│  Rust Backend       │                                       │
│  ┌──────────────────▼────────────────────────────────────┐  │
│  │  acp.rs — Tauri commands                              │  │
│  │  spawn → omp acp → stdin/stdout → JSON-RPC 2.0       │  │
│  └──────────────────┬────────────────────────────────────┘  │
│                     │                                       │
├─────────────────────┼───────────────────────────────────────┤
│  System             │                                       │
│  ┌──────────────────▼────────────────────────────────────┐  │
│  │  omp acp (Agent Communication Protocol)                │  │
│  │  initialize → session/new → session/prompt             │  │
│  │  ← streaming session/update events                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ~/.omp/agent/models.yml                             │  │
│  │  default: opencode-go/deepseek-v4-pro                │  │
│  │  smol/plan: opencode-zen/deepseek-v4-flash-free      │  │
│  │  commit: opencode-go/qwen-3.6-plus                   │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## ACP Protocol (JSON-RPC 2.0 over stdio)

```json
→ {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1},"id":1}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{...}}}

→ {"jsonrpc":"2.0","method":"session/new","params":{"cwd":"/","mcpServers":[]},"id":2}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"...","availableModes":[...]}}

→ {"jsonrpc":"2.0","method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"message"}]},"id":3}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"chunk"}}}}
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

## Terax AI Integration

**Rust** (`src-tauri/src/modules/acp.rs`):
- `acp_initialize` — spawns `omp acp`, sends initialize
- `acp_send` — sends JSON-RPC request via stdin, reads response from stdout
- `acp_dispose` — kills the ACP process

**Frontend** (`src/modules/ai/`):
- `config.ts` — `"acp"` ProviderId, provider info, model entry, keyless
- `agent.ts` — `case "acp"` calling Tauri invoke commands

## Prerequisites

```bash
# Install omp (agent runtime)
curl -fsSL https://bun.sh/install | bash
bun install -g @oh-my-pi/pi-coding-agent

# Model routing config
mkdir -p ~/.omp/agent
# Copy models.yml to ~/.omp/agent/models.yml
```

## Quick Test

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1},"id":1}' | omp acp
# → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,...}}
```

## Repos

- **agent-stack** ← you are here
- **agent-ui-vscodium** — previous iteration: VSCodium fork with native Agent Panel + Inline Prompt
- **agentic-workflows** — orchestration harness, session archive, agent memory
