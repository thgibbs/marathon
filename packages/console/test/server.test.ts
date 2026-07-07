import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { Database } from "@marathon/db";
import { handleConsoleRequest, isLoopbackHost, listenConsoleServer } from "../src/server";
import { makeTask } from "./fixtures";

function baseDb(overrides: Partial<Database> = {}): Database {
  return {
    listRecentToolInvocations: async () => [],
    getTask: async () => null,
    getTaskSteps: async () => [],
    getModelInvocations: async () => [],
    getToolInvocations: async () => [],
    listApprovalsForTask: async () => [],
    getTaskAuditEvents: async () => [],
    getCodeChangeByTask: async () => null,
    sumModelCostUsd: async () => 0,
    findTaskBySourceTask: async () => null,
    countTasksBySourceTask: async () => 0,
    listTasksByThread: async () => [],
    listTasksByRevisionPr: async () => [],
    ...overrides,
  } as unknown as Database;
}

describe("handleConsoleRequest", () => {
  it("requires a tenantId query param", async () => {
    const res = await handleConsoleRequest(baseDb(), {}, "/commands");
    expect(res.status).toBe(400);
  });

  it("renders the commands list for a valid tenant", async () => {
    const res = await handleConsoleRequest(baseDb(), {}, "/commands?tenantId=tenant-1");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Recent commands");
  });

  it("renders a task's detail page when the task belongs to the requesting tenant", async () => {
    const task = makeTask({ id: "task-1", tenantId: "tenant-1" });
    const db = baseDb({ getTask: async (id) => (id === "task-1" ? task : null) });
    const res = await handleConsoleRequest(db, {}, "/tasks/task-1?tenantId=tenant-1");
    expect(res.status).toBe(200);
    expect(res.body).toContain("task-1");
  });

  it("tenant isolation: a request for a task in another tenant returns nothing", async () => {
    const task = makeTask({ id: "task-1", tenantId: "other-tenant" });
    const db = baseDb({ getTask: async (id) => (id === "task-1" ? task : null) });
    const res = await handleConsoleRequest(db, {}, "/tasks/task-1?tenantId=tenant-1");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(task.inputText ?? "");
  });

  it("404s for an unknown task id", async () => {
    const res = await handleConsoleRequest(baseDb(), {}, "/tasks/does-not-exist?tenantId=tenant-1");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown route", async () => {
    const res = await handleConsoleRequest(baseDb(), {}, "/nope?tenantId=tenant-1");
    expect(res.status).toBe(404);
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.6.7")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("rejects non-loopback hosts, including a bind-everything address", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("listenConsoleServer", () => {
  it("refuses to bind a non-loopback host by default", async () => {
    const server = createServer();
    await expect(listenConsoleServer(server, "0.0.0.0", 0)).rejects.toThrow(/non-loopback/);
  });

  it("binds a non-loopback host when explicitly allowed", async () => {
    const server = createServer();
    const url = await listenConsoleServer(server, "0.0.0.0", 0, { allowNonLoopback: true });
    expect(url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
    server.close();
  });

  it("rejects instead of hanging when the port is already bound", async () => {
    const first = createServer();
    const url = await listenConsoleServer(first, "127.0.0.1", 0);
    const port = Number(new URL(url).port);

    const second = createServer();
    await expect(listenConsoleServer(second, "127.0.0.1", port)).rejects.toThrow();
    first.close();
  });
});
