import { describe, expect, it } from "vitest";

import {
  compileReleaseWorkflowExecution,
  selectReleaseWorkflowTargetExecution,
} from "../src/workflow/execution.ts";

const digest = (token: string) => `sha256:${token.repeat(64)}` as const;
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
    { buildTarget: "dmg", name: "mac_arm64", namespace: "release-beta", nodeModulesAbi: "137", nodeNapi: "10", platform: "darwin-arm64", signMode: "notarized", shellProfileDigest: digest("a"), smokeMatrix: "mac-shell-v3", standaloneProtocolVersion: 1 },
    { buildTarget: "all", name: "mac_x64", namespace: "release-beta-x64", nodeModulesAbi: "137", nodeNapi: "10", platform: "darwin-x64", signMode: "notarized", shellProfileDigest: digest("b"), smokeMatrix: "mac-shell-v2", standaloneProtocolVersion: 1 },
    { buildTarget: "all", name: "win_x64", namespace: "release-beta-win", nodeModulesAbi: "137", nodeNapi: "10", platform: "win32-x64", signMode: "unsigned", shellProfileDigest: digest("c"), smokeMatrix: "win-shell-v2", standaloneProtocolVersion: 1 },
  ],
  workflowDigest: digest("1"),
} as const;

type Target = "mac_arm64" | "mac_x64" | "win_x64";
const platforms = { mac_arm64: "darwin-arm64", mac_x64: "darwin-x64", win_x64: "win32-x64" } as const;

function node(
  path: "atom.build.closureShared" | "atom.build.closureTarget" | "atom.build.shell" | "proof.installed.scenario",
  target: Target | null,
  decision: "execute" | "replay",
) {
  const effect = path.startsWith("proof.") ? "proof" as const : "pure" as const;
  const suffix = target ?? "shared";
  const semantic = path === "proof.installed.scenario"
    ? { releaseTarget: target, scenario: target === "win_x64" ? "win-shell-lifecycle" : "mac-shell-lifecycle" }
    : target == null ? {} : { target: platforms[target] };
  const identityDigests = path.startsWith("atom.build.") ? { [`identity-${suffix}`]: digest("7") } : {};
  return {
    decision,
    definitionDigest: digest("2"),
    dependencies: [],
    effect,
    executionDigest: digest("3"),
    executorIds: ["executor"],
    gate: "always" as const,
    identityDigests,
    inputs: { audit: {}, materialization: {}, operational: {}, semantic },
    nodeId: `node-${path}-${suffix}`,
    outputs: [{ role: "output", schemaVersion: 1 }],
    path,
    reason: decision === "execute" ? "receipt-miss" as const : "receipt-hit" as const,
    ...(decision === "replay" ? { receipt: {
      definitionDigest: digest("2"),
      effect,
      executionDigest: digest("3"),
      nodeId: `node-${path}-${suffix}`,
      outputs: [{ digest: digest("4"), role: "output", schemaVersion: 1 }],
      provenance: {},
      recordedAt: "2026-08-17T00:00:00.000Z",
      schemaVersion: 1 as const,
      semanticDigest: digest("5"),
      status: "success" as const,
    } } : {}),
    semanticDigest: digest("5"),
  };
}

describe("release workflow execution", () => {
  it("carries canonical build nodes while only scheduling executable targets", () => {
    const plan = {
      formatVersion: 1 as const,
      generatedAt: "2026-08-17T00:00:00.000Z",
      nodes: [
        node("atom.build.closureShared", null, "replay"),
        ...request.targets.flatMap(({ name }) => [
          node("atom.build.closureTarget", name, "replay"),
          node("atom.build.shell", name, "replay"),
          node("proof.installed.scenario", name, name === "mac_x64" ? "execute" : "replay"),
        ]),
      ],
      policy: { activate: true, counted: true, path: "policy.channel.exact" as const, publish: true },
      requestDigest: digest("6"),
      schemaVersion: 1 as const,
      workflowDigest: request.workflowDigest,
    };
    const execution = compileReleaseWorkflowExecution(plan, request);
    expect(execution).toMatchObject({
      acceptanceMatrix: { include: [
        { artifact_dir: "dmg", os: "mac", runner: "macos-15-intel", target: "mac_x64" },
      ] },
      attestTargets: ["mac_arm64", "win_x64"],
      buildMatrix: { include: [{ runner: "macos-15-intel", target: "mac_x64" }] },
      executeTargets: ["mac_x64"],
      replayTargets: ["mac_arm64", "win_x64"],
      sharedClosure: { nodeId: "node-atom.build.closureShared-shared" },
    });
    expect(selectReleaseWorkflowTargetExecution(execution, "win_x64")).toMatchObject({
      closureTarget: { nodeId: "node-atom.build.closureTarget-win_x64" },
      shell: { nodeId: "node-atom.build.shell-win_x64" },
      target: "win_x64",
    });
  });
});
