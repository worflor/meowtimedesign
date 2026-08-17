import { resolve } from "node:path";

import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";
import { describe, expect, it } from "vitest";

import { readIdentityRegistry } from "../src/identity/declaration/registry.ts";
import {
  declareDesktopReleaseWorkflow,
  planReleaseWorkflow,
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
  });
});
