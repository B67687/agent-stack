# agent-stack

**ACP protocol + `omp acp` agent stack.** Powers AI-native editor UIs — integrates with [Terax AI](https://github.com/crynta/terax-ai) and custom frontends.

| Layer               | Status                                                          |
| ------------------- | --------------------------------------------------------------- |
| Rust backend        | ✅ `cargo check` — 0 errors                                     |
| TypeScript frontend | ✅ `tsc --noEmit` — 0 errors                                    |
| ACP `omp acp`       | ✅ `initialize` → `session/new` → `session/prompt` → streaming  |
| Model routing       | ✅ DeepSeek V4 Pro / Flash / Qwen via `~/.omp/agent/models.yml` |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Terax AI Frontend                                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Provider: "acp" │ Model: "acp-agent"                      │  │
│  │                                                             │  │
│  │  agent.ts → invoke("acp_initialize")                        │  │
│  │          → invoke("acp_send", "session/new")                │  │
│  │          → invoke("acp_send_stream", {sessionId, text,     │  │
│  │                                on_event: Channel})          │  │
│  │                                     │                       │  │
│  │  Channel<AcpStreamEvent> ◄──────────┘                       │  │
│  │    Chunk {text} ← session/update (streaming)                │  │
│  │    End          ← final response                            │  │
│  │    Error {msg}  ← on failure                                │  │
│  └──────────────────┬─────────────────────────────────────────┘  │
│                     │ Tauri IPC invoke                            │
├─────────────────────┼────────────────────────────────────────────┤
│  Rust Backend       │                                            │
│  ┌──────────────────▼─────────────────────────────────────────┐  │
│  │  acp.rs                                                    │  │
│  │  acp_initialize → spawn "omp acp", send initialize         │  │
│  │  acp_send       → write stdin, read stdout (request/response)│  │
│  │  acp_send_stream → write stdin, stream stdout line-by-line  │  │
│  │                    forward session/update as Chunk events    │  │
│  │  acp_dispose    → kill process                              │  │
│  └──────────────────┬─────────────────────────────────────────┘  │
│                     │ stdio (pipe)                                │
├─────────────────────┼────────────────────────────────────────────┤
│  System             │                                            │
│  ┌──────────────────▼─────────────────────────────────────────┐  │
│  │  omp acp (Agent Communication Protocol)                     │  │
│  │  initialize → session/new → session/prompt                  │  │
│  │  ← streaming session/update (agent_message_chunk)           │  │
│  │  ← final response (stopReason: end_turn)                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ~/.omp/agent/models.yml                                   │  │
│  │  default: opencode-go/deepseek-v4-pro                      │  │
│  │  smol/plan: opencode-zen/deepseek-v4-flash-free            │  │
│  │  commit: opencode-go/qwen-3.6-plus                         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## ACP Protocol (JSON-RPC 2.0 over stdio)

```json
→ {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1},"id":1}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{...}}}

→ {"jsonrpc":"2.0","method":"session/new","params":{"cwd":"/","mcpServers":[]},"id":2}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"...","availableModes":[...]}}

→ {"jsonrpc":"2.0","method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"message"}]},"id":3}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"chunk"}}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"...thinking..."}}}}
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

## Terax AI Integration

### Rust Backend (`src-tauri/src/modules/acp.rs`)

| Command           | Type             | Description                                                                                                                 |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `acp_initialize`  | Request/Response | Spawns `omp acp`, sends `initialize`, returns agent info                                                                    |
| `acp_send`        | Request/Response | Generic JSON-RPC (used for `session/new`, etc.)                                                                             |
| `acp_send_stream` | **Streaming**    | Sends `session/prompt`, reads stdout line-by-line, forwards `session/update` as `AcpStreamEvent::Chunk` via Tauri `Channel` |
| `acp_dispose`     | Fire-and-forget  | Kills the ACP process                                                                                                       |

### Frontend (`src/modules/ai/`)

| File                      | Change                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `config.ts`               | Added `"acp"` ProviderId, provider info, `acp-agent` model, keyless, context limit                       |
| `agent.ts`                | Added `case "acp"` — creates `Channel<AcpStreamEvent>`, pipes chunks into Vercel AI SDK `ReadableStream` |
| `keyring.ts`              | Added `acp: null` to default keys                                                                        |
| `ProviderIcon.tsx`        | Added ACP icon                                                                                           |
| `AiStatusBarControls.tsx` | Added ACP icon                                                                                           |

## Prerequisites

```bash
# Install omp (agent runtime) — requires bun
curl -fsSL https://bun.sh/install | bash
bun install -g @oh-my-pi/pi-coding-agent

# Model routing config
mkdir -p ~/.omp/agent
```

## Quick Test

```bash
# Verify ACP works standalone
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1},"id":1}' | omp acp
# → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,...}}
```

## Build & Run

```bash
cd terax-ai   # clone from github.com/crynta/terax-ai
pnpm install
cd src-tauri && cargo check      # 0 errors
cd .. && pnpm tauri dev           # launch
# Settings → AI → select "ACP Agent"
```

## Related Repos

| Repo                                                             | What                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **agent-stack** ← you are here                                   | ACP protocol + omp acp integration                                        |
| [agent-ui-vscodium](https://github.com/B67687/agent-ui-vscodium) | Previous iteration: VSCodium fork with native Agent Panel + Inline Prompt |
| [agentic-workflows](https://github.com/B67687/agentic-workflows) | Orchestration harness, session archive, agent memory                      |
