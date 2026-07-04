import type { MemoryItem, MemoryLevel, MemoryScope, NewMemoryItem, TaskAudience } from "./types";

/**
 * Audience-gated recall (design §7.12): a scope is recallable iff the task's
 * audience is contained in the scope's audience (user ⊂ project ⊂ tenant).
 *
 * Thread scope is same-conversation working memory: the query only ever
 * carries the CURRENT thread's id, whose content the task's audience already
 * sees — so it is recallable at every internal audience.
 *
 * External/guest audiences recall nothing. (The §7.12 drafting exception —
 * tenant recall for proposal-gated external artifacts — is deliberately not
 * implemented until external egress tools exist.)
 */
export function recallableLevels(audience: TaskAudience): MemoryLevel[] {
  if (audience.external) return [];
  switch (audience.level) {
    case "user":
      return ["user", "project", "tenant", "thread"];
    case "thread":
      // Participants of one conversation — containment is only provable
      // against the thread itself and the whole tenant.
      return ["thread", "tenant"];
    case "project":
      return ["project", "tenant", "thread"];
    case "tenant":
      return ["tenant", "thread"];
  }
}

/**
 * May this item enter a prompt for this query? Levels come from the audience;
 * within a level the item must belong to the query's scope keys. User-scoped
 * `preference` items are additionally recallable wherever the user is the
 * requestor (§7.12 preference exception) — they steer *how* the agent
 * responds without disclosing content.
 */
export function itemRecallable(
  item: Pick<MemoryItem, "level" | "kind" | "scope">,
  scope: MemoryScope,
  audience: TaskAudience,
): boolean {
  if (audience.external) return false;
  if (item.scope.tenantId !== scope.tenantId) return false;
  if (recallableLevels(audience).includes(item.level)) {
    switch (item.level) {
      case "tenant":
        return true;
      case "project":
        return !!scope.projectId && item.scope.projectId === scope.projectId;
      case "user":
        return !!scope.userId && item.scope.userId === scope.userId;
      case "thread":
        return !!scope.threadId && item.scope.threadId === scope.threadId;
    }
  }
  return item.level === "user" && item.kind === "preference" && !!audience.userId && item.scope.userId === audience.userId;
}

/**
 * Write-side enforcement (§7.12): items carry the scope key their level
 * names (narrowest applicable scope), and gating scales with the audience —
 * user/thread: none; project: light (members can list/forget); tenant:
 * requires confirmation (agent owner / admin), recorded in provenance.
 */
export function validateWrite(input: NewMemoryItem): void {
  const need = (key: keyof MemoryScope): void => {
    if (!input.scope[key]) throw new Error(`memory: level '${input.level}' requires scope.${String(key)}`);
  };
  switch (input.level) {
    case "project":
      need("projectId");
      break;
    case "user":
      need("userId");
      break;
    case "thread":
      need("threadId");
      break;
    case "tenant":
      if (!input.provenance?.confirmedBy) {
        throw new Error("memory: tenant-scoped writes require provenance.confirmedBy (§7.12 write gate)");
      }
      break;
  }
}
