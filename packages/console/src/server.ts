import { createServer, type Server } from "node:http";
import type { Database } from "@marathon/db";
import { getTaskReport } from "@marathon/observability";
import { getRelatedTasks, listRecentCommands } from "./queries";
import { renderCommandsListPage, renderTaskDetailPage } from "./render";

/**
 * Read-only recent-commands / task-detail HTTP endpoint (design
 * /recent-commands-view.md). Two routes, both tenant-scoped by a required
 * `tenantId` query param — v1 has no auth story, so this binds to localhost
 * by default (see `listen`) and never widens the tenant scope on its own.
 */
export function createConsoleServer(db: Database, opts: { commandsLimit?: number } = {}): Server {
  return createServer((req, res) => {
    void handleConsoleRequest(db, opts, req.url ?? "/").then(
      (r) => {
        res.writeHead(r.status, { "content-type": "text/html; charset=utf-8" }).end(r.body);
      },
      (err) => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`internal error: ${String(err)}`);
      },
    );
  });
}

/** The routing + tenant-scoping logic, split out from the socket handling so it is directly unit-testable. */
export async function handleConsoleRequest(
  db: Database,
  opts: { commandsLimit?: number },
  rawUrl: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(rawUrl, "http://localhost");
  const tenantId = url.searchParams.get("tenantId");
  if (!tenantId) return { status: 400, body: "tenantId query param is required" };

  if (url.pathname === "/commands") {
    const commands = await listRecentCommands(db, tenantId, opts.commandsLimit ?? 100);
    return { status: 200, body: renderCommandsListPage(commands, tenantId) };
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]!);
    const task = await db.getTask(taskId);
    if (!task || task.tenantId !== tenantId) return { status: 404, body: "task not found" };
    const report = await getTaskReport(db, tenantId, taskId);
    if (!report) return { status: 404, body: "task not found" };
    const related = await getRelatedTasks(db, tenantId, task);
    return { status: 200, body: renderTaskDetailPage(task, report, related, tenantId) };
  }

  return { status: 404, body: "not found" };
}

/** Loopback-only hostnames/addresses this server is allowed to bind without an explicit opt-in (see `listenConsoleServer`). */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Bind and listen, localhost by default (v1 has no auth story — see module
 * doc). Refuses to bind a non-loopback host (e.g. an inherited `HOST=0.0.0.0`
 * from an app-runner environment) unless `opts.allowNonLoopback` is set,
 * since every route here is unauthenticated and tenant-scoped only by a
 * caller-supplied query param.
 */
export async function listenConsoleServer(
  server: Server,
  host = "127.0.0.1",
  port = 0,
  opts: { allowNonLoopback?: boolean } = {},
): Promise<string> {
  if (!opts.allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind unauthenticated console server to non-loopback host "${host}"; ` +
        "set opts.allowNonLoopback (CONSOLE_ALLOW_NONLOOPBACK=1) if this is intentional",
    );
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("console server failed to bind a TCP port");
  return `http://${host}:${addr.port}`;
}
