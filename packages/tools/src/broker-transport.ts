import type { Readable, Writable } from "node:stream";
import { handleToolRequest, type ToolBrokerRequest, type ToolBrokerResponse } from "./broker";
import type { ToolCallContext, ToolGateway } from "./gateway";
import type { ToolInput } from "./types";

/**
 * Transport for the tool broker (design §12.6): line-delimited JSON over a duplex
 * stream (a socket or the Pi process's stdio). The sandboxed side ({@link ToolBrokerClient})
 * sends `{id, tool, input}`; the host side ({@link serveToolBroker}) replies
 * `{id, ...ToolBrokerResponse}`. Credentials and policy stay host-side; only requests
 * and already-redacted results cross the boundary.
 */

function readLines(stream: Readable, onLine: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/** Host side: serve brokered tool requests arriving on `input`, replying on `output`. */
export function serveToolBroker(input: Readable, output: Writable, gateway: ToolGateway, ctx: ToolCallContext): void {
  readLines(input, (line) => {
    let msg: { id: number; tool: string; input: ToolInput };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    void handleToolRequest(gateway, ctx, { tool: msg.tool, input: msg.input }).then((resp) => {
      output.write(`${JSON.stringify({ id: msg.id, ...resp })}\n`);
    });
  });
}

/** Sandbox side: a client that sends brokered tool requests and awaits responses. */
export class ToolBrokerClient {
  private nextId = 0;
  private readonly pending = new Map<number, (r: ToolBrokerResponse) => void>();

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    readLines(input, (line) => {
      let msg: { id: number } & ToolBrokerResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        const { id: _id, ...resp } = msg;
        resolve(resp as ToolBrokerResponse);
      }
    });
  }

  request(req: ToolBrokerRequest, timeoutMs = 30_000): Promise<ToolBrokerResponse> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("broker request timed out"));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.output.write(`${JSON.stringify({ id, tool: req.tool, input: req.input })}\n`);
    });
  }
}
