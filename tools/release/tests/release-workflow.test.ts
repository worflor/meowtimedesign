import { describe, expect, it } from "vitest";

import type { IdentityRegistry } from "../src/identity/declaration/schema.ts";
import {
  createReleaseWorkflow,
  releaseWorkflowManifestSchema,
  type ReleaseWorkflowAtomDeclaration,
  type ReleaseWorkflowExecutorReference,
  type ReleaseWorkflowPolicyReference,
} from "../src/workflow/index.ts";

const identities = {
  identities: {
    "shell.build.alt": { parameters: ["profile", "target"], schemaVersion: 1, sourceSets: ["fixture"] },
    "shell.build.mac": { parameters: ["profile", "target"], schemaVersion: 1, sourceSets: ["fixture"] },
    "shell.spec.mac": { parameters: ["matrix", "standaloneProtocolVersion"], schemaVersion: 1, sourceSets: ["fixture"] },
  },
  schemaVersion: 1,
  sourceSets: { fixture: { paths: ["package.json"] } },
} as const satisfies IdentityRegistry;

const shellAtom = {
  confidence: "certain",
  id: "shell",
  identity: { ids: ["shell.build.mac"], parameters: ["profile", "target"] },
  inputs: {
    audit: ["actor"],
    materialization: ["releaseVersion"],
    operational: ["timeoutSeconds"],
    semantic: ["profile", "target"],
  },
  outputs: [{ mediaType: "application/octet-stream", role: "installer", schemaVersion: 1 }],
  schemaVersion: 1,
  witness: "release-workflow.shell",
} as const;

function declareFixture(input: Readonly<{
  atom?: Partial<ReleaseWorkflowAtomDeclaration>;
  reverse?: boolean;
  workflowSchemaVersion?: number;
}> = {}) {
  const workflow = createReleaseWorkflow({
    id: "open-design.desktop",
    identities,
    schemaVersion: input.workflowSchemaVersion ?? 1,
  });
  const executorDeclarations = [
    ["control", { capabilities: ["control"], id: "control", runnerClass: "ubuntu", schemaVersion: 1 }],
    ["mac", { capabilities: ["sign", "build"], id: "mac", runnerClass: "macos", schemaVersion: 1 }],
    ["windows", { capabilities: ["build"], id: "windows", runnerClass: "windows", schemaVersion: 1 }],
  ] as const;
  const orderedExecutors = input.reverse ? [...executorDeclarations].reverse() : executorDeclarations;
  const executorRefs = new Map<string, ReleaseWorkflowExecutorReference>();
  for (const [kind, declaration] of orderedExecutors) {
    const ref = kind === "control"
      ? workflow.executor.control(declaration)
      : kind === "mac"
        ? workflow.executor.mac(declaration)
        : workflow.executor.windows(declaration);
    executorRefs.set(kind, ref);
  }
  const policyDeclarations = [
    ["exact", { counted: true, defaultActivate: true, defaultPublish: true, id: "exact", proofScope: "channel-namespace", schemaVersion: 1 }],
    ["prerelease", { counted: true, defaultActivate: true, defaultPublish: true, id: "prerelease", proofScope: "channel-namespace", schemaVersion: 1 }],
    ["stable", { counted: false, defaultActivate: false, defaultPublish: false, id: "stable", proofScope: "channel-namespace", schemaVersion: 1 }],
  ] as const;
  const orderedPolicies = input.reverse ? [...policyDeclarations].reverse() : policyDeclarations;
  const policyRefs = new Map<string, ReleaseWorkflowPolicyReference>();
  for (const [kind, declaration] of orderedPolicies) {
    const ref = kind === "exact"
      ? workflow.policy.channel.exact(declaration)
      : kind === "prerelease"
        ? workflow.policy.channel.prerelease(declaration)
        : workflow.policy.channel.stable(declaration);
    policyRefs.set(kind, ref);
  }
  const shell = workflow.atom.build.shell({
    ...shellAtom,
    ...input.atom,
    executor: [executorRefs.get("windows")!, executorRefs.get("mac")!],
  } as ReleaseWorkflowAtomDeclaration);
  const installed = workflow.proof.installed.scenario({
    boundaries: { auth: "synthetic", release: "public-immutable" },
    confidence: "certain",
    dependsOn: [shell],
    doesNotProve: ["real account authentication"],
    executor: executorRefs.get("mac")!,
    id: "installed-shell",
    identity: { ids: ["shell.spec.mac"], parameters: ["matrix", "standaloneProtocolVersion"] },
    inputs: { semantic: ["matrix", "standaloneProtocolVersion"] },
    outputs: [{ mediaType: "application/json", role: "proof", schemaVersion: 1 }],
    portability: { channel: "scoped", namespace: "scoped", releaseVersion: "semantic" },
    proves: ["installed Shell starts"],
    schemaVersion: 1,
    witness: "release-workflow.installed-shell",
  });
  workflow.release.desktop({
    atoms: [shell],
    executors: [executorRefs.get("windows")!, executorRefs.get("mac")!, executorRefs.get("control")!],
    id: "desktop",
    policies: [policyRefs.get("stable")!, policyRefs.get("exact")!, policyRefs.get("prerelease")!],
    proofs: [installed],
    schemaVersion: 1,
    targets: ["win_x64", "mac_x64", "mac_arm64"],
  });
  return { sealed: workflow.seal(), workflow };
}

describe("ReleaseWorkflow", () => {
  it("exposes only the closed factory method paths and seals a valid manifest", () => {
    const { sealed, workflow } = declareFixture();
    expect(Object.keys(workflow)).toEqual(["atom", "executor", "policy", "proof", "release", "seal"]);
    expect(Object.keys(workflow.atom.build)).toEqual(["closureShared", "closureTarget", "shell"]);
    expect(releaseWorkflowManifestSchema.parse(sealed.manifest)).toEqual(sealed.manifest);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const shell = sealed.manifest.definitions.find(({ path }) => path === "atom.build.shell");
    if (shell?.path !== "atom.build.shell") throw new Error("fixture shell declaration is missing");
    expect(shell.config.effect).toBe("pure");
  });

  it("canonicalizes declaration and set-like field order", () => {
    const first = declareFixture().sealed;
    const reordered = declareFixture({ reverse: true }).sealed;
    expect(reordered.canonical).toBe(first.canonical);
    expect(reordered.digest).toBe(first.digest);
  });

  it("binds every atom contract determinant while ignoring registration order", () => {
    const baseline = declareFixture().sealed.digest;
    const changes: Array<Readonly<{ atom?: Partial<ReleaseWorkflowAtomDeclaration>; workflowSchemaVersion?: number }>> = [
      { workflowSchemaVersion: 2 },
      { atom: { id: "shell-next" } },
      { atom: { schemaVersion: 2 } },
      { atom: { confidence: "low" } },
      { atom: { identity: { ids: ["shell.build.alt"], parameters: ["profile", "target"] } } },
      { atom: { inputs: { ...shellAtom.inputs, semantic: ["profile", "target", "variant"] } } },
      { atom: { inputs: { ...shellAtom.inputs, materialization: ["releaseVersion", "namespace"] } } },
      { atom: { inputs: { ...shellAtom.inputs, operational: ["timeoutSeconds", "retryLimit"] } } },
      { atom: { inputs: { ...shellAtom.inputs, audit: ["actor", "runId"] } } },
      { atom: { outputs: [{ mediaType: "application/zip", role: "installer", schemaVersion: 1 }] } },
      { atom: { outputs: [{ mediaType: "application/octet-stream", role: "installer", schemaVersion: 2 }] } },
      { atom: { witness: "release-workflow.shell-v2" } },
    ];
    for (const change of changes) expect(declareFixture(change).sealed.digest).not.toBe(baseline);
  });

  it("rejects schema drift, invalid identity bindings, and foreign refs", () => {
    const workflow = createReleaseWorkflow({ id: "fixture.one", identities, schemaVersion: 1 });
    expect(() => workflow.executor.control({
      capabilities: ["control"],
      extra: true,
      id: "control",
      runnerClass: "ubuntu",
      schemaVersion: 1,
    } as never)).toThrow(/unrecognized[_ ]key/iu);

    const control = workflow.executor.control({ capabilities: ["control"], id: "control", runnerClass: "ubuntu", schemaVersion: 1 });
    expect(() => workflow.atom.build.shell({
      ...shellAtom,
      executor: control,
      identity: { ids: ["missing.identity"], parameters: ["profile", "target"] },
    })).toThrow(/unknown metatool identity/u);
    expect(() => workflow.atom.build.shell({
      ...shellAtom,
      executor: control,
      identity: { ids: ["shell.build.mac"], parameters: ["target"] },
    })).toThrow(/parameters must be exactly/u);

    const other = createReleaseWorkflow({ id: "fixture.two", identities, schemaVersion: 1 });
    const foreign = other.executor.mac({ capabilities: ["build"], id: "foreign", runnerClass: "macos", schemaVersion: 1 });
    expect(() => workflow.atom.build.shell({ ...shellAtom, executor: foreign })).toThrow(/another release workflow/u);
  });

  it("rejects hidden executable semantics and unsafe channel policy", () => {
    const workflow = createReleaseWorkflow({ id: "fixture", identities, schemaVersion: 1 });
    const control = workflow.executor.control({ capabilities: ["control"], id: "control", runnerClass: "ubuntu", schemaVersion: 1 });
    expect(() => workflow.proof.installed.scenario({
      boundaries: { hidden: (() => true) as unknown as string },
      confidence: "certain",
      dependsOn: [],
      doesNotProve: [],
      executor: control,
      id: "bad-proof",
      identity: { ids: ["shell.spec.mac"], parameters: ["matrix", "standaloneProtocolVersion"] },
      inputs: { semantic: ["matrix", "standaloneProtocolVersion"] },
      outputs: [{ role: "proof", schemaVersion: 1 }],
      portability: { channel: "scoped", namespace: "scoped", releaseVersion: "semantic" },
      proves: ["nothing hidden"],
      schemaVersion: 1,
      witness: "bad",
    })).toThrow();
    expect(() => workflow.policy.channel.stable({
      counted: false,
      defaultActivate: true,
      defaultPublish: false,
      id: "stable",
      proofScope: "channel-namespace",
      schemaVersion: 1,
    })).toThrow(/activation requires publication/u);
    expect(() => workflow.policy.channel.stable({
      counted: true,
      defaultActivate: false,
      defaultPublish: false,
      id: "stable-counted",
      proofScope: "channel-namespace",
      schemaVersion: 1,
    })).toThrow(/must not be counted/u);
  });

  it("allows dependency-derived transactional atoms without inventing a source identity", () => {
    const workflow = createReleaseWorkflow({ id: "fixture", identities, schemaVersion: 1 });
    const control = workflow.executor.control({ capabilities: ["control"], id: "control", runnerClass: "ubuntu", schemaVersion: 1 });
    const reserve = workflow.atom.transact.reserve({
      confidence: "certain",
      executor: control,
      id: "reserve",
      inputs: { operational: ["actor"], semantic: ["channel", "namespace"] },
      outputs: [{ role: "reservation", schemaVersion: 1 }],
      schemaVersion: 1,
      witness: "release-workflow.reserve",
    });
    const exact = workflow.policy.channel.exact({
      counted: true,
      defaultActivate: true,
      defaultPublish: true,
      id: "exact",
      proofScope: "channel-namespace",
      schemaVersion: 1,
    });
    const prerelease = workflow.policy.channel.prerelease({
      counted: true,
      defaultActivate: true,
      defaultPublish: true,
      id: "prerelease",
      proofScope: "channel-namespace",
      schemaVersion: 1,
    });
    const stable = workflow.policy.channel.stable({
      counted: false,
      defaultActivate: false,
      defaultPublish: false,
      id: "stable",
      proofScope: "channel-namespace",
      schemaVersion: 1,
    });
    workflow.release.desktop({
      atoms: [reserve],
      executors: [control],
      id: "desktop",
      policies: [exact, prerelease, stable],
      proofs: [],
      schemaVersion: 1,
      targets: ["mac_arm64"],
    });
    const sealed = workflow.seal();
    const definition = sealed.manifest.definitions.find(({ path }) => path === "atom.transact.reserve");
    expect(definition?.config).not.toHaveProperty("identity");
    expect(releaseWorkflowManifestSchema.parse(sealed.manifest)).toEqual(sealed.manifest);
  });

  it("rejects tampered reference indexes and definitions outside the release graph", () => {
    type MutableManifest = { definitions: Array<{ config: Record<string, unknown>; id: string; path: string }> };
    const manifest = structuredClone(declareFixture().sealed.manifest) as unknown as MutableManifest;
    const shell = manifest.definitions.find(({ path }) => path === "atom.build.shell")!;
    shell.config.references = [];
    expect(() => releaseWorkflowManifestSchema.parse(manifest)).toThrow(/references must exactly index/u);

    const orphaned = structuredClone(declareFixture().sealed.manifest) as unknown as MutableManifest;
    const control = orphaned.definitions.find(({ path }) => path === "executor.control")!;
    const desktop = orphaned.definitions.find(({ path }) => path === "release.desktop")!;
    desktop.config.executors = (desktop.config.executors as Array<{ $ref: string }>).filter(({ $ref }) => $ref !== control.id);
    desktop.config.references = (desktop.config.references as string[]).filter((reference) => reference !== control.id);
    expect(() => releaseWorkflowManifestSchema.parse(orphaned)).toThrow(/outside the release graph/u);
  });
});
