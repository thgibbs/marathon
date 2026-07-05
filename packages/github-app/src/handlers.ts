import type { AgentRuntime } from "@marathon/agent";
import { DEFAULT_PLANS_BRANCH } from "@marathon/config";
import { getRepoAccess, type GithubClient, type GithubDelivery } from "@marathon/connector-github";
import {
  emptyCheckpoint,
  implementationTaskKey,
  mergeDeliveryTargets,
  revisionTaskKey,
  type DeliveryTarget,
  type Id,
  type PlanRef,
} from "@marathon/core";
import { Database } from "@marathon/db";
import type { MemoryStore } from "@marathon/memory";
import { DeliveryFanout, type AgentDescriptor, type NormalizedInvocation } from "@marathon/surface";
import { classifyGithubEvent } from "@marathon/surface-github";
import { ToolGateway } from "@marathon/tools";
import {
  buildAgentPrompt,
  InvocationRouter,
  Orchestrator,
  renderImplementationBrief,
  renderRevisionBrief,
} from "@marathon/worker";

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
  /**
   * The plans branch (§29.1a): doc PRs target it, and only a doc PR merged
   * INTO it is an approval. Default `marathon-plans`. Setting it to the
   * default branch reproduces the pre-§29.1a merge-into-main behavior.
   */
  plansBranch?: string;
  /** The branch implementations build on and code PRs target; default "main". */
  defaultBranch?: string;
}

const DRAFT_PERSONA = "You are a documentation agent. Draft a concise markdown design document that fulfills the request.";
const REVISE_PERSONA = "You are a documentation agent. Revise the document in <context> per the request. Return ONLY the full revised markdown.";

function fanoutOf(deps: GithubAppDeps): DeliveryFanout {
  return deps.fanout ?? new DeliveryFanout({ github: deps.delivery }, deps.db);
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

  // Track 10 (§29.6): a mention on a Marathon-created CODE PR is review
  // feedback — spawn a durable revision task instead of a doc flow.
  if (invocation.sourceRef.kind === "pr" && (await handleCodePrRevision(deps, invocation))) return;

  const { task, agentName } = await deps.router.route(invocation, {
    tenantId: deps.tenantId,
    agents: deps.agents,
    agentIdByName: deps.agentIdByName,
    defaultAgent: deps.defaultAgent,
  });
  const agentId = deps.agentIdByName[agentName];
  const ctx = { taskId: task.id, tenantId: deps.tenantId, agentId };

  // Conversation context (Track 12, §7.18): the PR/issue comment history,
  // loaded through the surface adapter and fenced as untrusted by the builder.
  const context = await deps.delivery.loadContext?.({ repo, number }, { limit: 30 }).catch(() => undefined);

  // Revision loop (§6.8): a mention on a PR we produced -> revise the doc on its branch.
  const existing =
    invocation.sourceRef.kind === "pr" ? await deps.db.findDocumentArtifactByPr(deps.tenantId, repo, number) : null;
  const loc = (existing?.location ?? {}) as { path?: string; branch?: string };
  if (existing && loc.path && loc.branch) {
    const current = await deps.client.readFileWithSha(repo, loc.path, loc.branch).catch(() => ({ content: "", sha: "" }));
    const prompt = await buildAgentPrompt({ db: deps.db, memory: deps.memory }, task, {
      basePersona: REVISE_PERSONA,
      documents: [{ path: loc.path, content: current.content }],
      context,
    });
    const turn = await deps.runtime.nextTurn({
      request: { taskId: task.id, instructions: prompt.instructions, input: prompt.input, modelRef },
      checkpoint: emptyCheckpoint(),
    });
    await deps.gateway.run("document.revise", { repo, path: loc.path, content: turn.text, branch: loc.branch }, ctx);
    await deps.delivery.deliverResult(
      { repo, number },
      {
        summary: `Revised the document on PR #${number} per your comments.`,
        // Silent cost footer (Track 16, §13.3) — consistent with Slack delivery.
        costUsd: await deps.db.sumModelCostUsd(task.id),
      },
    );
    return;
  }

  // Draft a new design-doc PR.
  const prompt = await buildAgentPrompt({ db: deps.db, memory: deps.memory }, task, {
    basePersona: DRAFT_PERSONA,
    context,
  });
  const turn = await deps.runtime.nextTurn({
    request: { taskId: task.id, instructions: prompt.instructions, input: prompt.input, modelRef },
    checkpoint: emptyCheckpoint(),
  });

  const path = `${deps.docBasePath ?? "docs"}/${slug(invocation.text)}.md`;
  // §29.1a: the doc PR targets the plans branch, never the default branch.
  const created = await deps.gateway.run(
    "document.create",
    { repo, path, content: turn.text, base: deps.plansBranch ?? DEFAULT_PLANS_BRANCH, title: `Design: ${invocation.text.slice(0, 60)}` },
    ctx,
  );
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
    mergeDeliveryTargets(task.deliveryTargets, { surfaceType: "github", ref: { repo, number: prNumber, kind: "pr" } }),
  );

  await deps.delivery.deliverResult(
    { repo, number },
    {
      summary: `Drafted design doc: PR #${prNumber} — comment to revise, merge to execute.`,
      costUsd: await deps.db.sumModelCostUsd(task.id),
    },
  );
  await deps.db.transitionTask(task.id, "running");
  await deps.db.transitionTask(task.id, "waiting_for_approval");
}

/**
 * A mention on a Marathon-created code PR (Track 10, §29.6): spawn a revision
 * task chained to the implementation task — base pinned to the branch's
 * CURRENT tip (so human pushes are included), the same branch/PR updated
 * through the brokered `git`/`gh` path, and the result re-reported via
 * `delivery.report_pr`. Returns false when the PR is not a Marathon code PR.
 */
export async function handleCodePrRevision(
  deps: GithubAppDeps,
  invocation: NormalizedInvocation,
): Promise<boolean> {
  const repo = String(invocation.sourceRef.repo);
  const number = Number(invocation.sourceRef.number);
  const change = await deps.db.findCodeChangeByPr(deps.tenantId, repo, number);
  if (!change?.prNumber) return false;

  // Pin the revision to the branch's current tip (§29.6), not the original
  // base_sha — the workspace must contain every commit already on the PR.
  let tipSha: string;
  try {
    tipSha = (await deps.client.getRef(repo, `heads/${change.branch}`)).sha;
  } catch {
    await deps.delivery.postProgress(
      { repo, number },
      `I can't revise PR #${number} — its branch \`${change.branch}\` no longer exists.`,
    );
    return true;
  }

  const sourceTask = await deps.db.getTask(change.taskId);
  const codePrTarget: DeliveryTarget = { surfaceType: "github", ref: { repo, number, kind: "pr" } };
  const deliveryTargets = mergeDeliveryTargets(sourceTask?.deliveryTargets ?? null, codePrTarget);

  const { task, deduped } = await deps.orchestrator.submit({
    tenantId: deps.tenantId,
    agentId: sourceTask?.agentId ?? undefined,
    agentVersionId: sourceTask?.agentVersionId ?? undefined,
    invokingUserId: sourceTask?.invokingUserId ?? undefined,
    sourceTaskId: change.taskId,
    sourceType: "github",
    sourceRef: {
      kind: "code_revision",
      repo,
      prNumber: number,
      branch: change.branch,
      planRef: {
        repo: change.planRef.repo,
        docPath: change.planRef.docPath,
        mergeCommitSha: change.planRef.mergeCommitSha,
      },
      baseSha: tipSha,
    },
    deliveryTargets,
    inputText: renderRevisionBrief({
      repo,
      prNumber: number,
      prUrl: change.prUrl ?? undefined,
      branch: change.branch,
      planRef: change.planRef,
      comment: invocation.text,
      commentAuthor: invocation.userExternalId,
    }),
    // One revision task per review comment; webhook re-deliveries converge.
    idempotencyKey: revisionTaskKey(repo, number, invocation.eventId ?? tipSha),
  });

  if (!deduped) {
    await fanoutOf(deps).postProgress(
      task.id,
      deliveryTargets,
      `Revision task queued for PR #${number} (branch \`${change.branch}\` @ \`${tipSha.slice(0, 7)}\`).`,
      "revision_queued",
    );
  }
  return true;
}

/**
 * A design-doc PR merged INTO THE PLANS BRANCH is the approval (§0.1 stage 4,
 * §29.1a): complete the doc task and spawn a *new* implementation task
 * (§29.1), chained to it — `plan_ref` pinned to the plans-branch merge commit,
 * `base_sha` pinned to the default branch's head at approval (they decouple),
 * delivery targets inherited, idempotent per merged plan version.
 */
export async function handleGithubMerge(
  deps: GithubAppDeps,
  repo: string,
  prNumber: number,
  mergeCommitSha?: string,
  baseRef?: string,
): Promise<boolean> {
  const plansBranch = deps.plansBranch ?? DEFAULT_PLANS_BRANCH;
  // §29.1a: a doc PR merged anywhere else (e.g. the default branch) is NOT an
  // approval. Real webhooks always carry base.ref; an absent baseRef means a
  // legacy caller — kept as the pre-§29.1a behavior (approve on artifact).
  if (baseRef !== undefined && baseRef !== plansBranch) return false;

  const artifact = await deps.db.findDocumentArtifactByPr(deps.tenantId, repo, prNumber);
  if (!artifact?.owningTaskId) return false;
  const loc = artifact.location as { path?: string };
  const docTask = await deps.db.getTask(artifact.owningTaskId);
  if (!docTask || !loc.path || !mergeCommitSha) return false;

  const planRef: PlanRef = { repo, docPath: loc.path, mergeCommitSha };
  // §29.1a: the work builds on the DEFAULT branch, pinned once at approval;
  // the plan itself is pinned separately by plan_ref (plans branch). When the
  // plans branch IS the default branch (compat mode) or the caller is legacy,
  // the two coincide at the merge commit — the pre-§29.1a behavior.
  const defaultBranch = deps.defaultBranch ?? "main";
  const baseSha =
    baseRef === undefined || plansBranch === defaultBranch
      ? mergeCommitSha
      : (await deps.client.getRef(repo, `heads/${defaultBranch}`)).sha;
  const docPrTarget: DeliveryTarget = { surfaceType: "github", ref: { repo, number: prNumber, kind: "pr" } };
  const deliveryTargets = mergeDeliveryTargets(docTask.deliveryTargets, docPrTarget);

  // Track 10: the artifact keeps the full plan pointer — path/branch/PR were
  // recorded at draft time; the merge commit completes it.
  await deps.db.mergeDocumentArtifactLocation(artifact.id, { mergeCommitSha });

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
      baseSha,
    },
    deliveryTargets,
    // Track 10: the brief carries the merged plan, pinned base, suggested
    // branch, delivery targets, and the delivery.report_pr contract.
    inputText: renderImplementationBrief({ planRef, deliveryTargets, docPrNumber: prNumber }),
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
  else if (action.kind === "merge") await handleGithubMerge(deps, action.repo, action.number, action.mergeCommitSha, action.baseRef);
  else if (action.kind === "push") await handleGithubPush(deps, action.repo, action.after, action.paths);
}
