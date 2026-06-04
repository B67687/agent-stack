import { spawn } from "node:child_process";
import http from "node:http";

const PORT = parseInt(process.env.PORT || "7654", 10);
const HOST = process.env.HOST || "127.0.0.1";
// Auto-add common paths for Windows (handles missing User PATH in some launch scenarios)
const EXTRA_PATHS = [
  "C:\\Users\\Namikaz\\AppData\\Roaming\\npm",
  "C:\\Users\\Namikaz\\.bun",
  "C:\\Program Files\\nodejs",
  "C:\\Users\\Namikaz\\.cargo\\bin",
].join(";");
process.env.PATH = EXTRA_PATHS + ";" + (process.env.PATH || "");

const OMP_CMD = process.env.OMP_CMD || "omp";
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "sk-b2563422f1a945f2a7e6eaeba41bb16f";

console.log("Bridge starting...");
console.log("OMP_CMD:", OMP_CMD);
console.log("DEEPSEEK_API_KEY set:", !!DEEPSEEK_API_KEY);

class AcpBridge {
  constructor() {
    this.child = null;
    this.buf = "";
  }

  async ensureSession() {
    if (this.child && !this.child.killed) return;

    console.log("Spawning omp acp...");
    this.child = spawn(OMP_CMD, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY,
        PATH:
          (process.env.PATH || "") +
          ";C:\\Users\\Namikaz\\AppData\\Roaming\\npm;C:\\Users\\Namikaz\\.bun",
      },
    });

    this.child.stderr.on("data", (d) =>
      console.error("ACP STDERR:", d.toString()),
    );
    this.child.on("exit", (code) => console.log("ACP exited:", code));
    this.buf = "";

    // Initialize
    console.log("Sending initialize...");
    await this.write({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 1 },
      id: 1,
    });
    const initResp = await this.readResponse(1);
    console.log("Init result:", initResp?.id === 1 ? "OK" : "FAIL");

    // Create session
    await this.write({
      jsonrpc: "2.0",
      method: "session/new",
      params: { cwd: "C:\\Users\\Namikaz", mcpServers: [] },
      id: 2,
    });
    const sessResp = await this.readResponse(2);
    this.sessionId = sessResp?.result?.sessionId;
    console.log("Session:", this.sessionId);
  }

  write(obj) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) return reject(new Error("stdin closed"));
      this.child.stdin.write(JSON.stringify(obj) + "\n", (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  readLine(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), timeout);
      const tryRead = () => {
        const idx = this.buf.indexOf("\n");
        if (idx >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          clearTimeout(timer);
          resolve(line || null);
          return;
        }
        this.child.stdout.once("data", (data) => {
          this.buf += data.toString();
          setImmediate(tryRead);
        });
      };
      this.child.stdout.on("data", (data) => {
        this.buf += data.toString();
        setImmediate(tryRead);
      });
    });
  }

  async readResponse(targetId, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const line = await this.readLine(5000);
      if (line === null) return null;
      try {
        const msg = JSON.parse(line);
        if (msg.id === targetId) return msg;
      } catch {}
    }
    return null;
  }

  async streamPrompt(messages, { onChunk, onDone, onError }) {
    await this.ensureSession();

    const id = Date.now();
    const prompt = messages.map((m) => ({
      type: "text",
      text: m.content || "",
    }));
    await this.write({
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { sessionId: this.sessionId, prompt },
      id,
    });

    let done = false;
    const start = Date.now();
    while (!done && Date.now() - start < 60000) {
      const line = await this.readLine(5000);
      if (line === null) break;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          done = true;
          onDone?.();
        } else if (msg.method === "session/update") {
          const u = msg.params?.update;
          if (
            u?.sessionUpdate === "agent_message_chunk" ||
            u?.sessionUpdate === "agent_message_complete"
          ) {
            onChunk?.(u?.content?.text || "");
          }
        } else if (msg.error) {
          done = true;
          onError?.(msg.error);
        }
      } catch {}
    }
    if (!done) onError?.({ message: "ACP timeout" });
  }
}

const bridge = new AcpBridge();
const server = http.createServer(async (req, res) => {
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
    res.end(JSON.stringify({ error: "Use POST /v1/chat/completions" }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "bad json" }));
    return;
  }

  const messages = request.messages || [];
  const stream = request.stream !== false;

  try {
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let fullText = "";
      await bridge.streamPrompt(messages, {
        onChunk(text) {
          fullText += text;
          res.write(
            `data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "acp-agent", choices: [{ delta: { content: text }, index: 0 }] })}\n\n`,
          );
        },
        onDone() {
          res.write("data: [DONE]\n\n");
          res.end();
        },
        onError(err) {
          res.write(
            `data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "acp-agent", choices: [{ delta: { content: `\nError: ${err.message || JSON.stringify(err)}` }, index: 0 }] })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        },
      });
    } else {
      let fullText = "";
      await bridge.streamPrompt(messages, {
        onChunk(text) {
          fullText += text;
        },
        onDone() {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
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
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
              },
            }),
          );
        },
        onError(err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || String(err) }));
        },
      });
    }
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    } else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bridge listening on http://${HOST}:${PORT}`);
  console.log(
    `Configure Zed: assistant.open_ai.api_url = http://${HOST}:${PORT}/v1/chat/completions`,
  );
});
