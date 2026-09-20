import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  isReasoningLevel,
  isServiceTier,
  type EffectiveExecutionSelection,
  type ReasoningLevel,
  type ServiceTier,
} from "./execution.js";

export const DEFAULT_VERIFY_PROVIDER = "codex";
export const DEFAULT_VERIFY_MODEL = "gpt-5.6-sol";
export const DEFAULT_PROGRESS_UPDATE_MINUTES = 5;
// Evidence-backed slot count: coordination gains for LLM agent teams peak
// around 3-5 workers and industry tooling caps near 8 (docs/architecture-research.md).
export const DEFAULT_MAX_WORKERS = 5;
export { DEFAULT_MAX_OPEN_FINDINGS } from "./scheduler.js";

export interface GoalSettingOverrides {
  verifyEnabled: boolean | null;
  verifyProvider: string | null;
  verifyModel: string | null;
  verifyReasoning: string | null;
  verifyServiceTier: string | null;
  autoContinue: boolean | null;
  progressUpdateMinutes: number | null;
  maxWorkers: number | null;
  maxOpenFindings: number | null;
  workerProvider: string | null;
  workerModel: string | null;
  workerReasoning: string | null;
  workerServiceTier: string | null;
  autoIntegrateCompletedSlices: boolean | null;
  reclaimMergedWorktrees: boolean | null;
  readLocalProviderData: boolean | null;
}

export interface ResolvedGoalSettings {
  verifyEnabled: boolean;
  verifyProvider: string;
  verifyModel: string;
  verifyReasoning: ReasoningLevel;
  verifyServiceTier: ServiceTier | null;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
  maxOpenFindings: number;
  workerProvider: string;
  workerModel: string;
  workerReasoning: ReasoningLevel | "";
  workerServiceTier: ServiceTier | null;
  /** Squash-merge completed managed slice branches into the goal's base branch. */
  autoIntegrateCompletedSlices: boolean;
  /** Delete clean managed worktrees and their branches after integration. */
  reclaimMergedWorktrees: boolean;
  /** Read provider-owned local session stores for token and native-child metadata. */
  readLocalProviderData: boolean;
}

/** The three permission modes bb exposes for a spawned thread. */
export type AgentPermissionMode = "auto" | "accept-edits" | "full";

/**
 * Anything but `auto` weakens the approval gate a spawned agent runs behind, so
 * an unrecognised value must fall back to the safe one rather than to whatever
 * the operator meant to type.
 */
export function normalizePermissionMode(value: string | null | undefined): AgentPermissionMode {
  const mode = (value ?? "").trim().toLowerCase();
  return mode === "full" || mode === "accept-edits" ? mode : "auto";
}

export interface GoalSettingDefaults {
  verifyByDefault: boolean;
  verifyProvider: string;
  verifyModel: string;
  /** Current global verifier reasoning default; `""` is unpinned. */
  verifyReasoning: string;
  /** Current global verifier service tier; `""` is unpinned. */
  verifyServiceTier: string;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
  maxOpenFindings: number;
  /** Off unless an operator deliberately opts in; see the setting's description. */
  autoApproveAgentRequests: boolean;
  workerPermissionMode: AgentPermissionMode;
  // Installation-level execution defaults are kept exactly as configured —
  // trimmed, never coerced — because an unrecognised value must reach
  // resolution, which refuses it by name instead of launching a selection
  // nobody chose. `""` is the unpinned sentinel for all six.
  /** Global worker provider default; `""` is unpinned (workers inherit the goal thread). */
  workerProvider: string;
  /** Global worker model default; `""` is unpinned. */
  workerModel: string;
  /** Global worker reasoning default; `""` is unpinned. */
  workerReasoning: string;
  /** Global worker service tier; `""` is unpinned. */
  workerServiceTier: string;
  /** Repository mutation is opt-in and resolved per goal. */
  autoIntegrateCompletedSlices: boolean;
  /** Remove a slice's worktree once its commits are on the base branch. */
  reclaimMergedWorktrees: boolean;
  /** Provider-owned local stores are private data and require explicit consent. */
  readLocalProviderData: boolean;
  shareWorktreeNodeModules: boolean;
}

/** `null` and a whitespace-only string both mean unpinned. */
function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The complete role selections a future launch would use: every explicit pin,
 * every unpinned field already replaced by its current global default.
 */
export interface EffectiveGoalExecutionSelections {
  worker: EffectiveExecutionSelection;
  verify: EffectiveExecutionSelection;
}

/**
 * The ONE place an unpinned execution field inherits its current global
 * default, for both roles. Resolution is a read: nothing is written back to a
 * goal row, so changing a global default moves every unpinned future launch and
 * no stored override.
 *
 * Values stay raw on the way out. An unrecognised value must reach
 * {@link resolveGoalSettings}, which refuses it by name; coercing it here would
 * launch a selection nobody chose.
 */
export function effectiveGoalExecutionSelections(
  overrides: GoalSettingOverrides,
  defaults: GoalSettingDefaults,
): EffectiveGoalExecutionSelections {
  const inherited = (
    pin: string | null | undefined,
    globalDefault: string | null | undefined,
  ): string | null => trimToNull(pin) ?? trimToNull(globalDefault);
  return {
    worker: {
      providerId: inherited(overrides.workerProvider, defaults.workerProvider),
      model: inherited(overrides.workerModel, defaults.workerModel),
      reasoningLevel: inherited(overrides.workerReasoning, defaults.workerReasoning),
      serviceTier: inherited(overrides.workerServiceTier, defaults.workerServiceTier),
    },
    verify: {
      providerId: inherited(overrides.verifyProvider, defaults.verifyProvider),
      model: inherited(overrides.verifyModel, defaults.verifyModel),
      reasoningLevel: inherited(overrides.verifyReasoning, defaults.verifyReasoning),
      serviceTier: inherited(overrides.verifyServiceTier, defaults.verifyServiceTier),
    },
  };
}

/**
 * A recognised reasoning level, or `null` when the field is unpinned. A
 * non-empty unrecognised value throws, naming the field and the value: it is
 * never coerced to a default or a neighbour.
 */
export function requireReasoningLevel(
  field: string,
  value: string | null | undefined,
): ReasoningLevel | null {
  const candidate = trimToNull(value);
  if (candidate === null) return null;
  if (isReasoningLevel(candidate)) return candidate;
  throw new Error(
    `Invalid ${field} "${candidate}": expected one of ${REASONING_LEVELS.join(", ")}. ` +
      `Set a recognised global default, pin a recognised ${field}, or clear the ${field} pin.`,
  );
}

/**
 * A recognised service tier, or `null` when the field is unpinned. A non-empty
 * unrecognised value throws, naming the field and the value: it is never
 * coerced to a default or a neighbour.
 */
export function requireServiceTier(
  field: string,
  value: string | null | undefined,
): ServiceTier | null {
  const candidate = trimToNull(value);
  if (candidate === null) return null;
  if (isServiceTier(candidate)) return candidate;
  throw new Error(
    `Invalid ${field} "${candidate}": expected "default" or "fast". ` +
      `Set a recognised global default, pin a recognised ${field}, or clear the ${field} pin.`,
  );
}

export function resolveGoalSettings(
  overrides: GoalSettingOverrides,
  defaults: GoalSettingDefaults,
): ResolvedGoalSettings {
  const execution = effectiveGoalExecutionSelections(overrides, defaults);
  return {
    verifyEnabled: overrides.verifyEnabled ?? defaults.verifyByDefault,
    verifyProvider: execution.verify.providerId ?? "",
    verifyModel: execution.verify.model ?? "",
    verifyReasoning:
      requireReasoningLevel("verifyReasoning", execution.verify.reasoningLevel) ??
      DEFAULT_REASONING_LEVEL,
    verifyServiceTier: requireServiceTier("verifyServiceTier", execution.verify.serviceTier),
    autoContinue: overrides.autoContinue ?? defaults.autoContinue,
    progressUpdateMinutes:
      overrides.progressUpdateMinutes ?? defaults.progressUpdateMinutes,
    maxWorkers: overrides.maxWorkers ?? defaults.maxWorkers,
    maxOpenFindings: overrides.maxOpenFindings ?? defaults.maxOpenFindings,
    workerProvider: execution.worker.providerId ?? "",
    workerModel: execution.worker.model ?? "",
    workerReasoning:
      requireReasoningLevel("workerReasoning", execution.worker.reasoningLevel) ?? "",
    workerServiceTier: requireServiceTier("workerServiceTier", execution.worker.serviceTier),
    autoIntegrateCompletedSlices:
      overrides.autoIntegrateCompletedSlices ?? defaults.autoIntegrateCompletedSlices,
    reclaimMergedWorktrees:
      overrides.reclaimMergedWorktrees ?? defaults.reclaimMergedWorktrees,
    readLocalProviderData:
      overrides.readLocalProviderData ?? defaults.readLocalProviderData,
  };
}
