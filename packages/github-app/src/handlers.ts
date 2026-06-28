import type { AgentRuntime } from "@marathon/agent";
import { getRepoAccess, type GithubClient, type GithubDelivery } from "@marathon/connector-github";
import { emptyCheckpoint, type Id } from "@marathon/core";
import { Database } from "@marathon/db";
import type { AgentDescriptor, NormalizedInvocation } from "@marathon/surface";
import { classifyGithubEvent } from "@marathon/surface-github";
import { ToolGateway } from "@marathon/tools";
import { InvocationRouter } from "@marathon/worker";

export interface GithubAppDeps {
  db: Database;
  router: InvocationRouter;
  gateway: ToolGateway; // must include document.* tools
  delivery: GithubDelivery;
  runtime: AgentRuntime;
  /** Used for repo-permission checks (agent + invoking user) before acting. */
  client: GithubClient;
  tenantId: Id;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, Id>;
  defaultAgent?: string;
  docBasePath?: string;
  modelRef?: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc";
}

/** A document mention: draft a design doc as a PR and reply with the link (waits for merge). */
export async function handleGithubMention(deps: GithubAppDeps, invocation: NormalizedInvocation): Promise<void> {
  const repo = String(invocation.sourceRef.repo);
  const number = Number(invocation.sourceRef.number);
  const modelRef = deps.modelRef ?? "openai:gpt-4o-mini";

  // Repo-permission check (design §7.17): the agent AND the invoking user must be
  // able to access the repo before we read or write anything.
  const access = await getRepoAccess(deps.client, repo, String(invocation.userExternalId));
  if (!access.agentOk) {
    // The agent's own token can't see the repo — we can't even comment. Skip.
    return;
  }
  if (!access.userOk) {
    await deps.delivery.postProgress(
      { repo, number },
      `Sorry @${invocation.userExternalId} — I can't act here because you don't appear to have access to \`${repo}\`.`,
    );
    return;
  }

  await deps.delivery.acknowledge({ repo, number });

  const { task, agentName } = await deps.router.route(invocation, {
    tenantId: deps.tenantId,
    agents: deps.agents,
    agentIdByName: deps.agentIdByName,
    defaultAgent: deps.defaultAgent,
  });
  const agentId = deps.agentIdByName[agentName];
  const ctx = { taskId: task.id, tenantId: deps.tenantId, agentId };

  const turn = await deps.runtime.nextTurn({
    request: { taskId: task.id, instructions: "Draft a concise markdown design document.", input: invocation.text, modelRef },
    checkpoint: emptyCheckpoint(),
  });

  const path = `${deps.docBasePath ?? "docs"}/${slug(invocation.text)}.md`;
  const created = await deps.gateway.run("document.create", { repo, path, content: turn.text, base: "main", title: `Design: ${invocation.text.slice(0, 60)}` }, ctx);
  const prNumber = Number((created.details as { number: number }).number);

  await deps.db.recordDocumentArtifact({
    tenantId: deps.tenantId,
    location: { repo, prNumber, path },
    role: "produced",
    owningTaskId: task.id,
    owningAgentId: agentId,
    title: path,
  });

  await deps.delivery.deliverResult({ repo, number }, { summary: `Drafted design doc: PR #${prNumber} — review & merge to execute.` });
  await deps.db.transitionTask(task.id, "running");
  await deps.db.transitionTask(task.id, "waiting_for_approval");
}

/** A merged PR: find the produced doc and execute the approved plan. */
export async function handleGithubMerge(deps: GithubAppDeps, repo: string, prNumber: number): Promise<boolean> {
  const artifact = await deps.db.findDocumentArtifactByPr(deps.tenantId, repo, prNumber);
  if (!artifact?.owningTaskId) return false;

  await deps.db.transitionTask(artifact.owningTaskId, "running");
  await deps.delivery.postProgress({ repo, number: prNumber }, "Merged — executing the approved plan…");
  const turn = await deps.runtime.nextTurn({
    request: { taskId: artifact.owningTaskId, instructions: "Execute the approved plan; report what you did.", input: "execute the approved plan", modelRef: deps.modelRef ?? "openai:gpt-4o-mini" },
    checkpoint: emptyCheckpoint(),
  });
  await deps.delivery.deliverResult({ repo, number: prNumber }, { summary: turn.text.split("\n")[0] || "Done." });
  await deps.db.transitionTask(artifact.owningTaskId, "completed");
  return true;
}

export async function dispatchGithubEvent(
  deps: GithubAppDeps,
  eventType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
): Promise<void> {
  const action = classifyGithubEvent(eventType, payload, { knownAgents: deps.agents.map((a) => a.name) });
  if (action.kind === "mention") await handleGithubMention(deps, action.invocation);
  else if (action.kind === "merge") await handleGithubMerge(deps, action.repo, action.number);
}
