import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";

process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));

// Auto-configure PATH for Windows
if (os.platform() === "win32") {
  const EXTRA = [
    "C:\\Users\\Namikaz\\AppData\\Roaming\\npm",
    "C:\\Users\\Namikaz\\.bun",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\Namikaz\\.cargo\\bin",
  ].join(";");
  process.env.PATH = EXTRA + ";" + (process.env.PATH || "");
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "sk-b2563422f1a945f2a7e6eaeba41bb16f";
}

// On Windows, spawn via cmd.exe to handle .cmd files correctly
const IS_WIN = os.platform() === "win32";
const OMP_CMD = IS_WIN ? "cmd.exe" : "omp";
const OMP_ARGS = IS_WIN ? ["/c", "omp", "acp"] : ["acp"];

console.log(`Bridge starting (${os.platform()})`);
console.log(`OMP: ${OMP_CMD} ${OMP_ARGS.join(" ")}`);

const PORT = parseInt(process.env.PORT || "7654", 10);
const HOST = process.env.HOST || "127.0.0.1";

async function ensureChild() {
  const child = spawn(OMP_CMD, OMP_ARGS, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s && !s.includes("UNC paths")) console.error("ACP:", s);
  });
  child.on("error", (err) => console.error("ACP spawn error:", err));
  child.on("exit", (code, sig) => console.log("ACP exit:", code, sig));

  const write = (obj) => new Promise((resolve, reject) => {
    child.stdin.write(JSON.stringify(obj) + "\n", (err) => (err ? reject(err) : resolve()));
  });

  let buf = "";
  child.stdout.on("data", (d) => { buf += d.toString(); });

  const readLine = (timeout = 10000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const check = () => {
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        clearTimeout(timer);
        resolve(line || null);
        return;
      }
      setTimeout(check, 100);
    };
    setTimeout(check, 50);
    child.stdout.on("end", () => { clearTimeout(timer); resolve(null); });
  });

  // Initialize
  console.log("Initializing ACP...");
  await write({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: 1 }, id: 1 });
  const initResp = await readLine(10000);
  if (!initResp) throw new Error("ACP init timeout");
  console.log("ACP initialized");

  // Create session
  console.log("Creating ACP session...");
  const cwd = process.cwd();
  await write({ jsonrpc: "2.0", method: "session/new", params: { cwd, mcpServers: [] }, id: 2 });
  const sessResp = await readLine(10000);
  if (!sessResp) throw new Error("ACP session timeout");
  let sessionId;
  try { sessionId = JSON.parse(sessResp).result?.sessionId; } catch {}
  if (!sessionId) throw new Error("ACP session/new failed: " + sessResp?.substring(0, 100));
  console.log("ACP session:", sessionId);

  return { child, write, readLine, sessionId };
}

let acp = null;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!req.url?.includes("/v1/chat/completions")) {
    res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let request;
  try { request = JSON.parse(body); } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: "Bad JSON" }));
    return;
  }

  try {
    if (!acp) acp = await ensureChild();
    const messages = request.messages || [];
    const stream = request.stream !== false;
    const id = Date.now();
    const text = messages.map((m) => m.content || "").join("\n");

    await acp.write({
      jsonrpc: "2.0", method: "session/prompt",
      params: { sessionId: acp.sessionId, prompt: [{ type: "text", text }] },
      id,
    });

    let fullText = "";
    let done = false;
    const start = Date.now();

    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    }

    while (!done && Date.now() - start < 60000) {
      const line = await acp.readLine(10000);
      if (!line) break;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) { done = true; break; }
        if (msg.method === "session/update") {
          const text = msg.params?.update?.content?.text || "";
          if (text) {
            fullText += text;
            if (stream) {
              res.write(`data: ${JSON.stringify({
                id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000), model: "acp-agent",
                choices: [{ delta: { content: text }, index: 0 }],
              })}\n\n`);
            }
          }
        }
        if (msg.error) { done = true; break; }
      } catch {}
    }

    if (stream) {
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`, object: "chat.completion",
        created: Math.floor(Date.now() / 1000), model: "acp-agent",
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
      }));
    }
  } catch (err) {
    console.error("Request error:", err);
    acp = null;
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bridge ready on http://${HOST}:${PORT}`);
  console.log(`Zed → assistant.open_ai.api_url: http://${HOST}:${PORT}/v1/chat/completions`);
});
