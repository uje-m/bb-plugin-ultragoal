import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissionMode, resolveGoalSettings, type GoalSettingDefaults, type GoalSettingOverrides } from "./goal-settings.ts";

describe("spawned agent permission mode", () => {
  it("accepts the two modes that deliberately weaken the approval gate", () => {
    assert.equal(normalizePermissionMode("full"), "full");
    assert.equal(normalizePermissionMode("accept-edits"), "accept-edits");
    assert.equal(normalizePermissionMode(" FULL "), "full");
  });

  it("falls back to auto for anything it does not recognise", () => {
    // A typo must never silently hand a spawned agent full access. Every
    // unrecognised value resolves to the mode that still asks.
    for (const value of ["", "  ", "yes", "true", "always", "full-access", "none", null, undefined]) {
      assert.equal(normalizePermissionMode(value), "auto", `for ${JSON.stringify(value)}`);
    }
  });
});

describe("safety-sensitive goal defaults", () => {
  it("keeps repository mutation and provider-store reads off without explicit overrides", () => {
    const defaults: GoalSettingDefaults = {
      verifyByDefault: true,
      verifyProvider: "codex",
      verifyModel: "gpt-5.6-sol",
      verifyReasoning: "",
      verifyServiceTier: "",
      autoContinue: true,
      progressUpdateMinutes: 5,
      maxWorkers: 5,
      maxOpenFindings: 50,
      autoApproveAgentRequests: false,
      workerPermissionMode: "auto",
      workerProvider: "",
      workerModel: "",
      workerReasoning: "",
      workerServiceTier: "",
      autoIntegrateCompletedSlices: false,
      reclaimMergedWorktrees: false,
      readLocalProviderData: false,
      shareWorktreeNodeModules: true,
    };
    const settings = resolveGoalSettings(
      {
        verifyEnabled: null,
        verifyProvider: null,
        verifyModel: null,
        verifyReasoning: null,
        verifyServiceTier: null,
        autoContinue: null,
        progressUpdateMinutes: null,
        maxWorkers: null,
        maxOpenFindings: null,
        workerProvider: null,
        workerModel: null,
        workerReasoning: null,
        workerServiceTier: null,
        autoIntegrateCompletedSlices: null,
        reclaimMergedWorktrees: null,
        readLocalProviderData: null,
      },
      defaults,
    );
    assert.equal(settings.autoIntegrateCompletedSlices, false);
    assert.equal(settings.reclaimMergedWorktrees, false);
    assert.equal(settings.readLocalProviderData, false);
  });
});

describe("live global execution defaults", () => {
  const defaultsWith = (over: Partial<GoalSettingDefaults> = {}): GoalSettingDefaults => ({
    verifyByDefault: true,
    verifyProvider: "codex",
    verifyModel: "gpt-5.6-sol",
    verifyReasoning: "xhigh",
    verifyServiceTier: "default",
    autoContinue: true,
    progressUpdateMinutes: 5,
    maxWorkers: 5,
    maxOpenFindings: 50,
    autoApproveAgentRequests: false,
    workerPermissionMode: "auto",
    workerProvider: "litellm",
    workerModel: "tencent-deepseek-flash",
    workerReasoning: "high",
    workerServiceTier: "fast",
    autoIntegrateCompletedSlices: false,
    reclaimMergedWorktrees: false,
    readLocalProviderData: false,
    shareWorktreeNodeModules: true,
    ...over,
  });

  const overridesWith = (over: Partial<GoalSettingOverrides> = {}): GoalSettingOverrides => ({
    verifyEnabled: null,
    verifyProvider: null,
    verifyModel: null,
    verifyReasoning: null,
    verifyServiceTier: null,
    autoContinue: null,
    progressUpdateMinutes: null,
    maxWorkers: null,
    maxOpenFindings: null,
    workerProvider: null,
    workerModel: null,
    workerReasoning: null,
    workerServiceTier: null,
    autoIntegrateCompletedSlices: null,
    reclaimMergedWorktrees: null,
    readLocalProviderData: null,
    ...over,
  });

  it("resolves every unpinned execution field from the current global default", () => {
    const settings = resolveGoalSettings(overridesWith(), defaultsWith());
    assert.equal(settings.workerProvider, "litellm");
    assert.equal(settings.workerModel, "tencent-deepseek-flash");
    assert.equal(settings.workerReasoning, "high");
    assert.equal(settings.workerServiceTier, "fast");
    assert.equal(settings.verifyProvider, "codex");
    assert.equal(settings.verifyModel, "gpt-5.6-sol");
    assert.equal(settings.verifyReasoning, "xhigh");
    assert.equal(settings.verifyServiceTier, "default");
  });

  it("follows each changed global default with no stored goal pin", () => {
    const settings = resolveGoalSettings(
      overridesWith(),
      defaultsWith({
        workerProvider: "claude-code",
        workerModel: "claude-sonnet-5",
        workerReasoning: "low",
        workerServiceTier: "default",
        verifyProvider: "litellm",
        verifyModel: "tencent-deepseek-flash",
        verifyReasoning: "max",
        verifyServiceTier: "fast",
      }),
    );
    assert.equal(settings.workerProvider, "claude-code");
    assert.equal(settings.workerModel, "claude-sonnet-5");
    assert.equal(settings.workerReasoning, "low");
    assert.equal(settings.workerServiceTier, "default");
    assert.equal(settings.verifyProvider, "litellm");
    assert.equal(settings.verifyModel, "tencent-deepseek-flash");
    assert.equal(settings.verifyReasoning, "max");
    assert.equal(settings.verifyServiceTier, "fast");
  });

  it("keeps an explicit pin over every changed global default", () => {
    const settings = resolveGoalSettings(
      overridesWith({
        workerProvider: "codex",
        workerModel: "gpt-5.6-sol",
        workerReasoning: "low",
        workerServiceTier: "default",
        verifyProvider: "claude-code",
        verifyModel: "claude-sonnet-5",
        verifyReasoning: "max",
        verifyServiceTier: "fast",
      }),
      defaultsWith({
        workerProvider: "litellm",
        workerModel: "tencent-deepseek-flash",
        workerReasoning: "high",
        workerServiceTier: "fast",
        verifyProvider: "codex",
        verifyModel: "gpt-5.6-sol",
        verifyReasoning: "xhigh",
        verifyServiceTier: "default",
      }),
    );
    assert.equal(settings.workerProvider, "codex");
    assert.equal(settings.workerModel, "gpt-5.6-sol");
    assert.equal(settings.workerReasoning, "low");
    assert.equal(settings.workerServiceTier, "default");
    assert.equal(settings.verifyProvider, "claude-code");
    assert.equal(settings.verifyModel, "claude-sonnet-5");
    assert.equal(settings.verifyReasoning, "max");
    assert.equal(settings.verifyServiceTier, "fast");
  });

  it("changing a global default writes no stored override", () => {
    const overrides = Object.freeze(
      overridesWith({ workerProvider: "codex", verifyReasoning: "low" }),
    );
    const before = JSON.stringify(overrides);
    const first = resolveGoalSettings(overrides, defaultsWith());
    const second = resolveGoalSettings(
      overrides,
      defaultsWith({ workerProvider: "litellm", verifyReasoning: "max" }),
    );
    assert.equal(JSON.stringify(overrides), before, "resolving mutated the stored overrides");
    assert.equal(first.workerProvider, "codex");
    assert.equal(second.workerProvider, "codex");
    assert.equal(first.verifyReasoning, "low");
    assert.equal(second.verifyReasoning, "low");
  });

  it("keeps a reasoning and service-tier pin when the worker provider default is empty", () => {
    // The obsolete provider-gates-reasoning force-clear discarded a pin like
    // this one; an unpinned provider must not clear a pinned level or tier.
    const settings = resolveGoalSettings(
      overridesWith({ workerReasoning: "high", workerServiceTier: "fast" }),
      defaultsWith({
        workerProvider: "",
        workerModel: "",
        workerReasoning: "",
        workerServiceTier: "",
      }),
    );
    assert.equal(settings.workerProvider, "");
    assert.equal(settings.workerReasoning, "high");
    assert.equal(settings.workerServiceTier, "fast");
  });

  it("keeps the unpinned sentinels when no global default is set", () => {
    const settings = resolveGoalSettings(
      overridesWith(),
      defaultsWith({
        workerReasoning: "",
        workerServiceTier: "",
        verifyReasoning: "",
        verifyServiceTier: "",
      }),
    );
    assert.equal(settings.workerReasoning, "");
    assert.equal(settings.workerServiceTier, null);
    assert.equal(settings.verifyReasoning, "medium");
    assert.equal(settings.verifyServiceTier, null);
  });

  it("trims a whitespace-only stored pin to unpinned", () => {
    const settings = resolveGoalSettings(
      overridesWith({
        workerProvider: "   ",
        workerModel: "\t",
        workerReasoning: "  ",
        workerServiceTier: "\n",
        verifyReasoning: " ",
        verifyServiceTier: "\t ",
      }),
      defaultsWith(),
    );
    assert.equal(settings.workerProvider, "litellm");
    assert.equal(settings.workerModel, "tencent-deepseek-flash");
    assert.equal(settings.workerReasoning, "high");
    assert.equal(settings.workerServiceTier, "fast");
    assert.equal(settings.verifyReasoning, "xhigh");
    assert.equal(settings.verifyServiceTier, "default");
  });

  it("refuses an unrecognised stored value or global default by field and value", () => {
    const refuses = (
      overrides: GoalSettingOverrides,
      defaults: GoalSettingDefaults,
      field: RegExp,
      value: RegExp,
    ) => {
      assert.throws(
        () => resolveGoalSettings(overrides, defaults),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, field, `message must name the field: ${message}`);
          assert.match(message, value, `message must name the value: ${message}`);
          return true;
        },
      );
    };

    refuses(overridesWith({ workerReasoning: "turbo" }), defaultsWith(), /workerReasoning/, /turbo/);
    refuses(overridesWith({ verifyReasoning: "turbo" }), defaultsWith(), /verifyReasoning/, /turbo/);
    refuses(
      overridesWith({ workerServiceTier: "turbo" }),
      defaultsWith(),
      /workerServiceTier/,
      /turbo/,
    );
    refuses(
      overridesWith({ verifyServiceTier: "turbo" }),
      defaultsWith(),
      /verifyServiceTier/,
      /turbo/,
    );
    refuses(overridesWith(), defaultsWith({ workerReasoning: "turbo" }), /workerReasoning/, /turbo/);
    refuses(
      overridesWith(),
      defaultsWith({ verifyServiceTier: "turbo" }),
      /verifyServiceTier/,
      /turbo/,
    );
  });

  it("keeps a valid non-default level instead of downgrading it", () => {
    const settings = resolveGoalSettings(
      overridesWith({ workerReasoning: "ultra" }),
      defaultsWith(),
    );
    assert.equal(settings.workerReasoning, "ultra");
  });
});
