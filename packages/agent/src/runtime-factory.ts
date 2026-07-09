import { type AgentSpec, type SecretStore, validateHarnessConfig } from "@marathon/config";
import type { ModelRegistry } from "@marathon/model-gateway";
import { ClaudeCodeAgentRuntime, type ClaudeCodeAgentOptions } from "./claude-code";
import { CodexAgentRuntime, type CodexAgentOptions } from "./codex";
import { PiAgentRuntime, type GovernedToolsConfig, type PiAgentOptions } from "./pi";
import type { AgentRuntime } from "./types";

/**
 * The shared harness factory (K7, design §7.5): pick the `AgentRuntime` from the
 * agent spec's `harness` field, so the harness is selectable per deployment with
 * the worker step runners untouched — the seam holds. Used at the BUILD wiring
 * site (github-app) AND the chat surfaces (§2b #17): `claude-code` runs its
 * whole loop inside a per-task container, so it needs a workspace binding, the
 * container factory, and the model proxy — BUILD tasks materialize a repo
 * workspace; chat tasks get an ephemeral scratch one via `withChatWorkspace`.
 * `claude-code`'s harness/model pairing is cross-validated fail-closed (§13.1)
 * before a runtime is built.
 */
export interface MakeAgentRuntimeDeps {
  secrets: SecretStore;
  registry?: ModelRegistry;
  sessionDir?: string;
  governed?: GovernedToolsConfig;
  clarification?: boolean;
  /**
   * Container factory derived from the task workspace (`workspaceSandboxFromSpec`).
   * Pattern 2 for Pi (routes bash/read/write/edit into it); Pattern 1 for Claude
   * Code (runs the whole CLI inside it). Its `createContainer` accepts an optional
   * third arg with extra mounts, which the Claude runtime uses for the broker socket.
   */
  sandbox?: PiAgentOptions["sandbox"];
  builtinTools?: string[];
  /** Claude Code: the model proxy endpoint + upstream (§4.1). */
  proxy?: ClaudeCodeAgentOptions["proxy"];
  /** Claude Code: checkpoint cadence (§2.1). */
  maxTurnsPerInvocation?: number;
  /** Claude Code: locked-down egress posture disallows `WebFetch` (§3.3). */
  lockedDownEgress?: boolean;
  /** Claude Code: read-only tool surface for chat grounding (chat-repo.md §3.4). */
  readOnly?: boolean;
  /** Claude Code: reach the broker over TCP at this host (macOS Docker Desktop, §3.1). */
  brokerHost?: string;
  /** Claude Code: CLI/shim overrides. Codex reads `bin`/`shimCommand`/`shimArgs` from the same shape. */
  cli?: ClaudeCodeAgentOptions["cli"];
  /** Claude Code: host dir for per-task broker sockets. Codex reuses it. */
  socketDir?: string;
  /** Claude Code / Codex: per-turn remaining task budget for the mid-invocation kill (§4.3). */
  getRemainingBudgetUsd?: ClaudeCodeAgentOptions["getRemainingBudgetUsd"];
  /**
   * Codex (K8): optional Marathon-side wall-clock watchdog per `codex exec`
   * invocation (codex-cli-impl.md §2.1). SIGTERMs a runaway and fails the turn
   * under the mid-turn discard rule; unset → uncapped (K7 as-built parity).
   */
  maxWallClockMsPerInvocation?: number;
  /**
   * Codex (K8): subpath under `$CODEX_HOME` holding session state for
   * snapshot/restore (verify-on-pin #7; default "sessions").
   */
  sessionsSubdir?: string;
}

export function makeAgentRuntime(spec: AgentSpec, deps: MakeAgentRuntimeDeps): AgentRuntime {
  if (spec.harness === "claude-code") {
    // Fail closed before building: Anthropic model policy (§13.1). The model
    // proxy is NOT required here — direct key injection is the bridge default
    // and the runtime enforces the posture-specific proxy rule (§4.1).
    validateHarnessConfig(spec);
    if (!deps.sandbox) {
      throw new Error(`agent '${spec.name}': harness 'claude-code' requires a sandbox container factory`);
    }
    return new ClaudeCodeAgentRuntime({
      secrets: deps.secrets,
      registry: deps.registry,
      sessionDir: deps.sessionDir,
      // The workspace factory's createContainer takes the optional mounts arg.
      sandbox: deps.sandbox as ClaudeCodeAgentOptions["sandbox"],
      governed: deps.governed,
      proxy: deps.proxy,
      maxTurnsPerInvocation: deps.maxTurnsPerInvocation,
      clarification: deps.clarification,
      lockedDownEgress: deps.lockedDownEgress,
      readOnly: deps.readOnly,
      brokerHost: deps.brokerHost,
      cli: deps.cli,
      socketDir: deps.socketDir,
      getRemainingBudgetUsd: deps.getRemainingBudgetUsd,
    });
  }
  if (spec.harness === "codex") {
    // Fail closed before building: OpenAI model policy (§13.1). The OpenAI proxy
    // component does not exist yet, so locked-down egress (`network: none`) fails
    // closed at the BUILD wiring (codex-cli-impl.md §4.1), not here.
    validateHarnessConfig(spec);
    if (!deps.sandbox) {
      throw new Error(`agent '${spec.name}': harness 'codex' requires a sandbox container factory`);
    }
    return new CodexAgentRuntime({
      secrets: deps.secrets,
      registry: deps.registry,
      sessionDir: deps.sessionDir,
      sandbox: deps.sandbox as CodexAgentOptions["sandbox"],
      governed: deps.governed,
      clarification: deps.clarification,
      lockedDownEgress: deps.lockedDownEgress,
      readOnly: deps.readOnly,
      brokerHost: deps.brokerHost,
      cli: deps.cli,
      socketDir: deps.socketDir,
      getRemainingBudgetUsd: deps.getRemainingBudgetUsd,
      maxWallClockMsPerInvocation: deps.maxWallClockMsPerInvocation,
      sessionsSubdir: deps.sessionsSubdir,
    });
  }
  return new PiAgentRuntime({
    secrets: deps.secrets,
    registry: deps.registry,
    sessionDir: deps.sessionDir,
    governed: deps.governed,
    clarification: deps.clarification,
    sandbox: deps.sandbox,
    builtinTools: deps.builtinTools,
  });
}
