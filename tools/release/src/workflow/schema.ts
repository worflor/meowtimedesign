import { canonicalMetadataJson } from "@open-design/metatool";
import { z } from "zod";

import type { IdentityRegistry } from "../identity/declaration/schema.ts";

declare const releaseWorkflowReferenceBrand: unique symbol;

export const RELEASE_WORKFLOW_DEFINITION_PATHS = [
  "atom.attest.publication",
  "atom.build.closureShared",
  "atom.build.closureTarget",
  "atom.build.shell",
  "atom.compose.manifest",
  "atom.notify.release",
  "atom.project.object",
  "atom.transact.activate",
  "atom.transact.reserve",
  "executor.control",
  "executor.mac",
  "executor.windows",
  "policy.channel.exact",
  "policy.channel.prerelease",
  "policy.channel.stable",
  "proof.installed.scenario",
  "proof.qualification.channel",
  "proof.transition.updater",
  "release.desktop",
] as const;

export type ReleaseWorkflowDefinitionPath = typeof RELEASE_WORKFLOW_DEFINITION_PATHS[number];

export const releaseWorkflowDefinitionPathSchema = z.enum(RELEASE_WORKFLOW_DEFINITION_PATHS);

const workflowIdSchema = z.string().regex(/^[a-z][a-z0-9.-]*$/u);
const definitionIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const fieldNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u);
const roleSchema = z.string().regex(/^[a-z][a-zA-Z0-9.-]*$/u);
const positiveIntegerSchema = z.number().int().positive().safe();
const releaseTargetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);

export const RELEASE_WORKFLOW_REQUEST_INPUT_PATHS = [
  "release.activate",
  "release.channel",
  "release.commit",
  "release.minShellVersion",
  "release.namespace",
  "release.nodeVersion",
  "release.packageManager",
  "release.profile",
  "release.publicOrigin",
  "release.publish",
  "release.releaseVersion",
] as const;

export const RELEASE_WORKFLOW_TARGET_INPUT_PATHS = [
  "target.buildTarget",
  "target.name",
  "target.namespace",
  "target.nodeModulesAbi",
  "target.nodeNapi",
  "target.platform",
  "target.signMode",
  "target.smokeMatrix",
  "target.standaloneProtocolVersion",
] as const;

const canonicalLiteralSchema = z.unknown().superRefine((value, context) => {
  try {
    canonicalMetadataJson(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
  }
});

export const releaseWorkflowInputBindingSchema = z.discriminatedUnion("source", [
  z.object({ path: z.enum(RELEASE_WORKFLOW_REQUEST_INPUT_PATHS), source: z.literal("request") }).strict(),
  z.object({ path: z.enum(RELEASE_WORKFLOW_TARGET_INPUT_PATHS), source: z.literal("target"), target: releaseTargetSchema }).strict(),
  z.object({ source: z.literal("literal"), value: canonicalLiteralSchema }).strict(),
]);

function declaredInputNames(value: z.infer<typeof releaseWorkflowInputClassesSchema>): string[] {
  return [
    ...value.semantic,
    ...(value.materialization ?? []),
    ...(value.operational ?? []),
    ...(value.audit ?? []),
  ].sort();
}

function validateBindings(
  value: Readonly<{ bindings: Record<string, unknown>; inputs: z.infer<typeof releaseWorkflowInputClassesSchema> }>,
  context: z.RefinementCtx,
): void {
  const expected = declaredInputNames(value.inputs);
  const actual = Object.keys(value.bindings).sort();
  if (canonicalMetadataJson(actual) !== canonicalMetadataJson(expected)) {
    context.addIssue({ code: "custom", message: "input bindings must exactly cover declared inputs", path: ["bindings"] });
  }
}

function uniqueArray<Value extends z.ZodTypeAny>(
  value: Value,
  label: string,
  cardinality: Readonly<{ length?: number; min?: number }> = {},
): z.ZodEffects<z.ZodArray<Value>> {
  let array = z.array(value);
  if (cardinality.min != null) array = array.min(cardinality.min);
  if (cardinality.length != null) array = array.length(cardinality.length);
  return array.superRefine((entries, context) => {
    if (new Set(entries.map((entry) => canonicalMetadataJson(entry))).size !== entries.length) {
      context.addIssue({ code: "custom", message: `${label} must be unique` });
    }
  });
}

const referenceShapeSchema = z.object({
  id: z.string().min(1),
  path: releaseWorkflowDefinitionPathSchema,
}).passthrough();

const executorReferenceSchema = referenceShapeSchema.refine(
  ({ path }) => path === "executor.control" || path === "executor.mac" || path === "executor.windows",
  "executor ref has an invalid path",
);
const atomReferenceSchema = referenceShapeSchema.refine(({ path }) => path.startsWith("atom."), "atom ref has an invalid path");
const proofReferenceSchema = referenceShapeSchema.refine(({ path }) => path.startsWith("proof."), "proof ref has an invalid path");
const policyReferenceSchema = referenceShapeSchema.refine(({ path }) => path.startsWith("policy.channel."), "policy ref has an invalid path");

export const releaseWorkflowInputClassesSchema = z.object({
  audit: uniqueArray(fieldNameSchema, "audit inputs").optional(),
  materialization: uniqueArray(fieldNameSchema, "materialization inputs").optional(),
  operational: uniqueArray(fieldNameSchema, "operational inputs").optional(),
  semantic: uniqueArray(fieldNameSchema, "semantic inputs"),
}).strict().superRefine((value, context) => {
  const names = [
    ...value.semantic,
    ...(value.materialization ?? []),
    ...(value.operational ?? []),
    ...(value.audit ?? []),
  ];
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "input classes must not overlap" });
  }
});

export const releaseWorkflowIdentityBindingSchema = z.object({
  ids: uniqueArray(z.string().min(1), "identity ids", { min: 1 }),
  parameters: uniqueArray(fieldNameSchema, "identity parameters"),
}).strict();

export const releaseWorkflowOutputDeclarationSchema = z.object({
  mediaType: z.string().min(1).optional(),
  role: roleSchema,
  schemaVersion: positiveIntegerSchema,
}).strict();

const definitionBaseSchema = z.object({
  id: definitionIdSchema,
  schemaVersion: positiveIntegerSchema,
}).strict();

export const releaseWorkflowAtomDeclarationSchema = definitionBaseSchema.extend({
  bindings: z.record(fieldNameSchema, releaseWorkflowInputBindingSchema),
  confidence: z.enum(["certain", "low"]),
  dependsOn: uniqueArray(z.union([atomReferenceSchema, proofReferenceSchema]), "atom dependencies").optional(),
  executor: z.union([executorReferenceSchema, uniqueArray(executorReferenceSchema, "atom executors", { min: 1 })]),
  identity: releaseWorkflowIdentityBindingSchema.optional(),
  inputs: releaseWorkflowInputClassesSchema,
  outputs: uniqueArray(releaseWorkflowOutputDeclarationSchema, "atom outputs", { min: 1 }),
  witness: z.string().min(1),
}).superRefine((value, context) => {
  validateBindings(value, context);
  if (new Set(value.outputs.map(({ role }) => role)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", message: "atom output roles must be unique", path: ["outputs"] });
  }
});

export const releaseWorkflowProofDeclarationSchema = definitionBaseSchema.extend({
  bindings: z.record(fieldNameSchema, releaseWorkflowInputBindingSchema),
  boundaries: z.record(z.string(), z.string()),
  confidence: z.enum(["certain", "low"]),
  dependsOn: uniqueArray(atomReferenceSchema, "proof dependencies"),
  doesNotProve: uniqueArray(z.string().min(1), "doesNotProve"),
  executor: z.union([executorReferenceSchema, uniqueArray(executorReferenceSchema, "proof executors", { min: 1 })]),
  identity: releaseWorkflowIdentityBindingSchema,
  inputs: releaseWorkflowInputClassesSchema,
  outputs: uniqueArray(releaseWorkflowOutputDeclarationSchema, "proof outputs", { min: 1 }),
  portability: z.object({
    channel: z.enum(["scoped", "qualification-projection"]),
    namespace: z.literal("scoped"),
    releaseVersion: z.enum(["exact", "semantic"]),
  }).strict(),
  proves: uniqueArray(z.string().min(1), "proves", { min: 1 }),
  witness: z.string().min(1),
}).superRefine((value, context) => {
  validateBindings(value, context);
  if (new Set(value.outputs.map(({ role }) => role)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", message: "proof output roles must be unique", path: ["outputs"] });
  }
});

const releaseWorkflowChannelPolicyDeclarationBaseSchema = definitionBaseSchema.extend({
  counted: z.boolean(),
  defaultActivate: z.boolean(),
  defaultPublish: z.boolean(),
  proofScope: z.literal("channel-namespace"),
});

function channelPolicySchema(counted: boolean, channelClass: string) {
  return releaseWorkflowChannelPolicyDeclarationBaseSchema.superRefine((value, context) => {
  if (value.defaultActivate && !value.defaultPublish) {
    context.addIssue({ code: "custom", message: "activation requires publication", path: ["defaultActivate"] });
  }
    if (value.counted !== counted) {
      context.addIssue({
        code: "custom",
        message: counted ? `${channelClass} release policy must be counted` : `${channelClass} release policy must not be counted`,
        path: ["counted"],
      });
    }
  });
}

export const releaseWorkflowExactChannelPolicyDeclarationSchema = channelPolicySchema(true, "exact");
export const releaseWorkflowPrereleaseChannelPolicyDeclarationSchema = channelPolicySchema(true, "prerelease");
export const releaseWorkflowStableChannelPolicyDeclarationSchema = channelPolicySchema(false, "stable");
export const releaseWorkflowChannelPolicyDeclarationSchema = z.union([
  releaseWorkflowExactChannelPolicyDeclarationSchema,
  releaseWorkflowPrereleaseChannelPolicyDeclarationSchema,
  releaseWorkflowStableChannelPolicyDeclarationSchema,
]);

export const releaseWorkflowExecutorDeclarationSchema = definitionBaseSchema.extend({
  capabilities: uniqueArray(roleSchema, "executor capabilities", { min: 1 }),
  runnerClass: z.string().min(1),
  secretReferences: uniqueArray(fieldNameSchema, "executor secret references").optional(),
});

export const releaseWorkflowDesktopDeclarationSchema = definitionBaseSchema.extend({
  atoms: uniqueArray(atomReferenceSchema, "desktop atoms", { min: 1 }),
  executors: uniqueArray(executorReferenceSchema, "desktop executors", { min: 1 }),
  policies: uniqueArray(policyReferenceSchema, "desktop policies", { length: 3 }),
  proofs: uniqueArray(proofReferenceSchema, "desktop proofs"),
  targets: uniqueArray(z.enum(["mac_arm64", "mac_x64", "win_x64"]), "desktop targets", { min: 1 }),
}).superRefine((value, context) => {
  const paths = new Set(value.policies.map(({ path }) => path));
  for (const path of ["policy.channel.exact", "policy.channel.prerelease", "policy.channel.stable"] as const) {
    if (!paths.has(path)) context.addIssue({ code: "custom", message: `desktop release requires ${path}`, path: ["policies"] });
  }
});

export const releaseWorkflowFactoryOptionsSchema = z.object({
  id: workflowIdSchema,
  identities: z.custom<IdentityRegistry>((value) => value != null && typeof value === "object"),
  schemaVersion: positiveIntegerSchema,
}).strict();

const manifestReferenceSchema = z.object({ $ref: z.string().min(1) }).strict();

function manifestReferenceTo(paths: readonly ReleaseWorkflowDefinitionPath[]) {
  return manifestReferenceSchema.refine(
    ({ $ref }) => paths.some((path) => $ref.includes(`/${path}/`)),
    "manifest ref has an invalid definition path",
  );
}

const manifestAtomReferenceSchema = manifestReferenceTo(RELEASE_WORKFLOW_DEFINITION_PATHS.filter((path) => path.startsWith("atom.")));
const manifestProofReferenceSchema = manifestReferenceTo(RELEASE_WORKFLOW_DEFINITION_PATHS.filter((path) => path.startsWith("proof.")));
const manifestExecutorReferenceSchema = manifestReferenceTo(RELEASE_WORKFLOW_DEFINITION_PATHS.filter((path) => path.startsWith("executor.")));
const manifestPolicyReferenceSchema = manifestReferenceTo(RELEASE_WORKFLOW_DEFINITION_PATHS.filter((path) => path.startsWith("policy.channel.")));
const manifestReferencesSchema = uniqueArray(z.string().min(1), "manifest references");
const normalizedInputClassesSchema = z.object({
  audit: uniqueArray(fieldNameSchema, "audit inputs"),
  materialization: uniqueArray(fieldNameSchema, "materialization inputs"),
  operational: uniqueArray(fieldNameSchema, "operational inputs"),
  semantic: uniqueArray(fieldNameSchema, "semantic inputs"),
}).strict().superRefine((value, context) => {
  const names = [...value.audit, ...value.materialization, ...value.operational, ...value.semantic];
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "input classes must not overlap" });
  }
});

const manifestAtomConfigSchema = z.object({
  bindings: z.record(fieldNameSchema, releaseWorkflowInputBindingSchema),
  confidence: z.enum(["certain", "low"]),
  dependsOn: uniqueArray(z.union([manifestAtomReferenceSchema, manifestProofReferenceSchema]), "atom dependencies"),
  effect: z.enum(["cas-transition", "conditional-copy", "immutable-write", "notification", "pure"]),
  gate: z.enum(["activate", "always", "counted", "publish"]),
  executor: uniqueArray(manifestExecutorReferenceSchema, "atom executors", { min: 1 }),
  identity: releaseWorkflowIdentityBindingSchema.optional(),
  inputs: normalizedInputClassesSchema,
  outputs: uniqueArray(releaseWorkflowOutputDeclarationSchema, "atom outputs", { min: 1 }),
  references: manifestReferencesSchema,
  witness: z.string().min(1),
}).strict().superRefine((value, context) => {
  validateBindings(value, context);
  if (new Set(value.outputs.map(({ role }) => role)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", message: "atom output roles must be unique", path: ["outputs"] });
  }
});

const manifestProofConfigSchema = z.object({
  bindings: z.record(fieldNameSchema, releaseWorkflowInputBindingSchema),
  boundaries: z.record(z.string(), z.string()),
  confidence: z.enum(["certain", "low"]),
  dependsOn: uniqueArray(manifestAtomReferenceSchema, "proof dependencies"),
  doesNotProve: uniqueArray(z.string().min(1), "doesNotProve"),
  effect: z.literal("proof"),
  gate: z.literal("always"),
  executor: uniqueArray(manifestExecutorReferenceSchema, "proof executors", { min: 1 }),
  identity: releaseWorkflowIdentityBindingSchema,
  inputs: normalizedInputClassesSchema,
  outputs: uniqueArray(releaseWorkflowOutputDeclarationSchema, "proof outputs", { min: 1 }),
  portability: z.object({
    channel: z.enum(["scoped", "qualification-projection"]),
    namespace: z.literal("scoped"),
    releaseVersion: z.enum(["exact", "semantic"]),
  }).strict(),
  proves: uniqueArray(z.string().min(1), "proves", { min: 1 }),
  references: manifestReferencesSchema,
  witness: z.string().min(1),
}).strict().superRefine((value, context) => {
  validateBindings(value, context);
  if (new Set(value.outputs.map(({ role }) => role)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", message: "proof output roles must be unique", path: ["outputs"] });
  }
});

const manifestExecutorConfigSchema = z.object({
  capabilities: uniqueArray(roleSchema, "executor capabilities", { min: 1 }),
  references: manifestReferencesSchema,
  runnerClass: z.string().min(1),
  secretReferences: uniqueArray(fieldNameSchema, "executor secret references"),
}).strict();

function manifestPolicyConfigSchema(counted: boolean, channelClass: "exact" | "prerelease" | "stable") {
  return z.object({
    channelClass: z.literal(channelClass),
    counted: z.literal(counted),
    defaultActivate: z.boolean(),
    defaultPublish: z.boolean(),
    proofScope: z.literal("channel-namespace"),
    references: manifestReferencesSchema,
  }).strict().superRefine((value, context) => {
    if (value.defaultActivate && !value.defaultPublish) {
      context.addIssue({ code: "custom", message: "activation requires publication", path: ["defaultActivate"] });
    }
  });
}

const manifestDesktopConfigSchema = z.object({
  atoms: uniqueArray(manifestAtomReferenceSchema, "desktop atoms", { min: 1 }),
  executors: uniqueArray(manifestExecutorReferenceSchema, "desktop executors", { min: 1 }),
  policies: uniqueArray(manifestPolicyReferenceSchema, "desktop policies", { length: 3 }),
  proofs: uniqueArray(manifestProofReferenceSchema, "desktop proofs"),
  references: manifestReferencesSchema,
  targets: uniqueArray(releaseTargetSchema, "desktop targets", { min: 1 }),
}).strict().superRefine((value, context) => {
  for (const path of ["policy.channel.exact", "policy.channel.prerelease", "policy.channel.stable"] as const) {
    if (!value.policies.some(({ $ref }) => $ref.includes(`/${path}/`))) {
      context.addIssue({ code: "custom", message: `desktop release requires ${path}`, path: ["policies"] });
    }
  }
});

function manifestDefinitionSchema<Path extends ReleaseWorkflowDefinitionPath, Config extends z.ZodTypeAny>(path: Path, config: Config) {
  return z.object({
    config,
    id: z.string().min(1),
    path: z.literal(path),
    schemaVersion: positiveIntegerSchema,
  }).strict();
}

const releaseWorkflowManifestDefinitionSchema = z.union([
  manifestDefinitionSchema("atom.attest.publication", manifestAtomConfigSchema.and(z.object({ effect: z.literal("immutable-write") }))),
  manifestDefinitionSchema("atom.build.closureShared", manifestAtomConfigSchema.and(z.object({ effect: z.literal("pure") }))),
  manifestDefinitionSchema("atom.build.closureTarget", manifestAtomConfigSchema.and(z.object({ effect: z.literal("pure") }))),
  manifestDefinitionSchema("atom.build.shell", manifestAtomConfigSchema.and(z.object({ effect: z.literal("pure") }))),
  manifestDefinitionSchema("atom.compose.manifest", manifestAtomConfigSchema.and(z.object({ effect: z.literal("pure") }))),
  manifestDefinitionSchema("atom.notify.release", manifestAtomConfigSchema.and(z.object({ effect: z.literal("notification") }))),
  manifestDefinitionSchema("atom.project.object", manifestAtomConfigSchema.and(z.object({ effect: z.literal("conditional-copy") }))),
  manifestDefinitionSchema("atom.transact.activate", manifestAtomConfigSchema.and(z.object({ effect: z.literal("cas-transition") }))),
  manifestDefinitionSchema("atom.transact.reserve", manifestAtomConfigSchema.and(z.object({ effect: z.literal("cas-transition") }))),
  manifestDefinitionSchema("executor.control", manifestExecutorConfigSchema),
  manifestDefinitionSchema("executor.mac", manifestExecutorConfigSchema),
  manifestDefinitionSchema("executor.windows", manifestExecutorConfigSchema),
  manifestDefinitionSchema("policy.channel.exact", manifestPolicyConfigSchema(true, "exact")),
  manifestDefinitionSchema("policy.channel.prerelease", manifestPolicyConfigSchema(true, "prerelease")),
  manifestDefinitionSchema("policy.channel.stable", manifestPolicyConfigSchema(false, "stable")),
  manifestDefinitionSchema("proof.installed.scenario", manifestProofConfigSchema),
  manifestDefinitionSchema("proof.qualification.channel", manifestProofConfigSchema),
  manifestDefinitionSchema("proof.transition.updater", manifestProofConfigSchema),
  manifestDefinitionSchema("release.desktop", manifestDesktopConfigSchema),
]);

function collectManifestReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectManifestReferences(entry, references);
    return;
  }
  if (value == null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") references.add(record.$ref);
  for (const [key, entry] of Object.entries(record)) {
    if (key !== "references") collectManifestReferences(entry, references);
  }
}

export const releaseWorkflowManifestSchema = z.object({
  definitions: z.array(releaseWorkflowManifestDefinitionSchema),
  formatVersion: z.literal(1),
  workflow: z.object({ id: workflowIdSchema, schemaVersion: positiveIntegerSchema }).strict(),
}).strict().superRefine((manifest, context) => {
  const definitions = new Map(manifest.definitions.map((definition) => [definition.id, definition]));
  if (definitions.size !== manifest.definitions.length) {
    context.addIssue({ code: "custom", message: "manifest definition ids must be unique", path: ["definitions"] });
  }
  const orderedIds = manifest.definitions.map(({ id }) => id);
  if (orderedIds.some((id, index) => index > 0 && orderedIds[index - 1]!.localeCompare(id) >= 0)) {
    context.addIssue({ code: "custom", message: "manifest definitions must be canonically ordered", path: ["definitions"] });
  }
  for (const [index, definition] of manifest.definitions.entries()) {
    const expectedPrefix = `${manifest.workflow.id}/${definition.path}/`;
    if (!definition.id.startsWith(expectedPrefix) || !definitionIdSchema.safeParse(definition.id.slice(expectedPrefix.length)).success) {
      context.addIssue({ code: "custom", message: "manifest definition id does not match its workflow and path", path: ["definitions", index, "id"] });
    }
    const actualReferences = new Set<string>();
    collectManifestReferences(definition.config, actualReferences);
    const declaredReferences = definition.config.references;
    if (canonicalMetadataJson([...actualReferences].sort()) !== canonicalMetadataJson(declaredReferences)) {
      context.addIssue({ code: "custom", message: "manifest references must exactly index config refs", path: ["definitions", index, "config", "references"] });
    }
    for (const reference of actualReferences) {
      if (!definitions.has(reference)) {
        context.addIssue({ code: "custom", message: `manifest references unknown definition: ${reference}`, path: ["definitions", index, "config"] });
      }
    }
  }
  const releases = manifest.definitions.filter(({ path }) => path === "release.desktop");
  if (releases.length !== 1) {
    context.addIssue({ code: "custom", message: "manifest must contain exactly one release.desktop", path: ["definitions"] });
    return;
  }
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const definition = definitions.get(id);
    if (definition == null) return;
    for (const reference of definition.config.references) visit(reference);
  };
  visit(releases[0]!.id);
  const orphaned = manifest.definitions.filter(({ id }) => !reachable.has(id)).map(({ id }) => id);
  if (orphaned.length > 0) {
    context.addIssue({ code: "custom", message: `manifest contains definitions outside the release graph: ${orphaned.join(", ")}`, path: ["definitions"] });
  }
});

export type ReleaseWorkflowReference<Path extends ReleaseWorkflowDefinitionPath = ReleaseWorkflowDefinitionPath> = Readonly<{
  id: string;
  path: Path;
  [releaseWorkflowReferenceBrand]: Path;
}>;

export type ReleaseWorkflowExecutorReference = ReleaseWorkflowReference<
  "executor.control" | "executor.mac" | "executor.windows"
>;

export type ReleaseWorkflowPolicyReference = ReleaseWorkflowReference<
  "policy.channel.exact" | "policy.channel.prerelease" | "policy.channel.stable"
>;

export type ReleaseWorkflowAtomReference = ReleaseWorkflowReference<
  | "atom.attest.publication"
  | "atom.build.closureShared"
  | "atom.build.closureTarget"
  | "atom.build.shell"
  | "atom.compose.manifest"
  | "atom.notify.release"
  | "atom.project.object"
  | "atom.transact.activate"
  | "atom.transact.reserve"
>;

export type ReleaseWorkflowProofReference = ReleaseWorkflowReference<
  "proof.installed.scenario" | "proof.qualification.channel" | "proof.transition.updater"
>;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

type SchemaInput<Schema extends z.ZodTypeAny> = DeepReadonly<z.input<Schema>>;

export type ReleaseWorkflowInputClasses = SchemaInput<typeof releaseWorkflowInputClassesSchema>;
export type ReleaseWorkflowIdentityBinding = SchemaInput<typeof releaseWorkflowIdentityBindingSchema>;
export type ReleaseWorkflowOutputDeclaration = SchemaInput<typeof releaseWorkflowOutputDeclarationSchema>;

type ReleaseWorkflowAtomShape = SchemaInput<typeof releaseWorkflowAtomDeclarationSchema>;
export type ReleaseWorkflowConfidence = ReleaseWorkflowAtomShape["confidence"];
export type ReleaseWorkflowAtomDeclaration = Omit<ReleaseWorkflowAtomShape, "dependsOn" | "executor"> & Readonly<{
  dependsOn?: readonly (ReleaseWorkflowAtomReference | ReleaseWorkflowProofReference)[];
  executor: ReleaseWorkflowExecutorReference | readonly ReleaseWorkflowExecutorReference[];
}>;

type ReleaseWorkflowProofShape = SchemaInput<typeof releaseWorkflowProofDeclarationSchema>;
export type ReleaseWorkflowProofPortability = ReleaseWorkflowProofShape["portability"];
export type ReleaseWorkflowProofDeclaration = Omit<ReleaseWorkflowProofShape, "dependsOn" | "executor"> & Readonly<{
  dependsOn: readonly ReleaseWorkflowAtomReference[];
  executor: ReleaseWorkflowExecutorReference | readonly ReleaseWorkflowExecutorReference[];
}>;

export type ReleaseWorkflowChannelPolicyDeclaration = SchemaInput<typeof releaseWorkflowChannelPolicyDeclarationBaseSchema>;
export type ReleaseWorkflowExecutorDeclaration = SchemaInput<typeof releaseWorkflowExecutorDeclarationSchema>;

type ReleaseWorkflowDesktopShape = SchemaInput<typeof releaseWorkflowDesktopDeclarationSchema>;
export type ReleaseWorkflowDesktopDeclaration = Omit<
  ReleaseWorkflowDesktopShape,
  "atoms" | "executors" | "policies" | "proofs"
> & Readonly<{
  atoms: readonly ReleaseWorkflowAtomReference[];
  executors: readonly ReleaseWorkflowExecutorReference[];
  policies: readonly ReleaseWorkflowPolicyReference[];
  proofs: readonly ReleaseWorkflowProofReference[];
}>;

export type ReleaseWorkflowFactoryOptions = SchemaInput<typeof releaseWorkflowFactoryOptionsSchema>;
export type ReleaseWorkflowManifest = DeepReadonly<z.output<typeof releaseWorkflowManifestSchema>>;
export type ReleaseWorkflowManifestDefinition = ReleaseWorkflowManifest["definitions"][number];

export type SealedReleaseWorkflow = Readonly<{
  canonical: string;
  digest: `sha256:${string}`;
  manifest: ReleaseWorkflowManifest;
}>;

export type ReleaseWorkflow = Readonly<{
  atom: Readonly<{
    attest: Readonly<{
      publication(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.attest.publication">;
    }>;
    build: Readonly<{
      closureShared(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.build.closureShared">;
      closureTarget(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.build.closureTarget">;
      shell(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.build.shell">;
    }>;
    compose: Readonly<{
      manifest(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.compose.manifest">;
    }>;
    notify: Readonly<{
      release(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.notify.release">;
    }>;
    project: Readonly<{
      object(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.project.object">;
    }>;
    transact: Readonly<{
      activate(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.transact.activate">;
      reserve(input: ReleaseWorkflowAtomDeclaration): ReleaseWorkflowReference<"atom.transact.reserve">;
    }>;
  }>;
  executor: Readonly<{
    control(input: ReleaseWorkflowExecutorDeclaration): ReleaseWorkflowReference<"executor.control">;
    mac(input: ReleaseWorkflowExecutorDeclaration): ReleaseWorkflowReference<"executor.mac">;
    windows(input: ReleaseWorkflowExecutorDeclaration): ReleaseWorkflowReference<"executor.windows">;
  }>;
  policy: Readonly<{
    channel: Readonly<{
      exact(input: ReleaseWorkflowChannelPolicyDeclaration): ReleaseWorkflowReference<"policy.channel.exact">;
      prerelease(input: ReleaseWorkflowChannelPolicyDeclaration): ReleaseWorkflowReference<"policy.channel.prerelease">;
      stable(input: ReleaseWorkflowChannelPolicyDeclaration): ReleaseWorkflowReference<"policy.channel.stable">;
    }>;
  }>;
  proof: Readonly<{
    installed: Readonly<{
      scenario(input: ReleaseWorkflowProofDeclaration): ReleaseWorkflowReference<"proof.installed.scenario">;
    }>;
    qualification: Readonly<{
      channel(input: ReleaseWorkflowProofDeclaration): ReleaseWorkflowReference<"proof.qualification.channel">;
    }>;
    transition: Readonly<{
      updater(input: ReleaseWorkflowProofDeclaration): ReleaseWorkflowReference<"proof.transition.updater">;
    }>;
  }>;
  release: Readonly<{
    desktop(input: ReleaseWorkflowDesktopDeclaration): ReleaseWorkflowReference<"release.desktop">;
  }>;
  seal(): SealedReleaseWorkflow;
}>;
