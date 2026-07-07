#!/usr/bin/env node
// marathon-mcp-shim — the stdio MCP server baked into the sandbox toolchain image
// (design §12.6; claude-code-impl.md §3.1). Claude Code spawns it; its stdin/stdout
// speak MCP JSON-RPC (newline-delimited) and it forwards tools/list + tools/call to
// the host-side broker over the per-task unix socket given by --socket. ZERO config,
// ZERO secrets — everything is resolved host-side per task.
//
// This is the dependency-free deployment copy; the canonical, unit-tested logic lives
// in packages/mcp-shim (handler.ts + the broker transport). Keep the two in sync.
import { connect } from "node:net";

// Transport: a per-task unix socket (--socket <path>, Linux default) or a TCP
// endpoint (--tcp <host:port>) — the latter for macOS Docker Desktop, where a
// bind-mounted unix socket is not connectable across the host↔VM boundary.
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const tcp = flag("--tcp");
const socketPath = flag("--socket");
const token = flag("--token");
if (!tcp && !socketPath) {
  process.stderr.write("marathon-mcp-shim: --socket <path> or --tcp <host:port> is required\n");
  process.exit(1);
}

const PROTOCOL_VERSION = "2024-11-05";
let sock;
if (tcp) {
  const ci = tcp.lastIndexOf(":");
  sock = connect(Number(tcp.slice(ci + 1)), tcp.slice(0, ci));
} else {
  sock = connect(socketPath);
}
sock.on("error", (err) => {
  process.stderr.write(`marathon-mcp-shim: broker connection error: ${err}\n`);
  process.exit(1);
});
// Present the per-turn capability token as the first line (queued until connect).
if (token) sock.write(`${JSON.stringify({ auth: token })}\n`);

// --- broker client (line-delimited JSON over the socket) ---
let nextId = 0;
const pending = new Map();
function brokerSend(payload) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("broker request timed out"));
    }, 30_000);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    sock.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}
readLines(sock, (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    const { id, ...rest } = msg;
    resolve(rest);
  }
});

function brokerText(resp) {
  switch (resp.status) {
    case "ok":
      return resp.content;
    case "denied":
      return `[blocked] ${resp.reason}`;
    case "requires_proposal":
      return `[requires proposal] ${resp.reason}`;
    default:
      return `[error] ${resp.error}`;
  }
}

// --- MCP request handling ---
async function handle(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "marathon", version: "0.1.0" } });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list": {
      const r = await brokerSend({ op: "list_tools" });
      const tools = (r.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters ?? { type: "object", properties: {} } }));
      return ok({ tools });
    }
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!name) return err(-32602, "tools/call requires a tool name");
      const resp = await brokerSend({ tool: name, input: msg.params?.arguments ?? {} });
      return ok({ content: [{ type: "text", text: brokerText(resp) }], isError: resp.status === "error" });
    }
    default:
      return isNotification ? null : err(-32601, `method not found: ${msg.method}`);
  }
}

// --- stdio JSON-RPC loop ---
readLines(process.stdin, (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void handle(msg).then((resp) => {
    if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
  });
});
process.stdin.on("end", () => process.exit(0));

function readLines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}
