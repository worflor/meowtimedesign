import { describe, expect, it } from "vitest";

import { compileReleaseWorkflowExecution } from "../src/workflow/execution.ts";

const request = {
  formatVersion: 1,
  provenance: { actor: "actor", event: "workflow_dispatch", repository: "nexu-io/open-design", runAttempt: 1, runId: "1", workflow: "release-beta" },
  release: {
    activate: true,
    channel: "beta",
    commit: "a".repeat(40),
    minShellVersion: "0.19.4-beta.1",
    namespace: "release-beta",
    nodeVersion: "v24.18.0",
    packageManager: "pnpm@10.33.2",
    profile: "test",
    publicOrigin: "https://releases.example.com",
    publish: true,
    releaseVersion: "0.19.4-beta.31",
  },
  targets: [
    { buildTarget: "dmg", name: "mac_arm64", namespace: "release-beta", nodeModulesAbi: "137", nodeNapi: "10", platform: "darwin-arm64", signMode: "notarized", shellProfileDigest: `sha256:${"a".repeat(64)}`, smokeMatrix: "mac-shell-v3", standaloneProtocolVersion: 1 },
    { buildTarget: "all", name: "mac_x64", namespace: "release-beta-x64", nodeModulesAbi: "137", nodeNapi: "10", platform: "darwin-x64", signMode: "notarized", shellProfileDigest: `sha256:${"b".repeat(64)}`, smokeMatrix: "mac-shell-v2", standaloneProtocolVersion: 1 },
    { buildTarget: "all", name: "win_x64", namespace: "release-beta-win", nodeModulesAbi: "137", nodeNapi: "10", platform: "win32-x64", signMode: "unsigned", shellProfileDigest: `sha256:${"c".repeat(64)}`, smokeMatrix: "win-shell-v2", standaloneProtocolVersion: 1 },
  ],
  workflowDigest: `sha256:${"1".repeat(64)}`,
} as const;

function node(target: string, decision: "execute" | "replay") {
  const releaseTarget = target === "darwin-arm64" ? "mac_arm64" : target === "darwin-x64" ? "mac_x64" : "win_x64";
  return {
    decision,
    definitionDigest: `sha256:${"2".repeat(64)}`,
    dependencies: [],
    effect: "proof",
    executionDigest: `sha256:${"3".repeat(64)}`,
    executorIds: ["executor"],
    gate: "always",
    identityDigests: {},
    inputs: { audit: {}, materialization: {}, operational: {}, semantic: {
      releaseTarget,
      scenario: releaseTarget === "win_x64" ? "win-shell-lifecycle" : "mac-shell-lifecycle",
      target,
    } },
    nodeId: `node-${target}`,
    outputs: [{ role: "output", schemaVersion: 1 }],
    path: "proof.installed.scenario",
    reason: decision === "execute" ? "receipt-miss" : "receipt-hit",
    ...(decision === "replay" ? { receipt: {
      definitionDigest: `sha256:${"2".repeat(64)}`,
      effect: "proof",
      executionDigest: `sha256:${"3".repeat(64)}`,
      nodeId: `node-${target}`,
      outputs: [{ digest: `sha256:${"4".repeat(64)}`, role: "output", schemaVersion: 1 }],
      provenance: {},
      recordedAt: "2026-08-17T00:00:00.000Z",
      schemaVersion: 1,
      semanticDigest: `sha256:${"5".repeat(64)}`,
      status: "success",
    } } : {}),
    semanticDigest: `sha256:${"5".repeat(64)}`,
  };
}

describe("release workflow execution", () => {
  it("only schedules targets with an executable platform node", () => {
    const plan = {
      formatVersion: 1,
      generatedAt: "2026-08-17T00:00:00.000Z",
      nodes: [node("darwin-arm64", "replay"), node("darwin-x64", "execute"), node("win32-x64", "replay")],
      policy: { activate: true, counted: true, path: "policy.channel.exact", publish: true },
      requestDigest: `sha256:${"6".repeat(64)}`,
      schemaVersion: 1,
      workflowDigest: request.workflowDigest,
    };
    expect(compileReleaseWorkflowExecution(plan, request)).toEqual({
      acceptanceMatrix: { include: [
        { artifact_dir: "dmg", os: "mac", runner: "macos-15-intel", target: "mac_x64" },
      ] },
      attestTargets: ["mac_arm64", "win_x64"],
      buildMatrix: { include: [{ runner: "macos-15-intel", target: "mac_x64" }] },
      executeTargets: ["mac_x64"],
      replayTargets: ["mac_arm64", "win_x64"],
    });
  });
});
