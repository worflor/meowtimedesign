import type { IdentityRegistry } from "../identity/declaration/schema.ts";
import { createReleaseWorkflow } from "./factory.ts";
import type {
  ReleaseWorkflowAtomReference,
  ReleaseWorkflowExecutorReference,
  ReleaseWorkflowProofReference,
  SealedReleaseWorkflow,
} from "./schema.ts";

type TargetName = "mac_arm64" | "mac_x64" | "win_x64";
type TargetDefinition = Readonly<{
  executor: "mac" | "windows";
  identity: string;
  platform: "darwin-arm64" | "darwin-x64" | "win32-x64";
  scenarios: readonly ScenarioDefinition[];
  target: TargetName;
}>;
type ScenarioDefinition = Readonly<{
  boundaries: Readonly<Record<string, string>>;
  doesNotProve: readonly string[];
  id: string;
  identity: string;
  kind: "installed" | "updater";
  proves: readonly string[];
}>;

const request = (path: "release.channel" | "release.commit" | "release.minShellVersion" | "release.namespace" | "release.nodeVersion" | "release.packageManager" | "release.profile" | "release.publicOrigin" | "release.releaseVersion") => ({ path, source: "request" } as const);
const target = (name: TargetName, path: "target.buildTarget" | "target.namespace" | "target.nodeModulesAbi" | "target.nodeNapi" | "target.platform" | "target.signMode" | "target.smokeMatrix" | "target.standaloneProtocolVersion") => ({ path, source: "target", target: name } as const);
const literal = (value: string | number | boolean) => ({ source: "literal", value } as const);

const sharedBoundaries = {
  agent: "not-exercised",
  auth: "synthetic-state",
  landing: "synthetic-state",
  release: "temporary-fixture",
} as const;

const TARGETS: readonly TargetDefinition[] = [
  {
    executor: "mac",
    identity: "shell.build.darwin-arm64",
    platform: "darwin-arm64",
    scenarios: [
      {
        boundaries: { ...sharedBoundaries, auth: "not-exercised", landing: "synthetic-state" },
        doesNotProve: ["real account authentication", "real coding-agent connectivity", "public feed availability"],
        id: "mac-shell-lifecycle",
        identity: "shell.spec.mac_arm64.lifecycle",
        kind: "installed",
        proves: ["installed product reaches its terminal surface", "Shell and Standalone update transaction", "clean stop and installed-outer restart"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "mac-shell-silent-update",
        identity: "shell.spec.mac_arm64.silent-update",
        kind: "updater",
        proves: ["silent policy authorizes one cold-start activation"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "mac-shell-rollback",
        identity: "shell.spec.mac_arm64.rollback",
        kind: "updater",
        proves: ["failed successor preserves lastSuccessful", "later healthy successor converges"],
      },
      {
        boundaries: { ...sharedBoundaries, release: "public-immutable" },
        doesNotProve: ["real account authentication", "real coding-agent connectivity"],
        id: "mac-legacy-migration",
        identity: "shell.spec.mac_arm64.legacy-migration",
        kind: "installed",
        proves: ["legacy minVersion routes through installer", "product data survives architecture migration"],
      },
    ],
    target: "mac_arm64",
  },
  {
    executor: "mac",
    identity: "shell.build.darwin-x64",
    platform: "darwin-x64",
    scenarios: [
      {
        boundaries: { ...sharedBoundaries, auth: "not-exercised" },
        doesNotProve: ["real account authentication", "real coding-agent connectivity", "public feed availability"],
        id: "mac-shell-lifecycle",
        identity: "shell.spec.mac_x64.lifecycle",
        kind: "installed",
        proves: ["installed product reaches its terminal surface", "Shell and Standalone update transaction", "clean stop and installed-outer restart"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "mac-shell-silent-update",
        identity: "shell.spec.mac_x64.silent-update",
        kind: "updater",
        proves: ["silent policy authorizes one cold-start activation"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "mac-shell-rollback",
        identity: "shell.spec.mac_x64.rollback",
        kind: "updater",
        proves: ["failed successor preserves lastSuccessful", "later healthy successor converges"],
      },
    ],
    target: "mac_x64",
  },
  {
    executor: "windows",
    identity: "shell.build.win32-x64",
    platform: "win32-x64",
    scenarios: [
      {
        boundaries: { ...sharedBoundaries, auth: "not-exercised" },
        doesNotProve: ["real account authentication", "real coding-agent connectivity", "public feed availability"],
        id: "win-shell-lifecycle",
        identity: "shell.spec.win_x64.lifecycle",
        kind: "installed",
        proves: ["installed product reaches its terminal surface", "Shell and Standalone update transaction", "clean stop and installed-outer restart"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "win-shell-silent-update",
        identity: "shell.spec.win_x64.silent-update",
        kind: "updater",
        proves: ["silent policy authorizes one cold-start activation"],
      },
      {
        boundaries: sharedBoundaries,
        doesNotProve: ["real account authentication", "public feed availability"],
        id: "win-shell-rollback",
        identity: "shell.spec.win_x64.rollback",
        kind: "updater",
        proves: ["failed successor preserves lastSuccessful", "later healthy successor converges"],
      },
      {
        boundaries: { agent: "not-exercised", auth: "not-exercised", landing: "not-exercised", release: "temporary-fixture" },
        doesNotProve: ["renderer readiness", "real account authentication"],
        id: "win-native-install-boundaries",
        identity: "shell.spec.win_x64.native-install",
        kind: "installed",
        proves: ["native install transaction and repair", "registry and uninstall ownership", "embedded extraction tool"],
      },
      {
        boundaries: { ...sharedBoundaries, release: "public-immutable" },
        doesNotProve: ["real account authentication", "real coding-agent connectivity"],
        id: "win-legacy-migration",
        identity: "shell.spec.win_x64.legacy-migration",
        kind: "installed",
        proves: ["legacy minVersion routes through installer", "product data survives architecture migration"],
      },
    ],
    target: "win_x64",
  },
] as const;

export function declareDesktopReleaseWorkflow(identities: IdentityRegistry): SealedReleaseWorkflow {
  const workflow = createReleaseWorkflow({ id: "open-design.desktop", identities, schemaVersion: 1 });
  const control = workflow.executor.control({
    capabilities: ["attest", "compose", "notify", "project", "reserve", "activate"],
    id: "control",
    runnerClass: "ubuntu-latest",
    schemaVersion: 1,
    secretReferences: ["releaseStorage"],
  });
  const mac = workflow.executor.mac({
    capabilities: ["build", "install", "notarize", "smoke"],
    id: "mac",
    runnerClass: "macos",
    schemaVersion: 1,
    secretReferences: ["appleNotary", "releaseStorage"],
  });
  const windows = workflow.executor.windows({
    capabilities: ["build", "install", "smoke"],
    id: "windows",
    runnerClass: "windows-latest",
    schemaVersion: 1,
    secretReferences: ["releaseStorage"],
  });
  const executors = { control, mac, windows } as const;

  const exact = workflow.policy.channel.exact({ counted: true, defaultActivate: true, defaultPublish: true, id: "exact", proofScope: "channel-namespace", schemaVersion: 1 });
  const prerelease = workflow.policy.channel.prerelease({ counted: true, defaultActivate: true, defaultPublish: true, id: "prerelease", proofScope: "channel-namespace", schemaVersion: 1 });
  const stable = workflow.policy.channel.stable({ counted: false, defaultActivate: false, defaultPublish: false, id: "stable", proofScope: "channel-namespace", schemaVersion: 1 });

  const reserve = workflow.atom.transact.reserve({
    bindings: {
      channel: request("release.channel"),
      commit: request("release.commit"),
      namespace: request("release.namespace"),
      releaseVersion: request("release.releaseVersion"),
    },
    confidence: "certain",
    executor: control,
    id: "reserve-version",
    inputs: { audit: ["commit"], semantic: ["channel", "namespace", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "reservation", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "counted-version-reservation/v1",
  });
  const closureShared = workflow.atom.build.closureShared({
    bindings: {
      minShellVersion: request("release.minShellVersion"),
      nodeVersion: request("release.nodeVersion"),
      packageManager: request("release.packageManager"),
    },
    confidence: "certain",
    executor: control,
    id: "closure-shared",
    identity: { ids: ["closure.shared.build"], parameters: ["minShellVersion", "nodeVersion", "packageManager"] },
    inputs: { semantic: ["minShellVersion", "nodeVersion", "packageManager"] },
    outputs: [{ mediaType: "application/json", role: "closureSharedContribution", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "closure-build-record/shared-v1",
  });

  const atoms: ReleaseWorkflowAtomReference[] = [reserve, closureShared];
  const proofs: ReleaseWorkflowProofReference[] = [];
  const closureTargets = new Map<TargetName, ReleaseWorkflowAtomReference>();
  const shells = new Map<TargetName, ReleaseWorkflowAtomReference>();
  for (const definition of TARGETS) {
    const executor = executors[definition.executor] as ReleaseWorkflowExecutorReference;
    const closureTarget = workflow.atom.build.closureTarget({
      bindings: {
        nodeModulesAbi: target(definition.target, "target.nodeModulesAbi"),
        nodeNapi: target(definition.target, "target.nodeNapi"),
        nodeVersion: request("release.nodeVersion"),
        packageManager: request("release.packageManager"),
        target: target(definition.target, "target.platform"),
      },
      confidence: "certain",
      dependsOn: [closureShared],
      executor,
      id: `closure-${definition.target.replace("_", "-")}`,
      identity: { ids: [`closure.target.${definition.platform}`], parameters: ["nodeModulesAbi", "nodeNapi", "nodeVersion", "packageManager", "target"] },
      inputs: { semantic: ["nodeModulesAbi", "nodeNapi", "nodeVersion", "packageManager", "target"] },
      outputs: [{ mediaType: "application/json", role: "closureTargetContribution", schemaVersion: 1 }],
      schemaVersion: 1,
      witness: "closure-build-record/target-v1",
    });
    const shell = workflow.atom.build.shell({
      bindings: {
        buildTarget: target(definition.target, "target.buildTarget"),
        channel: request("release.channel"),
        profile: request("release.profile"),
        shellType: literal("electron"),
        signMode: target(definition.target, "target.signMode"),
        target: target(definition.target, "target.platform"),
      },
      confidence: "certain",
      executor,
      id: `shell-${definition.target.replace("_", "-")}`,
      identity: { ids: [definition.identity], parameters: ["profile", "target"] },
      inputs: { semantic: ["buildTarget", "channel", "profile", "shellType", "signMode", "target"] },
      outputs: [{ mediaType: "application/json", role: "shellBuild", schemaVersion: 5 }],
      schemaVersion: 1,
      witness: "shell-build-record/v5",
    });
    closureTargets.set(definition.target, closureTarget);
    shells.set(definition.target, shell);
    atoms.push(closureTarget, shell);

    for (const scenario of definition.scenarios) {
      const declaration = {
        bindings: {
          channel: request("release.channel"),
          matrix: target(definition.target, "target.smokeMatrix"),
          namespace: target(definition.target, "target.namespace"),
          releaseTarget: literal(definition.target),
          scenario: literal(scenario.id),
          standaloneProtocolVersion: target(definition.target, "target.standaloneProtocolVersion"),
        },
        boundaries: scenario.boundaries,
        confidence: "certain" as const,
        dependsOn: [closureTarget, shell],
        doesNotProve: scenario.doesNotProve,
        executor,
        id: `${definition.target.replace("_", "-")}-${scenario.id}`,
        identity: { ids: [scenario.identity], parameters: ["matrix", "standaloneProtocolVersion"] },
        inputs: { semantic: ["channel", "matrix", "namespace", "releaseTarget", "scenario", "standaloneProtocolVersion"] },
        outputs: [{ mediaType: "application/json", role: "proof", schemaVersion: 1 }],
        portability: { channel: "scoped" as const, namespace: "scoped" as const, releaseVersion: "semantic" as const },
        proves: scenario.proves,
        schemaVersion: 1,
        witness: `installed-scenario/${scenario.id}/v1`,
      };
      proofs.push(scenario.kind === "updater"
        ? workflow.proof.transition.updater(declaration)
        : workflow.proof.installed.scenario(declaration));
    }
  }

  const compose = workflow.atom.compose.manifest({
    bindings: {
      channel: request("release.channel"),
      releaseVersion: request("release.releaseVersion"),
    },
    confidence: "certain",
    dependsOn: [reserve, closureShared, ...closureTargets.values(), ...shells.values(), ...proofs],
    executor: control,
    id: "compose-candidate",
    inputs: { semantic: ["channel", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "candidateManifest", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "release-candidate/v1",
  });
  const project = workflow.atom.project.object({
    bindings: {
      channel: request("release.channel"),
      publicOrigin: request("release.publicOrigin"),
      releaseVersion: request("release.releaseVersion"),
    },
    confidence: "certain",
    dependsOn: [compose],
    executor: control,
    id: "project-public-objects",
    inputs: { semantic: ["channel", "publicOrigin", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "publication", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "release-publication/v1",
  });
  const attest = workflow.atom.attest.publication({
    bindings: { channel: request("release.channel"), releaseVersion: request("release.releaseVersion") },
    confidence: "certain",
    dependsOn: [project],
    executor: control,
    id: "attest-publication",
    inputs: { semantic: ["channel", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "attestation", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "public-acceptance/v1",
  });
  const activate = workflow.atom.transact.activate({
    bindings: {
      channel: request("release.channel"),
      namespace: request("release.namespace"),
      releaseVersion: request("release.releaseVersion"),
    },
    confidence: "certain",
    dependsOn: [attest],
    executor: control,
    id: "activate-latest",
    inputs: { semantic: ["channel", "namespace", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "activation", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "latest-cas/v1",
  });
  const notify = workflow.atom.notify.release({
    bindings: {
      channel: request("release.channel"),
      releaseVersion: request("release.releaseVersion"),
    },
    confidence: "certain",
    dependsOn: [compose, activate],
    executor: control,
    id: "notify-release",
    inputs: { semantic: ["channel", "releaseVersion"] },
    outputs: [{ mediaType: "application/json", role: "notification", schemaVersion: 1 }],
    schemaVersion: 1,
    witness: "release-notification/v1",
  });
  atoms.push(compose, project, attest, activate, notify);

  workflow.release.desktop({
    atoms,
    executors: [control, mac, windows],
    id: "desktop",
    policies: [exact, prerelease, stable],
    proofs,
    schemaVersion: 1,
    targets: ["mac_arm64", "mac_x64", "win_x64"],
  });
  return workflow.seal();
}
