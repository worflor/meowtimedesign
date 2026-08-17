import { resolve } from "node:path";

import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";
import { describe, expect, it } from "vitest";

import { readIdentityRegistry } from "../src/identity/declaration/registry.ts";
import {
  declareDesktopReleaseWorkflow,
  createReleaseWorkflowRequestFromEnv,
  planReleaseWorkflow,
  registerScenarioReceipts,
} from "../src/workflow/index.ts";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function request(workflowDigest: string, input: Readonly<{
  activate: boolean;
  channel: string;
  publish: boolean;
  releaseVersion: string;
}> = { activate: true, channel: "beta", publish: true, releaseVersion: "0.19.4-beta.31" }) {
  return {
    formatVersion: 1,
    provenance: {
      actor: "PerishCode",
      event: "workflow_dispatch",
      repository: "nexu-io/open-design",
      runAttempt: 1,
      runId: "123",
      workflow: "release-beta",
    },
    release: {
      activate: input.activate,
      channel: input.channel,
      commit: "a".repeat(40),
      minShellVersion: input.releaseVersion,
      namespace: `release-${input.channel}`,
      nodeVersion: "24.18.0",
      packageManager: "pnpm@10.33.2",
      profile: "test",
      publicOrigin: "https://releases.example.com",
      publish: input.publish,
      releaseVersion: input.releaseVersion,
    },
    targets: [{
      buildTarget: "all",
      name: "win_x64",
      namespace: `release-${input.channel}-win`,
      nodeModulesAbi: "137",
      nodeNapi: "10",
      platform: "win32-x64",
      signMode: "unsigned",
      smokeMatrix: "win-shell-v2",
      standaloneProtocolVersion: 1,
    }],
    workflowDigest,
  };
}

describe("desktop ReleaseWorkflow", () => {
  it("builds the three-target request from one closed environment contract", () => {
    const prepared = createReleaseWorkflowRequestFromEnv({
      env: {
        GITHUB_ACTOR: "PerishCode",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "nexu-io/open-design",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123",
        GITHUB_WORKFLOW: "release-beta",
        RELEASE_ACTIVATE: "true",
        RELEASE_CHANNEL: "beta",
        RELEASE_COMMIT: "a".repeat(40),
        RELEASE_MAC_ARM64_SIGN_MODE: "notarized",
        RELEASE_MAC_X64_SIGN_MODE: "notarized",
        RELEASE_MIN_SHELL_VERSION: "0.19.4-beta.31",
        RELEASE_PROFILE: "test",
        RELEASE_PUBLIC_ORIGIN: "https://releases.example.com",
        RELEASE_PUBLISH: "true",
        RELEASE_VERSION: "0.19.4-beta.31",
        RELEASE_WIN_X64_SIGN_MODE: "unsigned",
      },
      workflowDigest: `sha256:${"a".repeat(64)}`,
      workspaceRoot,
    });
    expect(prepared.targets.map(({ name }) => name)).toEqual(["mac_arm64", "mac_x64", "win_x64"]);
    expect(prepared.targets.map(({ namespace }) => namespace)).toEqual(["release-beta", "release-beta-x64", "release-beta-win"]);
  });

  it("seals the production graph against the repository identity registry", async () => {
    const sealed = declareDesktopReleaseWorkflow(await readIdentityRegistry(workspaceRoot));
    expect(sealed.manifest.workflow.id).toBe("open-design.desktop");
    expect(sealed.manifest.definitions.filter(({ path }) => path.startsWith("proof.")).length).toBe(12);
    const desktop = sealed.manifest.definitions.find(({ path }) => path === "release.desktop");
    if (desktop?.path !== "release.desktop") throw new Error("desktop release declaration is missing");
    expect(desktop.config.targets).toEqual(["mac_arm64", "mac_x64", "win_x64"]);
    expect(sealed.canonical).not.toContain("linux");
  });

  it("selects only requested target nodes and applies stable publish=false gates", async () => {
    const sealed = declareDesktopReleaseWorkflow(await readIdentityRegistry(workspaceRoot));
    const dependencies = {
      now: () => new Date("2026-08-17T08:00:00.000Z"),
      resolveIdentity: async (input: unknown) => metadataDigest(canonicalMetadataJson(input)),
      resolveReceipt: async () => null,
    };
    const beta = await planReleaseWorkflow(sealed.manifest, request(sealed.digest), dependencies);
    expect(beta.nodes.some(({ nodeId }) => nodeId.includes("mac-arm64") || nodeId.includes("mac-x64"))).toBe(false);
    expect(beta.nodes.filter(({ path }) => path.startsWith("proof.")).length).toBe(5);
    expect(beta.nodes.some(({ path }) => path === "atom.transact.reserve")).toBe(true);
    expect(beta.nodes.some(({ path }) => path === "atom.transact.activate")).toBe(true);

    const stable = await planReleaseWorkflow(sealed.manifest, request(sealed.digest, {
      activate: false,
      channel: "stable",
      publish: false,
      releaseVersion: "0.19.4",
    }), dependencies);
    expect(stable.policy).toMatchObject({ activate: false, counted: false, publish: false });
    expect(stable.nodes.some(({ path }) => path === "atom.transact.reserve")).toBe(false);
    expect(stable.nodes.some(({ path }) => path === "atom.project.object")).toBe(false);
    expect(stable.nodes.some(({ path }) => path === "atom.attest.publication")).toBe(false);
    expect(stable.nodes.some(({ path }) => path === "atom.transact.activate")).toBe(false);
    expect(stable.nodes.some(({ path }) => path === "atom.build.shell")).toBe(true);
    expect(stable.nodes.some(({ path }) => path.startsWith("proof."))).toBe(true);

    const receipts: unknown[] = [];
    const scenarios = beta.nodes
      .filter((node) => node.effect === "proof" && node.inputs.semantic.releaseTarget === "win_x64")
      .map((node) => String(node.inputs.semantic.scenario));
    const registeredInternal = await registerScenarioReceipts({
      evidenceSource: "internal-smoke",
      plan: beta,
      registerReceipt: async (_storage, receipt) => {
        receipts.push(receipt);
        return "created";
      },
      storage: {} as never,
      summary: {
        coldStart: {
          schemaVersion: 1,
          status: "success",
          timing: { launchDurationMs: 100, readinessBudgetMs: 300_000, readinessDurationMs: 200, totalDurationMs: 300 },
        },
        timings: scenarios.map((step) => ({ lane: "shell", status: "success", step })),
      },
      target: "win_x64",
    });
    expect(registeredInternal).toHaveLength(4);
    expect(receipts).toHaveLength(4);
    const registeredPublic = await registerScenarioReceipts({
      evidenceSource: "public-acceptance",
      plan: beta,
      registerReceipt: async (_storage, receipt) => {
        receipts.push(receipt);
        return "created";
      },
      storage: {} as never,
      summary: {
        coldStart: {
          schemaVersion: 1,
          status: "success",
          timing: { launchDurationMs: 100, readinessBudgetMs: 300_000, readinessDurationMs: 200, totalDurationMs: 300 },
        },
        timings: scenarios.map((step) => ({ lane: "shell", status: "success", step })),
      },
      target: "win_x64",
    });
    expect(registeredPublic).toHaveLength(1);
    expect(receipts).toHaveLength(5);
  });
});
