import type { AgentRuntime } from "@marathon/agent";
import { getRepoAccess, type GithubClient, type GithubDelivery } from "@marathon/connector-github";
import {
  emptyCheckpoint,
  implementationTaskKey,
  stableStringify,
  type DeliveryTarget,
  type Id,
  type PlanRef,
} from "@marathon/core";
import { Database } from "@marathon/db";
import type { MemoryStore } from "@marathon/memory";
import { DeliveryFanout, type AgentDescriptor, type NormalizedInvocation } from "@marathon/surface";
import { classifyGithubEvent } from "@marathon/surface-github";
import { ToolGateway } from "@marathon/tools";
import { buildAgentPrompt, InvocationRouter, Orchestrator } from "@marathon/worker";

export interface GithubAppDeps {
  db: Database;
  router: InvocationRouter;
  /** Spawns the merge-triggered implementation task (K2 task chain). */
  orchestrator: Orchestrator;
  gateway: ToolGateway; // must include document.* tools
  delivery: GithubDelivery;
  runtime: AgentRuntime;
  /** Used for repo-permission checks (agent + invoking user) before acting. */
  client: GithubClient;
  /** When set, recall is injected into prompts (design §7.18). */
  memory?: MemoryStore;
  /**
   * Cross-surface fan-out (K2). When absent, a GitHub-only fan-out is built
   * from `delivery`, so Slack targets are skipped until a Slack adapter is wired.
   */
  fanout?: DeliveryFanout;
  tenantId: Id;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, Id>;
  defaultAgent?: string;
  docBasePath?: string;
  modelRef?: string;
}

const DRAFT_PERSONA = "You are a documentation agent. Draft a concise markdown design document that fulfills the request.";
const REVISE_PERSONA = "You are a documentation agent. Revise the document in <context> per the request. Return ONLY the full revised markdown.";

function fanoutOf(deps: GithubAppDeps): DeliveryFanout {
  return deps.fanout ?? new DeliveryFanout({ github: deps.delivery }, deps.db);
}

/** Append targets, deduping structurally (webhook retries must converge). */
function addTargets(existing: DeliveryTarget[] | null, ...added: DeliveryTarget[]): DeliveryTarget[] {
  const out: DeliveryTarget[] = [];
  const seen = new Set<string>();
  for (const t of [...(existing ?? []), ...added]) {
    const key = stableStringify(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc";
}

/** Mention on a PR/issue: revise the existing draft doc, or draft a new design-doc PR. */
export async function handleGithubMention(deps: GithubAppDeps, invocation: NormalizedInvocation): Promise<void> {
  const repo = String(invocation.sourceRef.repo);
  const number = Number(invocation.sourceRef.number);
  const modelRef = deps.modelRef ?? "openai:gpt-4o-mini";

  // Repo-permission check (§7.17): agent AND invoking user must be able to access the repo.
  const access = await getRepoAccess(deps.client, repo, String(invocation.userExternalId));
  if (!access.agentOk) return; // agent's token can't see the repo — can't even comment
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

  // Revision loop (§6.8): a mention on a PR we produced -> revise the doc on its branch.
  const existing =
    invocation.sourceRef.kind === "pr" ? await deps.db.findDocumentArtifactByPr(deps.tenantId, repo, number) : null;
  const loc = (existing?.location ?? {}) as { path?: string; branch?: string };
  if (existing && loc.path && loc.branch) {
    const current = await deps.client.readFileWithSha(repo, loc.path, loc.branch).catch(() => ({ content: "", sha: "" }));
    const prompt = await buildAgentPrompt({ db: deps.db, memory: deps.memory }, task, {
      basePersona: REVISE_PERSONA,
      documents: [{ path: loc.path, content: current.content }],
    });
    const turn = await deps.runtime.nextTurn({
      request: { taskId: task.id, instructions: prompt.instructions, input: prompt.input, modelRef },
      checkpoint: emptyCheckpoint(),
    });
    await deps.gateway.run("document.revise", { repo, path: loc.path, content: turn.text, branch: loc.branch }, ctx);
    await deps.delivery.deliverResult({ repo, number }, { summary: `Revised the document on PR #${number} per your comments.` });
    return;
  }

  // Draft a new design-doc PR.
  const prompt = await buildAgentPrompt({ db: deps.db, memory: deps.memory }, task, { basePersona: DRAFT_PERSONA });
  const turn = await deps.runtime.nextTurn({
    request: { taskId: task.id, instructions: prompt.instructions, input: prompt.input, modelRef },
    checkpoint: emptyCheckpoint(),
  });

  const path = `${deps.docBasePath ?? "docs"}/${slug(invocation.text)}.md`;
  const created = await deps.gateway.run("document.create", { repo, path, content: turn.text, base: "main", title: `Design: ${invocation.text.slice(0, 60)}` }, ctx);
  const details = created.details as { number: number; branch?: string };
  const prNumber = Number(details.number);

  await deps.db.recordDocumentArtifact({
    tenantId: deps.tenantId,
    location: { repo, prNumber, path, branch: details.branch },
    role: "produced",
    owningTaskId: task.id,
    owningAgentId: agentId,
    title: path,
  });

  // K2: the doc PR becomes a delivery target alongside the originating place,
  // so the implementation task spawned on merge inherits both.
  await deps.db.updateTaskDeliveryTargets(
    task.id,
    addTargets(task.deliveryTargets, { surfaceType: "github", ref: { repo, number: prNumber, kind: "pr" } }),
  );

  await deps.delivery.deliverResult({ repo, number }, { summary: `Drafted design doc: PR #${prNumber} — comment to revise, merge to execute.` });
  await deps.db.transitionTask(task.id, "running");
  await deps.db.transitionTask(task.id, "waiting_for_approval");
}

/**
 * A merged design-doc PR is the approval (§0.1 stage 4): complete the doc task
 * and spawn a *new* implementation task (§29.1), chained to it —
 * `plan_ref`/`base_sha` pinned to the merge commit, delivery targets inherited,
 * idempotent per merged plan version.
 */
export async function handleGithubMerge(
  deps: GithubAppDeps,
  repo: string,
  prNumber: number,
  mergeCommitSha?: string,
): Promise<boolean> {
  const artifact = await deps.db.findDocumentArtifactByPr(deps.tenantId, repo, prNumber);
  if (!artifact?.owningTaskId) return false;
  const loc = artifact.location as { path?: string };
  const docTask = await deps.db.getTask(artifact.owningTaskId);
  if (!docTask || !loc.path || !mergeCommitSha) return false;

  const planRef: PlanRef = { repo, docPath: loc.path, mergeCommitSha };
  const docPrTarget: DeliveryTarget = { surfaceType: "github", ref: { repo, number: prNumber, kind: "pr" } };
  const deliveryTargets = addTargets(docTask.deliveryTargets, docPrTarget);

  const { task: implTask, deduped } = await deps.orchestrator.submit({
    tenantId: deps.tenantId,
    agentId: docTask.agentId ?? undefined,
    agentVersionId: docTask.agentVersionId ?? undefined,
    invokingUserId: docTask.invokingUserId ?? undefined,
    sourceTaskId: docTask.id,
    sourceType: "github",
    // plan_ref + base_sha ride in the task input (§29.1): the BUILD stage pins
    // its workspace to the plan's merge commit and validates the handoff against it.
    sourceRef: {
      kind: "implementation",
      repo,
      docPrNumber: prNumber,
      planRef: { repo, docPath: planRef.docPath, mergeCommitSha },
      baseSha: mergeCommitSha,
    },
    deliveryTargets,
    inputText: `Implement the approved plan in ${loc.path} (merged as ${mergeCommitSha}).`,
    idempotencyKey: implementationTaskKey(repo, loc.path, mergeCommitSha),
  });

  // The doc task's job ends at the merge; the chain continues in implTask.
  if (docTask.status === "waiting_for_approval") {
    await deps.db.transitionTask(docTask.id, "running");
    await deps.db.transitionTask(docTask.id, "completed");
  }

  if (!deduped) {
    await fanoutOf(deps).postProgress(
      implTask.id,
      deliveryTargets,
      `Plan merged (\`${planRef.docPath}\` @ \`${mergeCommitSha.slice(0, 7)}\`) — implementation task queued.`,
      "implementation_queued",
    );
  }
  return true;
}

/** Register a watched document (M7 #8): record its current revision to diff against later. */
export async function watchDocument(deps: GithubAppDeps, opts: { repo: string; path: string; agentId?: Id }): Promise<void> {
  const cur = await deps.client.readFileWithSha(opts.repo, opts.path, "main").catch(() => ({ sha: "" }));
  await deps.db.recordDocumentArtifact({
    tenantId: deps.tenantId,
    location: { repo: opts.repo, path: opts.path },
    role: "watched",
    owningAgentId: opts.agentId,
    lastRevisionSeen: cur.sha,
    title: opts.path,
  });
}

/** A push: for each watched doc whose path changed, update last-seen + spawn a review task. */
export async function handleGithubPush(deps: GithubAppDeps, repo: string, after: string | undefined, paths: string[]): Promise<number> {
  const watched = await deps.db.listWatchedArtifacts(deps.tenantId, repo);
  let reacted = 0;
  for (const w of watched) {
    const p = (w.location as { path?: string }).path;
    if (p && paths.includes(p)) {
      await deps.db.updateDocumentArtifactRevision(w.id, after ?? "");
      await deps.db.createTask({
        tenantId: deps.tenantId,
        agentId: w.owningAgentId ?? undefined,
        sourceType: "github",
        sourceRef: { repo, path: p },
        inputText: `A watched document changed: ${p}`,
      });
      reacted++;
    }
  }
  return reacted;
}

export async function dispatchGithubEvent(
  deps: GithubAppDeps,
  eventType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
): Promise<void> {
  const action = classifyGithubEvent(eventType, payload, { knownAgents: deps.agents.map((a) => a.name) });
  if (action.kind === "mention") await handleGithubMention(deps, action.invocation);
  else if (action.kind === "merge") await handleGithubMerge(deps, action.repo, action.number, action.mergeCommitSha);
  else if (action.kind === "push") await handleGithubPush(deps, action.repo, action.after, action.paths);
}
