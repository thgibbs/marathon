#!/usr/bin/env -S npx tsx
import { connect } from "node:net";
import { ToolBrokerClient } from "@marathon/tools";
import { brokerConnectArg } from "./connect";
import { handleMcpRequest, type JsonRpcRequest } from "./handler";

/**
 * The `marathon-mcp-shim` entrypoint (design §12.6; claude-code-impl.md §3.1).
 *
 * Claude Code spawns this as a stdio MCP server: its stdin/stdout speak MCP JSON-RPC
 * (newline-delimited) to the CLI, and it forwards `tools/list` / `tools/call` to the
 * host-side `serveToolBroker`. The transport is either a per-task **unix socket**
 * (`--socket <path>`, the Linux default) or a **TCP** endpoint
 * (`--tcp <host:port>`) — the latter for macOS Docker Desktop, where a bind-mounted
 * unix socket is not connectable across the host↔VM boundary (ENOTSUP). Zero config,
 * zero secrets — everything is resolved host-side per task.
 */

async function main(): Promise<void> {
  const target = brokerConnectArg(process.argv.slice(2));
  const sock = "path" in target ? connect(target.path) : connect(target.port, target.host);
  sock.on("error", (err) => {
    process.stderr.write(`marathon-mcp-shim: broker connection error: ${err}\n`);
    process.exit(1);
  });
  await new Promise<void>((resolve) => sock.once("connect", resolve));
  const broker = new ToolBrokerClient(sock, sock);

  // Newline-delimited JSON-RPC on stdin → handler → stdout.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handleMcpRequest(broker, msg).then((resp) => {
        if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

void main();
