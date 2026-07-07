import type { Task } from "@marathon/core";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    agentId: null,
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: {},
    deliveryTargets: null,
    status: "completed",
    inputText: "do the thing",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}
