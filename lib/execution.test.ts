import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  catalogModelsFromOptions,
  formatExecutionSelectionIssues,
  reconcileReasoningLevel,
  selectionForModel,
  selectionForProvider,
  stripBrandPrefix,
  validateExecutionSelection,
  type CatalogProvider,
  type ExecutionCatalog,
  type ExecutionSelectionValidation,
} from "./execution.ts";

describe("reconcileReasoningLevel", () => {
  it("keeps a supported level", () => {
    assert.equal(reconcileReasoningLevel("high", ["low", "medium", "high"]), "high");
  });

  it("picks the closest higher level on a tie", () => {
    assert.equal(reconcileReasoningLevel("medium", ["low", "high"]), "high");
  });

  it("treats ultracode as xhigh", () => {
    assert.equal(reconcileReasoningLevel("ultracode", ["high", "xhigh", "max"]), "xhigh");
  });
});

describe("stripBrandPrefix", () => {
  it("drops the Codex GPT- prefix", () => {
    assert.equal(stripBrandPrefix("GPT-5.6-Sol", "codex"), "5.6-Sol");
  });

  it("drops a declared Claude prefix", () => {
    assert.equal(stripBrandPrefix("Claude Sonnet 4.6", "claude-code", "Claude "), "Sonnet 4.6");
  });
});

const catalog: CatalogProvider = {
  id: "codex",
  displayName: "Codex",
  available: true,
  supportsServiceTier: true,
  models: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoning: "medium",
      reasoning: ["medium", "high", "xhigh"],
    },
    {
      id: "gpt-light",
      displayName: "GPT Light",
      reasoning: ["low"],
    },
  ],
};

describe("selectionForProvider / selectionForModel", () => {
  it("pins the default model and keeps a supported service tier", () => {
    assert.deepEqual(selectionForProvider(catalog, "high", "fast"), {
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

  it("reconciles reasoning and drops service tier on a model without it", () => {
    const claude: CatalogProvider = {
      ...catalog,
      id: "claude-code",
      displayName: "Claude Code",
      supportsServiceTier: false,
    };
    assert.deepEqual(selectionForModel(claude, "gpt-light", "high", "fast"), {
      providerId: "claude-code",
      model: "gpt-light",
      reasoningLevel: "low",
      serviceTier: null,
    });
  });
});

const openCatalog: ExecutionCatalog = { providers: [catalog], available: true };

function refusalText(result: ExecutionSelectionValidation): string {
  if (result.ok) assert.fail(`expected a refusal, got ${JSON.stringify(result.selection)}`);
  return formatExecutionSelectionIssues(result.issues);
}

describe("validateExecutionSelection", () => {
  it("accepts a complete valid selection and narrows blank strings to null", () => {
    const result = validateExecutionSelection(
      {
        providerId: " codex ",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      openCatalog,
    );
    assert.deepEqual(result, {
      ok: true,
      selection: {
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
    });

    const blank = validateExecutionSelection(
      { providerId: "  ", model: "", reasoningLevel: null, serviceTier: " " },
      { providers: [], available: false },
    );
    assert.deepEqual(blank, {
      ok: true,
      selection: { providerId: null, model: null, reasoningLevel: null, serviceTier: null },
    });
  });

  it("accepts an entirely unpinned selection without a catalog", () => {
    const result = validateExecutionSelection(
      { providerId: null, model: null, reasoningLevel: null, serviceTier: null },
      { providers: [], available: false },
    );
    assert.deepEqual(result, {
      ok: true,
      selection: { providerId: null, model: null, reasoningLevel: null, serviceTier: null },
    });
  });

  it("rejects unknown provider/model/reasoning/tier naming field and value", () => {
    const cases = [
      [{ providerId: "ghost" }, /providerId "ghost"/],
      [{ providerId: "codex", model: "gpt-9" }, /model "gpt-9"/],
      [{ providerId: "codex", reasoningLevel: "ultra-fast" }, /reasoningLevel "ultra-fast"/],
      [{ providerId: "codex", serviceTier: "turbo" }, /serviceTier "turbo"/],
    ] as const;
    for (const [pin, pattern] of cases) {
      const result = validateExecutionSelection(pin, openCatalog);
      assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(pin)}`);
      assert.match(refusalText(result), pattern);
    }
  });

  it("reports every refusal it can name instead of stopping at the first", () => {
    const text = refusalText(
      validateExecutionSelection(
        { providerId: "ghost", reasoningLevel: "ultra-fast", serviceTier: "turbo" },
        openCatalog,
      ),
    );
    assert.match(text, /providerId "ghost"/);
    assert.match(text, /reasoningLevel "ultra-fast"/);
    assert.match(text, /serviceTier "turbo"/);
  });

  it("refuses an unsupported reasoning level instead of reconciling it", () => {
    const result = validateExecutionSelection(
      { providerId: "codex", model: "gpt-light", reasoningLevel: "high" },
      openCatalog,
    );
    assert.equal(result.ok, false, "a low-only model must not climb to a neighbour");
    const text = refusalText(result);
    assert.match(text, /reasoningLevel "high"/);
    assert.match(text, /gpt-light/);

    const accepted = validateExecutionSelection(
      { providerId: "codex", model: "gpt-light", reasoningLevel: "low" },
      openCatalog,
    );
    assert.deepEqual(accepted, {
      ok: true,
      selection: {
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
        serviceTier: null,
      },
    });
  });

  it("checks reasoning against the provider's default model when no model is pinned", () => {
    const text = refusalText(
      validateExecutionSelection({ providerId: "codex", reasoningLevel: "max" }, openCatalog),
    );
    assert.match(text, /reasoningLevel "max"/);
    assert.match(text, /gpt-5\.6-sol/);
  });

  it("preserves a model pin whose provider is still inherited", () => {
    const result = validateExecutionSelection(
      { model: "gpt-5.6-sol", reasoningLevel: "high", serviceTier: "fast" },
      openCatalog,
    );
    assert.deepEqual(result, {
      ok: true,
      selection: {
        providerId: null,
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
    });
  });

  it("fails closed for any concrete pin when the catalog is unavailable", () => {
    const result = validateExecutionSelection(
      { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "high", serviceTier: "fast" },
      { providers: [], available: false },
    );
    assert.equal(result.ok, false);
    assert.match(refusalText(result), /catalog is unavailable/i);

    const modelOnly = validateExecutionSelection(
      { model: "gpt-5.6-sol" },
      { providers: [], available: false },
    );
    assert.equal(modelOnly.ok, false, "an unvalidatable pin must not launch blind");
    assert.match(refusalText(modelOnly), /model "gpt-5\.6-sol"/);
  });

  it("rejects a provider this environment reports as unavailable", () => {
    const text = refusalText(
      validateExecutionSelection(
        { providerId: "offline" },
        { providers: [{ ...catalog, id: "offline", available: false }], available: true },
      ),
    );
    assert.match(text, /providerId "offline"/);
    assert.match(text, /not available/i);
  });

  it("fails closed when the provider declares no models and reasoning is pinned", () => {
    const text = refusalText(
      validateExecutionSelection(
        { providerId: "codex", reasoningLevel: "high" },
        { providers: [{ ...catalog, models: [] }], available: true },
      ),
    );
    assert.match(text, /reasoningLevel "high"/);
    assert.match(text, /model list/i);
  });

  it("refuses a fast tier on a provider without service-tier support but passes default", () => {
    const claude: CatalogProvider = {
      ...catalog,
      id: "claude-code",
      displayName: "Claude Code",
      supportsServiceTier: false,
    };
    const text = refusalText(
      validateExecutionSelection(
        { providerId: "claude-code", serviceTier: "fast" },
        { providers: [claude], available: true },
      ),
    );
    assert.match(text, /serviceTier "fast"/);
    assert.match(text, /claude-code/);

    const neutral = validateExecutionSelection(
      { providerId: "claude-code", serviceTier: "default" },
      { providers: [claude], available: true },
    );
    assert.deepEqual(neutral, {
      ok: true,
      selection: {
        providerId: "claude-code",
        model: null,
        reasoningLevel: null,
        serviceTier: "default",
      },
    });
  });

  it("reads the catalog and the selection without mutating either", () => {
    const catalogBefore = structuredClone(openCatalog);
    const pin = {
      providerId: "codex",
      model: "gpt-light",
      reasoningLevel: "high",
      serviceTier: "fast",
    };
    const pinBefore = structuredClone(pin);
    assert.equal(validateExecutionSelection(pin, openCatalog).ok, false);
    assert.deepEqual(openCatalog, catalogBefore);
    assert.deepEqual(pin, pinBefore);
  });

  it("formats one refusal sentence per issue, each naming field and value", () => {
    const result = validateExecutionSelection(
      { providerId: "ghost", reasoningLevel: "ultra-fast" },
      openCatalog,
    );
    if (result.ok) assert.fail("expected a refusal");
    const text = formatExecutionSelectionIssues(result.issues);
    for (const issue of result.issues) {
      assert.match(issue.message, new RegExp(issue.field));
      assert.ok(issue.message.includes(issue.value));
    }
    assert.equal(text, result.issues.map((issue) => issue.message).join(" "));
  });
});

describe("catalogModelsFromOptions", () => {
  it("keeps Pi nested routes instead of filtering them out", () => {
    const models = catalogModelsFromOptions(
      {
        models: [
          {
            id: "openrouter/anthropic/claude-sonnet-4.6",
            model: "openrouter/anthropic/claude-sonnet-4.6",
            displayName: "Anthropic: Claude Sonnet 4.6",
            routeProviderId: "openrouter",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
      },
      "pi",
    );
    assert.equal(models.length, 1);
    assert.equal(models[0].routeProviderId, "openrouter");
    assert.equal(models[0].id, "openrouter/anthropic/claude-sonnet-4.6");
  });
});
