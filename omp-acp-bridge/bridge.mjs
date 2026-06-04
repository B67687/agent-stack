#!/usr/bin/env node
/**
 * omp-acp-bridge — OpenAI-compatible HTTP proxy for omp acp.
 *
 * Zed (or any OpenAI-compatible client) → this bridge → omp acp → model
 *
 * Usage:
 *   node bridge.mjs                    (listens on :7654)
 *   DEEPSEEK_API_KEY=sk-... node bridge.mjs
 *
 * Zed config (settings.json):
 *   "assistant": {
 *     "provider": "open_ai",
 *     "model": "acp-agent",
 *     "open_ai": {
 *       "api_url": "http://localhost:7654/v1/chat/completions",
 *       "api_key": "any-value-works"
 *     }
 *   }
 *
 * Protocol flow:
 *   OpenAI POST /v1/chat/completions (JSON)
 *     → translate messages → ACP session/prompt
 *     → read ACP update events
 *     → SSE stream or JSON response
 */

import { spawn } from "node:child_process";
import http from "node:http";

const PORT = parseInt(process.env.PORT || "7654", 10);
const HOST = process.env.HOST || "127.0.0.1";
const OMP_CMD = process.env.OMP_CMD || "omp";

// ── ACP session management ──────────────────────────────────────────────

class AcpManager {
  /** Map<sessionId, { child, reader, buf, created }> */
  #sessions = new Map();

  /**
   * Acquire or create an ACP session for a conversation key.
   * We use the first user message hash to identify conversations for simplicity.
   * In production you'd want proper session lifecycle management.
   */
  async acquireSession(convKey) {
    let session = this.#sessions.get(convKey);
    if (session && !session.child.killed) return session;
    return this.#createSession(convKey);
  }

  async #createSession(convKey) {
    const child = spawn(OMP_CMD, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const buf = { partial: "" };
    const reader = this.#makeReader(child, buf);

    // Initialize
    await this.#writeJson(child, {
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 1 },
      id: 1,
    });
    const initResp = await this.#readResponse(reader, buf, 1);
    if (!initResp) throw new Error("ACP init failed: no response");

    // Create session
    const cwd = process.cwd();
    await this.#writeJson(child, {
      jsonrpc: "2.0",
      method: "session/new",
      params: { cwd, mcpServers: [] },
      id: 2,
    });
    const sessResp = await this.#readResponse(reader, buf, 2);
    if (!sessResp) throw new Error("ACP session/new failed");
    const sessionId = sessResp.result?.sessionId;
    if (!sessionId) throw new Error("ACP session/new: no sessionId");

    const session = { child, reader, buf, sessionId, created: Date.now() };
    this.#sessions.set(convKey, session);
    return session;
  }

  /** Stream a prompt and call onChunk / onDone */
  async streamPrompt(session, messages, { onChunk, onDone, onError }) {
    const { child, reader, buf } = session;

    // Build the ACP prompt from OpenAI messages
    const prompt = this.#messagesToPrompt(messages);

    const id = Date.now();
    await this.#writeJson(child, {
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { sessionId: session.sessionId, prompt },
      id,
    });

    let done = false;
    while (!done) {
      const line = await this.#readLine(reader, buf);
      if (line === null) break; // EOF

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Final response
      if (msg.id === id) {
        done = true;
        onDone?.(msg.result);
        continue;
      }

      // Streaming update
      if (msg.method === "session/update") {
        const update = msg.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk") {
          onChunk?.(update.content?.text || "");
        }
        if (update?.sessionUpdate === "agent_message_complete") {
          onChunk?.(update.content?.text || "");
        }
      }

      // Error
      if (msg.error) {
        done = true;
        onError?.(msg.error);
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  #messagesToPrompt(messages) {
    // OpenAI messages → ACP prompt format
    // ACP accepts [{ type: "text", text: "..." }]
    const parts = [];
    for (const m of messages) {
      if (m.role === "system") {
        parts.push({
          type: "text",
          text: `[System instruction]\n${m.content}`,
        });
      } else if (m.role === "user") {
        parts.push({ type: "text", text: m.content });
      } else if (m.role === "assistant") {
        parts.push({
          type: "text",
          text: `[Assistant response]\n${m.content}`,
        });
      }
    }
    return parts;
  }

  #makeReader(child, buf) {
    child.stdout.on("data", (data) => {
      buf.partial += data.toString();
    });
    return child.stdout;
  }

  async #writeJson(child, obj) {
    return new Promise((resolve, reject) => {
      if (!child.stdin) return reject(new Error("stdin closed"));
      child.stdin.write(JSON.stringify(obj) + "\n", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async #readLine(reader, buf) {
    // Read until newline from the buffered stream
    return new Promise((resolve) => {
      const tryRead = () => {
        const idx = buf.partial.indexOf("\n");
        if (idx >= 0) {
          const line = buf.partial.slice(0, idx).trim();
          buf.partial = buf.partial.slice(idx + 1);
          resolve(line || null);
          return;
        }
        // Wait for more data
        reader.once("data", () => setImmediate(tryRead));
      };
      setImmediate(tryRead);
    });
  }

  async #readResponse(reader, buf, targetId, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const line = await this.#readLine(reader, buf);
      if (line === null) return null;
      try {
        const msg = JSON.parse(line);
        if (msg.id === targetId) return msg;
        if (msg.id && msg.error) return msg; // error response
      } catch {
        continue;
      }
    }
    return null;
  }

  dispose() {
    for (const [, s] of this.#sessions) {
      if (!s.child.killed) {
        try {
          s.child.stdin?.end();
        } catch {}
        try {
          s.child.kill();
        } catch {}
      }
    }
    this.#sessions.clear();
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const acp = new AcpManager();

const server = http.createServer(async (req, res) => {
  // CORS (Zed needs this)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || !req.url.includes("/v1/chat/completions")) {
    res.writeHead(404);
    res.end(
      JSON.stringify({ error: "Not found. Use POST /v1/chat/completions" }),
    );
    return;
  }

  // Read request body
  let body = "";
  for await (const chunk of req) body += chunk;

  let request;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const messages = request.messages || [];
  const stream = request.stream !== false;
  const convKey = `conv-${messages
    .map((m) => m.content?.slice(0, 40))
    .join("|")
    .slice(0, 100)}`;

  try {
    const session = await acp.acquireSession(convKey);

    if (stream) {
      // SSE streaming response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let fullText = "";

      await acp.streamPrompt(session, messages, {
        onChunk(text) {
          fullText += text;
          const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "acp-agent",
            choices: [{ delta: { content: text }, index: 0 }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        onDone(result) {
          res.write(`data: [DONE]\n\n`);
          res.end();
        },
        onError(err) {
          const errChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "acp-agent",
            choices: [
              {
                delta: {
                  content: `\n\nError: ${err.message || JSON.stringify(err)}`,
                },
                index: 0,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        },
      });
    } else {
      // Non-streaming response
      let fullText = "";

      await acp.streamPrompt(session, messages, {
        onChunk(text) {
          fullText += text;
        },
        onDone() {
          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "acp-agent",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: fullText },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        },
        onError(err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || String(err) }));
        },
      });
    }
  } catch (err) {
    console.error("Bridge error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`omp-acp-bridge listening on http://${HOST}:${PORT}`);
  console.log(
    `Zed config → assistant.open_ai.api_url: http://${HOST}:${PORT}/v1/chat/completions`,
  );
});

// Cleanup on exit
process.on("SIGINT", () => {
  acp.dispose();
  server.close();
  process.exit();
});
process.on("SIGTERM", () => {
  acp.dispose();
  server.close();
  process.exit();
});
