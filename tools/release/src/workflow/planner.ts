import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";

import {
  releaseWorkflowPlanSchema,
  releaseWorkflowReceiptSchema,
  releaseWorkflowRequestSchema,
  type ReleaseWorkflowPlan,
  type ReleaseWorkflowReceipt,
  type ReleaseWorkflowRequest,
} from "./protocol.ts";
import {
  releaseWorkflowManifestSchema,
  type ReleaseWorkflowManifest,
} from "./schema.ts";

type Digest = `sha256:${string}`;
type Effect = "cas-transition" | "conditional-copy" | "immutable-write" | "notification" | "proof" | "pure";
type Gate = "activate" | "always" | "counted" | "publish";
type Binding =
  | Readonly<{ path: string; source: "request" }>
  | Readonly<{ path: string; source: "target"; target: "mac_arm64" | "mac_x64" | "win_x64" }>
  | Readonly<{ source: "literal"; value: unknown }>;
type NodeConfig = Readonly<{
  bindings: Readonly<Record<string, Binding>>;
  dependsOn: readonly Readonly<{ $ref: string }>[];
  effect: Effect;
  executor: readonly Readonly<{ $ref: string }>[];
  gate: Gate;
  identity?: Readonly<{ ids: readonly string[]; parameters: readonly string[] }>;
  inputs: Readonly<{
    audit: readonly string[];
    materialization: readonly string[];
    operational: readonly string[];
    semantic: readonly string[];
  }>;
  outputs: readonly Readonly<{ mediaType?: string; role: string; schemaVersion: number }>[];
}>;
type NodeDefinition = Readonly<{
  config: NodeConfig;
  id: string;
  path: string;
  schemaVersion: number;
}>;

export type ReleaseWorkflowPlannerDependencies = Readonly<{
  now?: () => Date;
  resolveIdentity: (input: Readonly<{
    id: string;
    parameters: Readonly<Record<string, unknown>>;
  }>) => Promise<Digest>;
  resolveReceipt: (input: Readonly<{
    definitionDigest: Digest;
    effect: Effect;
    executionDigest: Digest;
    identityDigests: Readonly<Record<string, Digest>>;
    inputs: Readonly<{
      audit: Readonly<Record<string, unknown>>;
      materialization: Readonly<Record<string, unknown>>;
      operational: Readonly<Record<string, unknown>>;
      semantic: Readonly<Record<string, unknown>>;
    }>;
    nodeId: string;
    outputs: NodeConfig["outputs"];
    path: string;
    semanticDigest: Digest;
  }>) => Promise<unknown | null>;
}>;

function requestValue(request: ReleaseWorkflowRequest, path: string): unknown {
  const field = path.slice("release.".length) as keyof ReleaseWorkflowRequest["release"];
  if (!path.startsWith("release.") || !(field in request.release)) throw new Error(`unsupported release request input path: ${path}`);
  return request.release[field];
}

function bindingValue(request: ReleaseWorkflowRequest, binding: Binding): unknown {
  if (binding.source === "literal") return binding.value;
  if (binding.source === "request") return requestValue(request, binding.path);
  const target = request.targets.find(({ name }) => name === binding.target);
  if (target == null) throw new Error(`release request does not select bound target: ${binding.target}`);
  const field = binding.path.slice("target.".length) as keyof typeof target;
  if (!binding.path.startsWith("target.") || !(field in target)) throw new Error(`unsupported release target input path: ${binding.path}`);
  return target[field];
}

function boundInputs(config: NodeConfig, request: ReleaseWorkflowRequest) {
  const bind = (names: readonly string[]): Record<string, unknown> => Object.fromEntries(
    names.map((name) => [name, bindingValue(request, config.bindings[name]!)]),
  );
  return {
    audit: bind(config.inputs.audit),
    materialization: bind(config.inputs.materialization),
    operational: bind(config.inputs.operational),
    semantic: bind(config.inputs.semantic),
  };
}

function selectedByTarget(config: NodeConfig, request: ReleaseWorkflowRequest): boolean {
  const selected = new Set(request.targets.map(({ name }) => name));
  return Object.values(config.bindings).every((binding) => binding.source !== "target" || selected.has(binding.target));
}

function policyPath(channel: string): "policy.channel.exact" | "policy.channel.prerelease" | "policy.channel.stable" {
  if (channel === "stable") return "policy.channel.stable";
  if (channel === "prerelease") return "policy.channel.prerelease";
  return "policy.channel.exact";
}

function gateEnabled(gate: Gate, policy: Readonly<{ counted: boolean }>, request: ReleaseWorkflowRequest): boolean {
  if (gate === "always") return true;
  if (gate === "counted") return policy.counted;
  if (gate === "publish") return request.release.publish;
  return request.release.activate;
}

function assertReceipt(
  value: unknown,
  expected: Readonly<{
    definitionDigest: Digest;
    effect: Effect;
    executionDigest: Digest;
    nodeId: string;
    outputs: NodeConfig["outputs"];
    semanticDigest: Digest;
  }>,
): ReleaseWorkflowReceipt {
  const receipt = releaseWorkflowReceiptSchema.parse(value);
  if (
    receipt.definitionDigest !== expected.definitionDigest
    || receipt.effect !== expected.effect
    || receipt.executionDigest !== expected.executionDigest
    || receipt.nodeId !== expected.nodeId
    || receipt.semanticDigest !== expected.semanticDigest
  ) throw new Error("receipt identity does not match the planned node");
  const expectedOutputs = expected.outputs.map(({ mediaType, role, schemaVersion }) => ({ mediaType, role, schemaVersion }));
  const actualOutputs = receipt.outputs.map(({ mediaType, role, schemaVersion }) => ({ mediaType, role, schemaVersion }));
  if (canonicalMetadataJson(actualOutputs) !== canonicalMetadataJson(expectedOutputs)) {
    throw new Error("receipt outputs do not match the planned node contract");
  }
  return receipt;
}

export async function planReleaseWorkflow(
  manifestInput: unknown,
  requestInput: unknown,
  dependencies: ReleaseWorkflowPlannerDependencies,
): Promise<ReleaseWorkflowPlan> {
  const manifest = releaseWorkflowManifestSchema.parse(manifestInput) as ReleaseWorkflowManifest;
  const request = releaseWorkflowRequestSchema.parse(requestInput);
  const canonicalManifest = canonicalMetadataJson(manifest);
  const workflowDigest = metadataDigest(canonicalManifest);
  if (request.workflowDigest !== workflowDigest) throw new Error("release request workflowDigest does not match the manifest");

  const release = manifest.definitions.find(({ path }) => path === "release.desktop");
  if (release?.path !== "release.desktop") throw new Error("release workflow has no desktop release");
  const selectedPolicyPath = policyPath(request.release.channel);
  const policyRef = release.config.policies.find(({ $ref }) => $ref.includes(`/${selectedPolicyPath}/`));
  const policyDefinition = policyRef == null ? null : manifest.definitions.find(({ id }) => id === policyRef.$ref);
  if (policyDefinition?.path !== selectedPolicyPath) throw new Error(`release workflow has no ${selectedPolicyPath} policy`);
  const policy = policyDefinition.config;

  const releaseNodeIds = new Set([
    ...release.config.atoms.map(({ $ref }) => $ref),
    ...release.config.proofs.map(({ $ref }) => $ref),
  ]);
  const definitions = new Map(
    manifest.definitions
      .filter((definition) => releaseNodeIds.has(definition.id))
      .map((definition) => [definition.id, definition as unknown as NodeDefinition]),
  );
  const active = new Set([...definitions.values()]
    .filter(({ config }) => selectedByTarget(config, request) && gateEnabled(config.gate, policy, request))
    .map(({ id }) => id));
  const ordered: NodeDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (!active.has(id) || visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`release workflow contains a dependency cycle at ${id}`);
    const definition = definitions.get(id);
    if (definition == null) throw new Error(`release workflow references unknown node: ${id}`);
    visiting.add(id);
    for (const dependency of definition.config.dependsOn) visit(dependency.$ref);
    visiting.delete(id);
    visited.add(id);
    ordered.push(definition);
  };
  for (const id of [...active].sort()) visit(id);

  const planned = new Map<string, ReleaseWorkflowPlan["nodes"][number]>();
  for (const definition of ordered) {
    const inputs = boundInputs(definition.config, request);
    const identityDigests: Record<string, Digest> = {};
    if (definition.config.identity != null) {
      const parameters = Object.fromEntries(definition.config.identity.parameters.map((name) => [name, inputs.semantic[name]]));
      for (const id of definition.config.identity.ids) {
        identityDigests[id] = await dependencies.resolveIdentity({ id, parameters });
      }
    }
    const definitionDigest = metadataDigest(canonicalMetadataJson({
      config: definition.config,
      id: definition.id,
      path: definition.path,
      schemaVersion: definition.schemaVersion,
    }));
    const dependencyNodes = definition.config.dependsOn
      .map(({ $ref }) => planned.get($ref))
      .filter((node): node is NonNullable<typeof node> => node != null);
    const semanticDigest = metadataDigest(canonicalMetadataJson({
      definitionDigest,
      dependencies: dependencyNodes.map(({ semanticDigest: digest }) => digest),
      identities: identityDigests,
      semantic: inputs.semantic,
    }));
    const executionDigest = metadataDigest(canonicalMetadataJson({
      dependencies: dependencyNodes.map(({ executionDigest: digest }) => digest),
      materialization: inputs.materialization,
      semanticDigest,
    }));
    let receipt: ReleaseWorkflowReceipt | undefined;
    let reason: "receipt-hit" | "receipt-miss" | "receipt-rejected" | "side-effect-required" = "receipt-miss";
    if (definition.config.effect === "notification") {
      reason = "side-effect-required";
    } else {
      const candidate = await dependencies.resolveReceipt({
        definitionDigest,
        effect: definition.config.effect,
        executionDigest,
        identityDigests,
        inputs,
        nodeId: definition.id,
        outputs: definition.config.outputs,
        path: definition.path,
        semanticDigest,
      });
      if (candidate != null) {
        try {
          receipt = assertReceipt(candidate, {
            definitionDigest,
            effect: definition.config.effect,
            executionDigest,
            nodeId: definition.id,
            outputs: definition.config.outputs,
            semanticDigest,
          });
          reason = "receipt-hit";
        } catch {
          reason = "receipt-rejected";
        }
      }
    }
    const node = {
      decision: receipt == null ? "execute" as const : "replay" as const,
      definitionDigest,
      dependencies: dependencyNodes.map(({ nodeId }) => nodeId),
      effect: definition.config.effect,
      executionDigest,
      executorIds: definition.config.executor.map(({ $ref }) => $ref),
      gate: definition.config.gate,
      identityDigests,
      inputs,
      nodeId: definition.id,
      path: definition.path as ReleaseWorkflowPlan["nodes"][number]["path"],
      reason,
      ...(receipt == null ? {} : { receipt }),
      semanticDigest,
    };
    planned.set(definition.id, node);
  }

  return releaseWorkflowPlanSchema.parse({
    formatVersion: 1,
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    nodes: [...planned.values()],
    policy: {
      activate: request.release.activate,
      counted: policy.counted,
      path: selectedPolicyPath,
      publish: request.release.publish,
    },
    requestDigest: metadataDigest(canonicalMetadataJson(request)),
    schemaVersion: 1,
    workflowDigest,
  });
}
