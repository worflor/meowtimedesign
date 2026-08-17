import {
  canonicalMetadataJson,
  metadataDigest,
} from "@open-design/metatool";

import type {
  ReleaseWorkflow,
  ReleaseWorkflowAtomDeclaration,
  ReleaseWorkflowChannelPolicyDeclaration,
  ReleaseWorkflowDefinitionPath,
  ReleaseWorkflowDesktopDeclaration,
  ReleaseWorkflowExecutorDeclaration,
  ReleaseWorkflowFactoryOptions,
  ReleaseWorkflowIdentityBinding,
  ReleaseWorkflowInputClasses,
  ReleaseWorkflowManifest,
  ReleaseWorkflowManifestDefinition,
  ReleaseWorkflowOutputDeclaration,
  ReleaseWorkflowProofDeclaration,
  ReleaseWorkflowReference,
  SealedReleaseWorkflow,
} from "./schema.ts";
import {
  releaseWorkflowAtomDeclarationSchema,
  releaseWorkflowDesktopDeclarationSchema,
  releaseWorkflowExecutorDeclarationSchema,
  releaseWorkflowExactChannelPolicyDeclarationSchema,
  releaseWorkflowFactoryOptionsSchema,
  releaseWorkflowManifestSchema,
  releaseWorkflowPrereleaseChannelPolicyDeclarationSchema,
  releaseWorkflowProofDeclarationSchema,
  releaseWorkflowStableChannelPolicyDeclarationSchema,
} from "./schema.ts";

const referenceMarker = Symbol("release-workflow-reference");

type RuntimeReference = ReleaseWorkflowReference & Readonly<{
  [referenceMarker]: symbol;
}>;

type JsonObject = Record<string, unknown>;

const atomEffects = {
  "atom.attest.publication": "immutable-write",
  "atom.build.closureShared": "pure",
  "atom.build.closureTarget": "pure",
  "atom.build.shell": "pure",
  "atom.compose.manifest": "pure",
  "atom.notify.release": "notification",
  "atom.project.object": "conditional-copy",
  "atom.transact.activate": "cas-transition",
  "atom.transact.reserve": "cas-transition",
} as const;

function validateIdentity(
  binding: ReleaseWorkflowAtomDeclaration["identity"] | ReleaseWorkflowProofDeclaration["identity"],
  inputs: ReleaseWorkflowInputClasses,
  identities: ReleaseWorkflowFactoryOptions["identities"],
  label: string,
): void {
  const expectedParameters = [...binding.parameters].sort();
  for (const id of binding.ids) {
    const declaration = identities.identities[id];
    if (declaration == null) throw new Error(`${label} references unknown metatool identity: ${id}`);
    const actualParameters = [...declaration.parameters].sort();
    if (JSON.stringify(actualParameters) !== JSON.stringify(expectedParameters)) {
      throw new Error(`${label} identity ${id} parameters must be exactly: ${actualParameters.join(", ")}`);
    }
  }
  const semantic = new Set(inputs.semantic);
  const missing = binding.parameters.filter((parameter) => !semantic.has(parameter));
  if (missing.length > 0) throw new Error(`${label} identity parameters must be semantic inputs: ${missing.join(", ")}`);
}

function normalizedInputs(inputs: ReleaseWorkflowInputClasses): ReleaseWorkflowInputClasses {
  return {
    audit: [...(inputs.audit ?? [])].sort(),
    materialization: [...(inputs.materialization ?? [])].sort(),
    operational: [...(inputs.operational ?? [])].sort(),
    semantic: [...inputs.semantic].sort(),
  };
}

function normalizedIdentity(identity: ReleaseWorkflowIdentityBinding): ReleaseWorkflowIdentityBinding {
  return { ids: [...identity.ids].sort(), parameters: [...identity.parameters].sort() };
}

function normalizedOutputs(outputs: readonly ReleaseWorkflowOutputDeclaration[]): readonly ReleaseWorkflowOutputDeclaration[] {
  return [...outputs].sort((left, right) => left.role.localeCompare(right.role));
}

function normalizedReferences<Reference extends ReleaseWorkflowReference>(values: readonly Reference[]): readonly Reference[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function deepFreeze<Value>(value: Value): Value {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createReleaseWorkflow(options: ReleaseWorkflowFactoryOptions): ReleaseWorkflow {
  releaseWorkflowFactoryOptionsSchema.parse(options);
  const definitions = new Map<string, ReleaseWorkflowManifestDefinition>();
  const localIds = new Set<string>();
  const token = Symbol(options.id);
  let sealed = false;

  function assertOpen(): void {
    if (sealed) throw new Error(`release workflow ${options.id} is already sealed`);
  }

  function encode(value: unknown, references: Set<string>, label: string): unknown {
    if (value == null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
      return value;
    }
    if (typeof value !== "object") throw new Error(`${label} must contain only canonical JSON values and workflow refs`);
    const possibleReference = value as Partial<RuntimeReference>;
    if (referenceMarker in possibleReference) {
      if (possibleReference[referenceMarker] !== token) throw new Error(`${label} contains a ref from another release workflow`);
      if (typeof possibleReference.id !== "string" || !definitions.has(possibleReference.id)) {
        throw new Error(`${label} contains an unregistered workflow ref`);
      }
      references.add(possibleReference.id);
      return { $ref: possibleReference.id };
    }
    if (Array.isArray(value)) return value.map((entry, index) => encode(entry, references, `${label}[${index}]`));
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains a non-plain object`);
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "$ref")) throw new Error(`${label} cannot declare a handwritten $ref`);
    if (typeof record.id === "string" && typeof record.path === "string") {
      throw new Error(`${label} cannot declare a handwritten workflow ref`);
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, encode(entry, references, `${label}.${key}`)]));
  }

  function register<Path extends ReleaseWorkflowDefinitionPath>(
    path: Path,
    input: { id: string; schemaVersion: number } & Record<string, unknown>,
    injected: Readonly<Record<string, unknown>> = {},
  ): ReleaseWorkflowReference<Path> {
    assertOpen();
    if (localIds.has(input.id)) throw new Error(`duplicate release workflow definition id: ${input.id}`);
    const canonicalId = `${options.id}/${path}/${input.id}`;
    const references = new Set<string>();
    const { id: _id, schemaVersion: _schemaVersion, ...config } = input;
    const encoded = encode({ ...config, ...injected }, references, `${path}.${input.id}`) as JsonObject;
    const definition = deepFreeze({
      config: {
        ...encoded,
        references: [...references].sort(),
      },
      id: canonicalId,
      path,
      schemaVersion: input.schemaVersion,
    } satisfies ReleaseWorkflowManifestDefinition);
    definitions.set(canonicalId, definition);
    localIds.add(input.id);
    const reference = { id: canonicalId, path } as RuntimeReference;
    Object.defineProperty(reference, referenceMarker, { enumerable: false, value: token });
    return Object.freeze(reference) as unknown as ReleaseWorkflowReference<Path>;
  }

  function atom<Path extends keyof typeof atomEffects>(path: Path, input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<Path> {
    const label = `${path}.${input.id}`;
    releaseWorkflowAtomDeclarationSchema.parse(input);
    validateIdentity(input.identity, input.inputs, options.identities, label);
    return register(path, {
      ...input,
      dependsOn: normalizedReferences(input.dependsOn ?? []),
      executor: normalizedReferences(Array.isArray(input.executor) ? input.executor : [input.executor]),
      identity: normalizedIdentity(input.identity),
      inputs: normalizedInputs(input.inputs),
      outputs: normalizedOutputs(input.outputs),
    } as unknown as ReleaseWorkflowAtomDeclaration & Record<string, unknown>, { effect: atomEffects[path] });
  }

  function proof<Path extends "proof.installed.scenario" | "proof.qualification.channel" | "proof.transition.updater">(
    path: Path,
    input: ReleaseWorkflowProofDeclaration,
  ): ReleaseWorkflowReference<Path> {
    const label = `${path}.${input.id}`;
    releaseWorkflowProofDeclarationSchema.parse(input);
    validateIdentity(input.identity, input.inputs, options.identities, label);
    return register(path, {
      ...input,
      dependsOn: normalizedReferences(input.dependsOn),
      doesNotProve: [...input.doesNotProve].sort(),
      executor: normalizedReferences(Array.isArray(input.executor) ? input.executor : [input.executor]),
      identity: normalizedIdentity(input.identity),
      inputs: normalizedInputs(input.inputs),
      outputs: normalizedOutputs(input.outputs),
      proves: [...input.proves].sort(),
    } as unknown as ReleaseWorkflowProofDeclaration & Record<string, unknown>, { effect: "proof" });
  }

  function policy<Path extends "policy.channel.exact" | "policy.channel.prerelease" | "policy.channel.stable">(
    path: Path,
    input: ReleaseWorkflowChannelPolicyDeclaration,
  ): ReleaseWorkflowReference<Path> {
    const schema = path === "policy.channel.stable"
      ? releaseWorkflowStableChannelPolicyDeclarationSchema
      : path === "policy.channel.prerelease"
        ? releaseWorkflowPrereleaseChannelPolicyDeclarationSchema
        : releaseWorkflowExactChannelPolicyDeclarationSchema;
    schema.parse(input);
    const channelClass = path.slice("policy.channel.".length);
    return register(path, input as unknown as ReleaseWorkflowChannelPolicyDeclaration & Record<string, unknown>, { channelClass });
  }

  function executor<Path extends "executor.control" | "executor.mac" | "executor.windows">(
    path: Path,
    input: ReleaseWorkflowExecutorDeclaration,
  ): ReleaseWorkflowReference<Path> {
    releaseWorkflowExecutorDeclarationSchema.parse(input);
    return register(path, {
      ...input,
      capabilities: [...input.capabilities].sort(),
      secretReferences: [...(input.secretReferences ?? [])].sort(),
    } as unknown as ReleaseWorkflowExecutorDeclaration & Record<string, unknown>);
  }

  function desktop(input: ReleaseWorkflowDesktopDeclaration): ReleaseWorkflowReference<"release.desktop"> {
    releaseWorkflowDesktopDeclarationSchema.parse(input);
    return register("release.desktop", {
      ...input,
      atoms: normalizedReferences(input.atoms),
      executors: normalizedReferences(input.executors),
      policies: normalizedReferences(input.policies),
      proofs: normalizedReferences(input.proofs),
      targets: [...input.targets].sort(),
    } as unknown as ReleaseWorkflowDesktopDeclaration & Record<string, unknown>);
  }

  function seal(): SealedReleaseWorkflow {
    assertOpen();
    const releases = [...definitions.values()].filter(({ path }) => path === "release.desktop");
    if (releases.length !== 1) throw new Error(`release workflow ${options.id} must declare exactly one release.desktop`);
    sealed = true;
    const manifest = deepFreeze({
      definitions: [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id)),
      formatVersion: 1,
      workflow: { id: options.id, schemaVersion: options.schemaVersion },
    } satisfies ReleaseWorkflowManifest);
    releaseWorkflowManifestSchema.parse(manifest);
    const canonical = canonicalMetadataJson(manifest);
    return deepFreeze({ canonical, digest: metadataDigest(canonical), manifest });
  }

  return deepFreeze({
    atom: {
      attest: { publication: (input) => atom("atom.attest.publication", input) },
      build: {
        closureShared: (input) => atom("atom.build.closureShared", input),
        closureTarget: (input) => atom("atom.build.closureTarget", input),
        shell: (input) => atom("atom.build.shell", input),
      },
      compose: { manifest: (input) => atom("atom.compose.manifest", input) },
      notify: { release: (input) => atom("atom.notify.release", input) },
      project: { object: (input) => atom("atom.project.object", input) },
      transact: {
        activate: (input) => atom("atom.transact.activate", input),
        reserve: (input) => atom("atom.transact.reserve", input),
      },
    },
    executor: {
      control: (input) => executor("executor.control", input),
      mac: (input) => executor("executor.mac", input),
      windows: (input) => executor("executor.windows", input),
    },
    policy: {
      channel: {
        exact: (input) => policy("policy.channel.exact", input),
        prerelease: (input) => policy("policy.channel.prerelease", input),
        stable: (input) => policy("policy.channel.stable", input),
      },
    },
    proof: {
      installed: { scenario: (input) => proof("proof.installed.scenario", input) },
      qualification: { channel: (input) => proof("proof.qualification.channel", input) },
      transition: { updater: (input) => proof("proof.transition.updater", input) },
    },
    release: { desktop },
    seal,
  });
}
