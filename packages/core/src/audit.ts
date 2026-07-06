import { newId, type Id } from "./ids";

/** Security-relevant audit events (design.md §10.15). */
export type AuditEventType =
  | "agent.created"
  | "agent.version_published"
  | "connector.installed"
  | "credential.rotated"
  | "tool.granted"
  | "approval.approved"
  | "approval.rejected"
  | "tool.called"
  | "policy.denied"
  | "task.created"
  | "task.cancelled"
  // identity linking (§7.20): link / stale / unlink transitions are audited
  | "identity.linked"
  | "identity.stale"
  // task lifecycle transitions are recorded as `task.<status>`
  | (string & {});

export interface AuditEvent {
  id: Id;
  tenantId: Id;
  actorUserId?: Id | null;
  actorAgentId?: Id | null;
  eventType: AuditEventType;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export type NewAuditEvent = Omit<AuditEvent, "id" | "createdAt">;

export interface AuditWriter {
  write(event: NewAuditEvent): Promise<AuditEvent>;
}

/** In-memory implementation for unit tests. */
export class InMemoryAuditWriter implements AuditWriter {
  public readonly events: AuditEvent[] = [];

  async write(event: NewAuditEvent): Promise<AuditEvent> {
    const full: AuditEvent = { ...event, id: newId(), createdAt: new Date() };
    this.events.push(full);
    return full;
  }
}
