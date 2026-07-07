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
    return { status: 200, body: renderCommandsListPage(commands) };
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]!);
    const task = await db.getTask(taskId);
    if (!task || task.tenantId !== tenantId) return { status: 404, body: "task not found" };
    const report = await getTaskReport(db, tenantId, taskId);
    if (!report) return { status: 404, body: "task not found" };
    const related = await getRelatedTasks(db, tenantId, task);
    return { status: 200, body: renderTaskDetailPage(task, report, related) };
  }

  return { status: 404, body: "not found" };
}

/** Bind and listen, localhost by default (v1 has no auth story — see module doc). */
export async function listenConsoleServer(server: Server, host = "127.0.0.1", port = 0): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("console server failed to bind a TCP port");
  return `http://${host}:${addr.port}`;
}
