import type { Readable, Writable } from "node:stream";
import {
  type BrokerToolSpec,
  handleToolRequest,
  sanitizeToolName,
  type ToolBrokerRequest,
  type ToolBrokerResponse,
} from "./broker";
import type { ToolCallContext, ToolGateway } from "./gateway";
import type { ToolInput } from "./types";

/**
 * Transport for the tool broker (design §12.6): line-delimited JSON over a duplex
 * stream (a socket or the Pi/Claude process's stdio). The sandboxed side
 * ({@link ToolBrokerClient}) sends `{id, tool, input}` for a call or `{id, op:"list_tools"}`
 * to discover the task's governed tools; the host side ({@link serveToolBroker}) replies
 * `{id, ...ToolBrokerResponse}` or `{id, status:"ok", tools}`. Credentials and policy
 * stay host-side; only requests and already-redacted results cross the boundary.
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

/** The reserved broker tool name for durable clarifying questions (Track 12, §11.6). */
export const ASK_USER_TOOL = "ask_user";

export interface ServeToolBrokerOptions {
  /**
   * Governed tools to advertise on `list_tools` (the MCP shim's `tools/list`).
   * Names are the real Marathon tool names; the broker sanitizes them for the
   * model and maps calls back before running the gateway.
   */
  tools?: BrokerToolSpec[];
  /**
   * Clarifying-question sink (Track 12, §11.6). When set, an `ask_user` tool is
   * advertised and its calls are captured here (recorded, not gateway-run); the
   * runtime turns a captured question into a durable wait after the turn ends.
   */
  onAskUser?: (question: string) => void;
}

const ASK_USER_SPEC: BrokerToolSpec = {
  name: ASK_USER_TOOL,
  description:
    "Ask the user ONE clarifying question when you cannot proceed without their answer. " +
    "The task pauses until they reply — after calling this, STOP working and end your response.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The question for the user." } },
    required: ["question"],
  },
};

/**
 * Host side: serve brokered tool requests arriving on `input`, replying on `output`.
 * The model-facing sanitized tool names are mapped back to their real Marathon
 * names before the gateway runs, so the sandboxed side (the MCP shim) stays
 * zero-config and zero-secret.
 */
export function serveToolBroker(
  input: Readable,
  output: Writable,
  gateway: ToolGateway,
  ctx: ToolCallContext,
  opts: ServeToolBrokerOptions = {},
): void {
  const advertised: BrokerToolSpec[] = [
    ...(opts.tools ?? []).map((t) => ({ ...t, name: sanitizeToolName(t.name) })),
    ...(opts.onAskUser ? [ASK_USER_SPEC] : []),
  ];
  // sanitized model-facing name -> real Marathon tool name
  const realName = new Map<string, string>();
  for (const t of opts.tools ?? []) realName.set(sanitizeToolName(t.name), t.name);

  const write = (obj: unknown) => output.write(`${JSON.stringify(obj)}\n`);

  readLines(input, (line) => {
    let msg: { id: number; op?: string; tool?: string; input?: ToolInput };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;

    if (msg.op === "list_tools") {
      write({ id: msg.id, status: "ok", tools: advertised });
      return;
    }

    const requested = msg.tool ?? "";
    // Clarifying question: capture it, never touch the gateway (§2.3).
    if (opts.onAskUser && requested === ASK_USER_TOOL) {
      const question = String((msg.input as Record<string, unknown> | undefined)?.question ?? "").trim() || "(no question given)";
      opts.onAskUser(question);
      write({
        id: msg.id,
        status: "ok",
        content: "Question sent to the user. Stop here — the task resumes when they answer.",
      } satisfies { id: number } & ToolBrokerResponse);
      return;
    }

    const tool = realName.get(requested) ?? requested;
    void handleToolRequest(gateway, ctx, { tool, input: msg.input ?? {} }).then((resp) => {
      write({ id: msg.id, ...resp });
    });
  });
}

/** Sandbox side: a client that sends brokered tool requests and awaits responses. */
export class ToolBrokerClient {
  private nextId = 0;
  private readonly pending = new Map<number, (r: unknown) => void>();

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    readLines(input, (line) => {
      let msg: { id: number };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        const { id: _id, ...resp } = msg as Record<string, unknown> & { id: number };
        resolve(resp);
      }
    });
  }

  request(req: ToolBrokerRequest, timeoutMs = 30_000): Promise<ToolBrokerResponse> {
    return this.send({ tool: req.tool, input: req.input }, timeoutMs) as Promise<ToolBrokerResponse>;
  }

  /** Discover the task's governed tools (the MCP shim's `tools/list`). */
  listTools(timeoutMs = 30_000): Promise<BrokerToolSpec[]> {
    return this.send({ op: "list_tools" }, timeoutMs).then(
      (r) => (r as { tools?: BrokerToolSpec[] }).tools ?? [],
    );
  }

  private send(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
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
      this.output.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }
}
