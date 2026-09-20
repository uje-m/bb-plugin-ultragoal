export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type ServiceTier = "default" | "fast";

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

/** Composer brand prefixes, used when the catalog does not declare one. */
export const BRAND_PREFIX: Record<string, string> = {
  codex: "GPT-",
  "claude-code": "Claude ",
};

export interface CatalogModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoning?: ReasoningLevel;
  reasoning: ReasoningLevel[];
  selectedOnly?: boolean;
  /** Nested route (Pi openrouter/anthropic/…). Qualifier only — never a filter. */
  routeProviderId?: string;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  available: boolean;
  supportsServiceTier: boolean;
  brandPrefix?: string;
  models: CatalogModel[];
}

export interface ExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | null;
}

export function isReasoningLevel(value: string | null | undefined): value is ReasoningLevel {
  return REASONING_LEVELS.includes(value as ReasoningLevel);
}

export function isServiceTier(value: string | null | undefined): value is ServiceTier {
  return value === "default" || value === "fast";
}

export function parseReasoningLevel(
  value: string | null | undefined,
  fallback: ReasoningLevel = DEFAULT_REASONING_LEVEL,
): ReasoningLevel {
  return isReasoningLevel(value) ? value : fallback;
}

export function parseServiceTier(value: string | null | undefined): ServiceTier | null {
  return isServiceTier(value) ? value : null;
}

export function stripBrandPrefix(
  label: string,
  providerId: string,
  declared?: string,
): string {
  const prefix = declared || BRAND_PREFIX[providerId];
  if (!prefix) return label;
  return label.toLowerCase().startsWith(prefix.toLowerCase())
    ? label.slice(prefix.length).trimStart()
    : label;
}

export function formatModelLabel(value: string): string {
  return value
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (/^[a-z]+$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join("-");
}

/**
 * Composer policy: keep the previous level when the new model supports it;
 * otherwise pick the closest supported level, breaking ties upward.
 */
export function reconcileReasoningLevel(
  previous: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ReasoningLevel {
  if (supported.length === 0) return previous;
  if (supported.includes(previous)) return previous;
  const effectivePrevious = previous === "ultracode" ? "xhigh" : previous;
  if (supported.includes(effectivePrevious)) return effectivePrevious;

  const previousRank = REASONING_LEVELS.indexOf(effectivePrevious);
  let bestLevel = supported[0];
  let bestDistance = Math.abs(REASONING_LEVELS.indexOf(bestLevel) - previousRank);
  for (const candidate of supported.slice(1)) {
    const distance = Math.abs(REASONING_LEVELS.indexOf(candidate) - previousRank);
    if (distance < bestDistance) {
      bestLevel = candidate;
      bestDistance = distance;
      continue;
    }
    if (
      distance === bestDistance &&
      REASONING_LEVELS.indexOf(candidate) > REASONING_LEVELS.indexOf(bestLevel)
    ) {
      bestLevel = candidate;
    }
  }
  return bestLevel;
}

export function defaultModelOf(provider: CatalogProvider | undefined): CatalogModel | undefined {
  if (!provider || provider.models.length === 0) return undefined;
  return provider.models.find((model) => model.isDefault && !model.selectedOnly) ??
    provider.models.find((model) => !model.selectedOnly) ??
    provider.models[0];
}

/**
 * One role's complete effective selection: the values a launch actually uses
 * after explicit pins were folded over the current global defaults. `null` (or
 * a blank string) is the unpinned sentinel — for `providerId` it means the role
 * inherits the goal thread's provider, which only the launch path can resolve.
 */
export interface EffectiveExecutionSelection {
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
}

/**
 * The availability catalog a selection is judged against, plus whether the host
 * answered at all. An empty or failed load is `available: false`: that catalog
 * can describe a selection but can never validate one.
 */
export interface ExecutionCatalog {
  providers: readonly CatalogProvider[];
  available: boolean;
}

export type ExecutionSelectionField = keyof EffectiveExecutionSelection;

export interface ExecutionSelectionIssue {
  field: ExecutionSelectionField;
  /** The offending value, verbatim: never rewritten to a neighbour. */
  value: string;
  message: string;
}

export type ExecutionSelectionValidation =
  | { ok: true; selection: EffectiveExecutionSelection }
  | { ok: false; issues: readonly ExecutionSelectionIssue[] };

/**
 * Whole-selection availability check for one role. Pure: it reads the catalog
 * it is handed and edits nothing. It refuses instead of reconciling, so an
 * unsupported reasoning level never climbs to a neighbour, an unrecognised
 * value is refused by name, and any concrete pin fails closed when the catalog
 * could not be loaded. A model/reasoning/tier pin whose provider is still
 * inherited cannot be judged here; it is preserved, never cleared.
 */
export function validateExecutionSelection(
  pin: Partial<EffectiveExecutionSelection>,
  catalog: ExecutionCatalog,
): ExecutionSelectionValidation {
  const providerId = pin.providerId?.trim() || null;
  const model = pin.model?.trim() || null;
  const rawReasoning = pin.reasoningLevel?.trim() ?? "";
  const rawTier = pin.serviceTier?.trim() ?? "";
  const issues: ExecutionSelectionIssue[] = [];

  let reasoningLevel: ReasoningLevel | null = null;
  if (rawReasoning) {
    if (isReasoningLevel(rawReasoning)) {
      reasoningLevel = rawReasoning;
    } else {
      issues.push({
        field: "reasoningLevel",
        value: rawReasoning,
        message:
          `reasoningLevel "${rawReasoning}" is not a recognised level ` +
          `(use one of ${REASONING_LEVELS.join(", ")}); ` +
          "pin a recognised level or clear the reasoning-level pin.",
      });
    }
  }

  let serviceTier: ServiceTier | null = null;
  if (rawTier) {
    if (isServiceTier(rawTier)) {
      serviceTier = rawTier;
    } else {
      issues.push({
        field: "serviceTier",
        value: rawTier,
        message:
          `serviceTier "${rawTier}" is not a recognised tier ` +
          '(use "default" or "fast"); ' +
          "pin a recognised tier or clear the service-tier pin.",
      });
    }
  }

  // Nothing concrete: every field inherits at launch, so this catalog cannot
  // contradict the selection and an unavailable catalog is not a refusal.
  if (!providerId && !model && !rawReasoning && !rawTier) {
    return issues.length > 0
      ? { ok: false, issues }
      : {
          ok: true,
          selection: {
            providerId: null,
            model: null,
            reasoningLevel: null,
            serviceTier: null,
          },
        };
  }

  if (!catalog.available) {
    const field: ExecutionSelectionField = providerId
      ? "providerId"
      : model
        ? "model"
        : rawReasoning
          ? "reasoningLevel"
          : "serviceTier";
    const value = providerId ?? model ?? rawReasoning ?? rawTier;
    issues.push({
      field,
      value,
      message:
        `the provider catalog is unavailable, so ${field} "${value}" cannot be ` +
        "validated against it; restore provider discovery, or clear the pinned " +
        "execution values.",
    });
    return { ok: false, issues };
  }

  // The provider is inherited from the goal thread and resolves only at launch,
  // so the pins below cannot be judged here. Refusing would force an operator
  // to invent a provider pin just to name a model; clearing them would discard
  // an explicit pin. Preserve them untouched.
  if (!providerId) {
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, selection: { providerId: null, model, reasoningLevel, serviceTier } };
  }

  const provider = catalog.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    const known = catalog.providers.map((entry) => entry.id).join(", ") || "none";
    issues.push({
      field: "providerId",
      value: providerId,
      message:
        `providerId "${providerId}" is not in this environment's provider catalog ` +
        `(available: ${known}); ` +
        "pin an existing provider, set a valid global default, or clear the provider pin.",
    });
    return { ok: false, issues };
  }
  if (!provider.available) {
    issues.push({
      field: "providerId",
      value: providerId,
      message:
        `providerId "${providerId}" is not available in this environment; ` +
        "pin an available provider, set a valid global default, or clear the provider pin.",
    });
    return { ok: false, issues };
  }

  let selected: CatalogModel | undefined;
  if (model) {
    selected = provider.models.find((entry) => entry.id === model);
    if (!selected) {
      const offered = provider.models.map((entry) => entry.id).join(", ") || "none";
      issues.push({
        field: "model",
        value: model,
        message:
          `model "${model}" is not offered by provider "${providerId}" ` +
          `(offered: ${offered}); ` +
          "pin a model of that provider or clear the model pin.",
      });
    }
  } else {
    selected = defaultModelOf(provider);
  }

  if (reasoningLevel) {
    if (selected) {
      if (!selected.reasoning.includes(reasoningLevel)) {
        const supported = selected.reasoning.join(", ") || "none declared";
        issues.push({
          field: "reasoningLevel",
          value: reasoningLevel,
          message:
            `reasoningLevel "${reasoningLevel}" is not supported by ` +
            `${providerId}/${selected.id} (supported: ${supported}); ` +
            "pin a supported level, set a compatible global default, or clear the reasoning pin.",
        });
      }
    } else if (!model) {
      issues.push({
        field: "reasoningLevel",
        value: reasoningLevel,
        message:
          `reasoningLevel "${reasoningLevel}" cannot be validated: provider ` +
          `"${providerId}" declares no model list; ` +
          "pin a model with a known reasoning list or clear the reasoning pin.",
      });
    }
  }

  // "default" is the provider's own mode, so only a tier above it needs the
  // provider's service-tier capability.
  if (serviceTier && serviceTier !== "default" && !provider.supportsServiceTier) {
    issues.push({
      field: "serviceTier",
      value: serviceTier,
      message:
        `serviceTier "${serviceTier}" is not supported by provider "${providerId}"; ` +
        "pin a provider that supports service tiers, set a compatible global " +
        "default, or clear the service-tier pin.",
    });
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, selection: { providerId, model, reasoningLevel, serviceTier } };
}

/** One refusal sentence per issue, each naming the field, the value and the remedy. */
export function formatExecutionSelectionIssues(
  issues: readonly ExecutionSelectionIssue[],
): string {
  return issues.map((issue) => issue.message).join(" ");
}

export function selectionForProvider(
  provider: CatalogProvider,
  preferredReasoning: ReasoningLevel = DEFAULT_REASONING_LEVEL,
  serviceTier: ServiceTier | null = null,
): ExecutionSelection | null {
  const model = defaultModelOf(provider);
  if (!model) return null;
  return {
    providerId: provider.id,
    model: model.id,
    reasoningLevel: reconcileReasoningLevel(
      preferredReasoning,
      model.reasoning.length > 0
        ? model.reasoning
        : [model.defaultReasoning ?? preferredReasoning],
    ),
    serviceTier: provider.supportsServiceTier ? serviceTier ?? "default" : null,
  };
}

export function catalogModelsFromOptions(
  options: {
    models?: readonly CatalogOptionRow[];
    selectedOnlyModels?: readonly CatalogOptionRow[];
  },
  providerId: string,
): CatalogModel[] {
  const selectedOnly = new Set(
    (options.selectedOnlyModels ?? []).map((model) => model.model || model.id),
  );
  const rows = [...(options.models ?? []), ...(options.selectedOnlyModels ?? [])];
  const seen = new Set<string>();
  const mapped: CatalogModel[] = [];
  for (const model of rows) {
    const reasoning = (model.supportedReasoningEfforts ?? [])
      .map((effort) => effort.reasoningEffort)
      .filter(isReasoningLevel);
    const defaultReasoning = isReasoningLevel(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined;
    const id = model.model || model.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const routeProviderId =
      model.routeProviderId && model.routeProviderId !== providerId
        ? model.routeProviderId
        : undefined;
    mapped.push({
      id,
      displayName: model.displayName || id,
      reasoning,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      ...(defaultReasoning ? { defaultReasoning } : {}),
      ...(selectedOnly.has(id) ? { selectedOnly: true } : {}),
      ...(routeProviderId ? { routeProviderId } : {}),
    });
  }
  return mapped;
}

export interface CatalogOptionRow {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  routeProviderId?: string;
  supportedReasoningEfforts?: readonly { reasoningEffort: string }[];
}

export function selectionForModel(
  provider: CatalogProvider,
  modelId: string,
  preferredReasoning: ReasoningLevel,
  serviceTier: ServiceTier | null,
): ExecutionSelection {
  const model =
    provider.models.find((entry) => entry.id === modelId) ?? defaultModelOf(provider);
  return {
    providerId: provider.id,
    model: model?.id ?? modelId,
    reasoningLevel: reconcileReasoningLevel(preferredReasoning, model?.reasoning ?? []),
    serviceTier: provider.supportsServiceTier ? serviceTier : null,
  };
}
