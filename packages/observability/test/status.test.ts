import { describe, expect, it } from "vitest";
import type { Task } from "@marathon/core";
import {
  assertWithinTaskBudget,
  BudgetExceededError,
  checkTaskBudget,
  renderStatusText,
  taskStatusView,
} from "../src";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    agentId: null,
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.0" },
    deliveryTargets: null,
    status: "running",
    inputText: "do the thing",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe("taskStatusView (§15.3)", () => {
  it("running task: headline + current step from the latest finding + completed steps", () => {
    const view = taskStatusView(
      makeTask({
        checkpoint: {
          completedSteps: ["turn:0", "turn:1"],
          findings: ["read the thread", "checking the deploy log"],
        },
      }),
      { costUsd: 0.0123 },
    );
    expect(view.headline).toBe("Still running.");
    expect(view.currentStep).toBe("checking the deploy log");
    expect(view.completedSteps).toEqual(["turn:0", "turn:1"]);
    expect(view.costUsd).toBe(0.0123);
  });

  it("BUILD task: the checkpoint phase wins over findings", () => {
    const view = taskStatusView(
      makeTask({
        checkpoint: { completedSteps: ["turn:0"], findings: ["noise"], phase: "build", turnIndex: 0 },
      }),
    );
    expect(view.currentStep).toBe("Building in the sandbox (turn 1 checkpointed).");
  });

  it("waiting task: surfaces the pending question", () => {
    const view = taskStatusView(
      makeTask({
        status: "waiting_for_input",
        checkpoint: { completedSteps: ["turn:0"], findings: [], pendingQuestion: "prod or staging?" },
      }),
    );
    expect(view.headline).toBe("Waiting for your reply.");
    expect(view.question).toBe("prod or staging?");
  });

  it("completed task: no current step, PR link when delivered", () => {
    const view = taskStatusView(
      makeTask({ status: "completed", checkpoint: { completedSteps: ["turn:0", "build:final"], findings: ["done"] } }),
      { costUsd: 0.5, prUrl: "https://github.com/o/r/pull/7" },
    );
    expect(view.headline).toBe("Completed.");
    expect(view.currentStep).toBeUndefined();
    expect(view.prUrl).toBe("https://github.com/o/r/pull/7");
  });
});

describe("renderStatusText (§15.3)", () => {
  it("renders headline, question, current step, completed list, PR, and the cost footer", () => {
    const text = renderStatusText({
      taskId: "t",
      status: "waiting_for_input",
      headline: "Waiting for your reply.",
      question: "prod or staging?",
      currentStep: "asking a clarifying question",
      completedSteps: ["turn:0"],
      prUrl: "https://github.com/o/r/pull/7",
      costUsd: 0.0421,
    });
    expect(text).toContain("Waiting for your reply.");
    expect(text).toContain("*Waiting on:*\nprod or staging?");
    expect(text).toContain("*Completed:*\n- turn:0");
    expect(text).toContain("*Pull request:* https://github.com/o/r/pull/7");
    expect(text).toContain("_cost so far: $0.0421_");
  });

  it("omits the cost footer when cost is unknown", () => {
    const text = renderStatusText({
      taskId: "t",
      status: "running",
      headline: "Still running.",
      completedSteps: [],
      costUsd: null,
    });
    expect(text).not.toContain("cost so far");
  });
});

describe("per-task budget (Track 15)", () => {
  const spend = (usd: number) => ({ sumModelCostUsd: async () => usd });

  it("checkTaskBudget evaluates this task's own spend", async () => {
    const status = await checkTaskBudget(spend(0.4), "task-1", { limitUsd: 1 });
    expect(status.state).toBe("ok");
    expect(status.spentUsd).toBe(0.4);
  });

  it("assertWithinTaskBudget throws once the cap is reached (fail closed)", async () => {
    await expect(assertWithinTaskBudget(spend(1.0), "task-1", { limitUsd: 1 })).rejects.toThrow(BudgetExceededError);
    await expect(assertWithinTaskBudget(spend(0.1), "task-1", { limitUsd: 0 })).rejects.toThrow(BudgetExceededError);
  });
});
