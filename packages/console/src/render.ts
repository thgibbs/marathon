import { redactSecrets } from "@marathon/core";
import type { Task } from "@marathon/core";
import type { TaskReport, TimelineEvent } from "@marathon/observability";
import type { RecentCommand, RelatedTasks } from "./queries";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Redact, then escape — every free-text field on both pages goes through this (design §Redaction). */
function safe(text: string | null | undefined): string {
  if (text == null) return "";
  return escapeHtml(redactSecrets(text));
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
${body}
</body></html>`;
}

/** List page: a plain table of the most recent commands (design §List page). */
export function renderCommandsListPage(commands: RecentCommand[]): string {
  const rows = commands
    .map(
      (c) => `<tr>
  <td>${safe(c.toolId)}</td>
  <td>${safe(c.createdAt.toISOString())}</td>
  <td>${safe(c.status)}</td>
  <td>${safe(c.error)}</td>
  <td>${safe(c.inputSummary)}</td>
  <td>${safe(c.outputSummary)}</td>
  <td><a href="/tasks/${encodeURIComponent(c.taskId)}">${safe(c.taskId)}</a> (${safe(c.taskStatus)})</td>
</tr>`,
    )
    .join("\n");
  return page(
    "Recent commands",
    `<h1>Recent commands</h1>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr><th>Tool</th><th>Time</th><th>Status</th><th>Error</th><th>Input</th><th>Output</th><th>Task</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
  );
}

/** Best-effort link back to the trigger's originating comment/thread (design §1). No link when the ref doesn't carry enough. */
export function triggerLink(task: Task): { label: string; href?: string } {
  const ref = task.sourceRef;
  if (task.sourceType === "github") {
    const repo = ref.repo;
    const number = ref.number ?? ref.prNumber ?? ref.docPrNumber;
    if (typeof repo === "string" && typeof number === "number") {
      const path = ref.kind === "issue" ? "issues" : "pull";
      const commentId = ref.comment_id;
      const href =
        typeof commentId === "number" || typeof commentId === "string"
          ? `https://github.com/${repo}/${path}/${number}#issuecomment-${commentId}`
          : `https://github.com/${repo}/${path}/${number}`;
      return { label: `${repo}#${number}`, href };
    }
  } else if (task.sourceType === "slack") {
    const channel = ref.channel;
    const threadTs = ref.thread_ts;
    if (typeof channel === "string" && typeof threadTs === "string") {
      return { label: `slack ${channel}/${threadTs}` };
    }
  }
  return { label: task.sourceType };
}

function renderTimelineEvent(e: TimelineEvent): string {
  const detail = e.detail ? safe(JSON.stringify(e.detail)) : "";
  return `<tr>
  <td>${safe(e.at.toISOString())}</td>
  <td>${safe(e.type)}</td>
  <td>${safe(e.status)}</td>
  <td>${safe(e.summary)}</td>
  <td>${detail}</td>
</tr>`;
}

function renderTaskLink(t: Task): string {
  return `<a href="/tasks/${encodeURIComponent(t.id)}">${safe(t.id)}</a> (${safe(t.status)})`;
}

function renderRelatedTasks(related: RelatedTasks): string {
  const ancestors = related.ancestors.length
    ? `<ul>${related.ancestors.map((t) => `<li>${renderTaskLink(t)}</li>`).join("")}</ul>`
    : "<p>none</p>";
  const descendant = related.latestDescendant
    ? `<p>Latest: ${renderTaskLink(related.latestDescendant)} (${related.descendantCount} total)</p>`
    : "<p>none</p>";
  const siblings = related.siblings.length
    ? `<ul>${related.siblings.map((t) => `<li>${renderTaskLink(t)}</li>`).join("")}</ul>`
    : "<p>none</p>";
  return `<h2>Related tasks</h2>
<h3>Chain ancestry</h3>
${ancestors}
<h3>Descendants</h3>
${descendant}
<h3>Thread/PR siblings</h3>
${siblings}`;
}

/** Detail page: Trigger, Prompt, Timeline, Related Tasks (design §Detail page). */
export function renderTaskDetailPage(task: Task, report: TaskReport, related: RelatedTasks): string {
  const trigger = triggerLink(task);
  const triggerHtml = trigger.href
    ? `<a href="${escapeHtml(trigger.href)}">${safe(trigger.label)}</a>`
    : safe(trigger.label);
  const timelineRows = report.timeline.map(renderTimelineEvent).join("\n");
  return page(
    `Task ${task.id}`,
    `<h1>Task ${safe(task.id)}</h1>
<p>Status: ${safe(task.status)} — cost: $${report.costUsd.toFixed(4)} — ${report.modelCalls} model call(s), ${report.toolCalls} tool call(s), ${report.failures.length} failure(s)</p>

<h2>Trigger</h2>
<p>${safe(task.sourceType)}: ${triggerHtml}</p>

<h2>Prompt</h2>
<pre>${safe(task.inputText)}</pre>

<h2>Timeline</h2>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Summary</th><th>Detail</th></tr></thead>
<tbody>
${timelineRows}
</tbody>
</table>

${renderRelatedTasks(related)}`,
  );
}
