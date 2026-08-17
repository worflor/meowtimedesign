import { canonicalMetadataJson } from "@open-design/metatool";
import { z } from "zod";

import { releaseWorkflowDefinitionPathSchema } from "./schema.ts";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const tokenSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const releaseTargetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);
const platformSchema = z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]);
const canonicalValueSchema = z.unknown().superRefine((value, context) => {
  try {
    canonicalMetadataJson(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
  }
});

export const releaseWorkflowTargetRequestSchema = z.object({
  buildTarget: z.string().min(1),
  name: releaseTargetSchema,
  namespace: tokenSchema,
  nodeModulesAbi: z.string().min(1),
  nodeNapi: z.string().min(1),
  platform: platformSchema,
  signMode: z.string().min(1),
  shellProfileDigest: digestSchema,
  smokeMatrix: tokenSchema,
  standaloneProtocolVersion: z.number().int().positive().safe(),
}).strict();

export const releaseWorkflowRequestSchema = z.object({
  formatVersion: z.literal(1),
  provenance: z.object({
    actor: z.string().min(1),
    event: z.string().min(1),
    repository: z.string().min(1),
    runAttempt: z.number().int().positive().safe(),
    runId: z.string().min(1),
    workflow: z.string().min(1),
  }).strict(),
  release: z.object({
    activate: z.boolean(),
    channel: tokenSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    minShellVersion: z.string().min(1),
    namespace: tokenSchema,
    nodeVersion: z.string().min(1),
    packageManager: z.string().min(1),
    profile: tokenSchema,
    publicOrigin: z.string().url(),
    publish: z.boolean(),
    releaseVersion: z.string().min(1),
  }).strict(),
  targets: z.array(releaseWorkflowTargetRequestSchema).min(1),
  workflowDigest: digestSchema,
}).strict().superRefine((request, context) => {
  const names = request.targets.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "release request targets must be unique", path: ["targets"] });
  }
  const expectedPlatform = {
    mac_arm64: "darwin-arm64",
    mac_x64: "darwin-x64",
    win_x64: "win32-x64",
  } as const;
  for (const [index, target] of request.targets.entries()) {
    if (target.platform !== expectedPlatform[target.name]) {
      context.addIssue({ code: "custom", message: "release target platform does not match its name", path: ["targets", index, "platform"] });
    }
  }
  if (request.release.activate && !request.release.publish) {
    context.addIssue({ code: "custom", message: "release activation requires publication", path: ["release", "activate"] });
  }
});

export const releaseWorkflowReceiptOutputSchema = z.object({
  digest: digestSchema,
  mediaType: z.string().min(1).optional(),
  role: z.string().min(1),
  schemaVersion: z.number().int().positive().safe(),
  size: z.number().int().nonnegative().safe().optional(),
  url: z.string().url().optional(),
  value: canonicalValueSchema.optional(),
}).strict();

export const releaseWorkflowReceiptSchema = z.object({
  definitionDigest: digestSchema,
  effect: z.enum(["cas-transition", "conditional-copy", "immutable-write", "notification", "proof", "pure"]),
  executionDigest: digestSchema,
  nodeId: z.string().min(1),
  outputs: z.array(releaseWorkflowReceiptOutputSchema),
  provenance: z.record(z.string(), canonicalValueSchema),
  recordedAt: z.string().datetime(),
  schemaVersion: z.literal(1),
  semanticDigest: digestSchema,
  status: z.literal("success"),
}).strict().superRefine((receipt, context) => {
  const roles = receipt.outputs.map(({ role }) => role);
  if (new Set(roles).size !== roles.length) {
    context.addIssue({ code: "custom", message: "receipt output roles must be unique", path: ["outputs"] });
  }
});

export const releaseWorkflowPlanNodeSchema = z.object({
  decision: z.enum(["execute", "replay"]),
  definitionDigest: digestSchema,
  dependencies: z.array(z.string().min(1)),
  effect: z.enum(["cas-transition", "conditional-copy", "immutable-write", "notification", "proof", "pure"]),
  executionDigest: digestSchema,
  executorIds: z.array(z.string().min(1)).min(1),
  gate: z.enum(["activate", "always", "counted", "publish"]),
  identityDigests: z.record(z.string().min(1), digestSchema),
  inputs: z.object({
    audit: z.record(z.string(), canonicalValueSchema),
    materialization: z.record(z.string(), canonicalValueSchema),
    operational: z.record(z.string(), canonicalValueSchema),
    semantic: z.record(z.string(), canonicalValueSchema),
  }).strict(),
  nodeId: z.string().min(1),
  outputs: z.array(z.object({
    mediaType: z.string().min(1).optional(),
    role: z.string().min(1),
    schemaVersion: z.number().int().positive().safe(),
  }).strict()).min(1),
  path: releaseWorkflowDefinitionPathSchema,
  reason: z.enum(["receipt-hit", "receipt-miss", "receipt-rejected", "side-effect-required"]),
  receipt: releaseWorkflowReceiptSchema.optional(),
  semanticDigest: digestSchema,
}).strict().superRefine((node, context) => {
  if (node.decision === "replay" && node.receipt == null) {
    context.addIssue({ code: "custom", message: "replayed plan node requires a receipt", path: ["receipt"] });
  }
  if (node.decision === "execute" && node.receipt != null) {
    context.addIssue({ code: "custom", message: "executed plan node cannot carry a receipt", path: ["receipt"] });
  }
});

export const releaseWorkflowPlanSchema = z.object({
  formatVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  nodes: z.array(releaseWorkflowPlanNodeSchema),
  policy: z.object({
    activate: z.boolean(),
    counted: z.boolean(),
    path: z.enum(["policy.channel.exact", "policy.channel.prerelease", "policy.channel.stable"]),
    publish: z.boolean(),
  }).strict(),
  requestDigest: digestSchema,
  schemaVersion: z.literal(1),
  workflowDigest: digestSchema,
}).strict().superRefine((plan, context) => {
  const ids = plan.nodes.map(({ nodeId }) => nodeId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "plan node ids must be unique", path: ["nodes"] });
  }
  const known = new Set(ids);
  for (const [index, node] of plan.nodes.entries()) {
    for (const dependency of node.dependencies) {
      if (!known.has(dependency)) {
        context.addIssue({ code: "custom", message: `plan node references unknown dependency: ${dependency}`, path: ["nodes", index, "dependencies"] });
      }
    }
  }
});

export type ReleaseWorkflowRequest = Readonly<z.output<typeof releaseWorkflowRequestSchema>>;
export type ReleaseWorkflowReceipt = Readonly<z.output<typeof releaseWorkflowReceiptSchema>>;
export type ReleaseWorkflowPlan = Readonly<z.output<typeof releaseWorkflowPlanSchema>>;
export type ReleaseWorkflowPlanNode = Readonly<z.output<typeof releaseWorkflowPlanNodeSchema>>;
