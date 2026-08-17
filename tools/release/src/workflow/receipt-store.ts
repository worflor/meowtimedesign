import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";
import { releaseChannelDescriptor, type ReleaseChannel } from "@open-design/release";

import {
  closureBuildPrefix,
  validateClosureBuildRecord,
} from "../storage/closure/build-record.ts";
import {
  shellBuildIndexObjectKey,
  validateShellBuildRecord,
} from "../storage/shell-build.ts";
import {
  getStorageObject,
  putStorageObjectWithStatus,
  type StorageConfig,
} from "../storage/s3-upload.ts";
import {
  releaseWorkflowReceiptSchema,
  type ReleaseWorkflowReceipt,
  type ReleaseWorkflowRequest,
} from "./protocol.ts";
import type { ReleaseWorkflowPlannerDependencies } from "./planner.ts";

type Digest = `sha256:${string}`;
type ReceiptLookup = Parameters<ReleaseWorkflowPlannerDependencies["resolveReceipt"]>[0];

type ReceiptIdentity = Readonly<{ effect: ReceiptLookup["effect"]; executionDigest: string; semanticDigest: string }>;

function receiptIdentityDigest(input: ReceiptIdentity): Digest {
  return (input.effect === "pure" || input.effect === "proof" ? input.semanticDigest : input.executionDigest) as Digest;
}

export function workflowReceiptObjectKey(input: ReceiptIdentity): string {
  const digest = receiptIdentityDigest(input);
  return `workflow/receipts/v1/${input.effect}/${digest.slice("sha256:".length)}.json`;
}

async function readCanonicalReceipt(storage: StorageConfig, input: ReceiptLookup): Promise<ReleaseWorkflowReceipt | null> {
  const object = await getStorageObject({ ...storage, objectKey: workflowReceiptObjectKey(input) });
  if (object == null) return null;
  return releaseWorkflowReceiptSchema.parse(JSON.parse(object.text) as unknown);
}

function adoptedReceipt(
  input: ReceiptLookup,
  record: Readonly<{ createdAt: string; provenance: Record<string, unknown> }>,
  source: string,
): ReleaseWorkflowReceipt {
  const recordDigest = metadataDigest(canonicalMetadataJson(record));
  return releaseWorkflowReceiptSchema.parse({
    definitionDigest: input.definitionDigest,
    effect: input.effect,
    executionDigest: input.executionDigest,
    nodeId: input.nodeId,
    outputs: input.outputs.map(({ mediaType, role, schemaVersion }) => ({
      digest: recordDigest,
      ...(mediaType == null ? {} : { mediaType }),
      role,
      schemaVersion,
      value: record,
    })),
    provenance: { ...record.provenance, adoptedFrom: source },
    recordedAt: record.createdAt,
    schemaVersion: 1,
    semanticDigest: input.semanticDigest,
    status: "success",
  });
}

async function adoptShellBuild(
  storage: StorageConfig,
  channel: ReleaseChannel,
  input: ReceiptLookup,
): Promise<ReleaseWorkflowReceipt | null> {
  if (input.path !== "atom.build.shell") return null;
  const releaseDigest = Object.values(input.identityDigests)[0];
  const target = input.inputs.semantic.target;
  const shellType = input.inputs.semantic.shellType;
  if (
    releaseDigest == null
    || (target !== "darwin-arm64" && target !== "darwin-x64" && target !== "win32-x64")
    || typeof shellType !== "string"
  ) return null;
  const objectKey = shellBuildIndexObjectKey(channel, shellType, releaseDigest, target);
  const object = await getStorageObject({ ...storage, objectKey });
  if (object == null) return null;
  try {
    const record = validateShellBuildRecord(
      JSON.parse(object.text) as unknown,
      { shell: { type: shellType } as never, target },
      channel,
      releaseDigest,
    );
    return adoptedReceipt(input, record, "shell-build-record/v5");
  } catch {
    return null;
  }
}

async function adoptClosureBuild(
  storage: StorageConfig,
  channel: ReleaseChannel,
  input: ReceiptLookup,
): Promise<ReleaseWorkflowReceipt | null> {
  if (input.path !== "atom.build.closureShared" && input.path !== "atom.build.closureTarget") return null;
  const identityDigest = Object.values(input.identityDigests)[0];
  if (identityDigest == null) return null;
  const kind = input.path === "atom.build.closureShared" ? "shared" : "target";
  const target = input.inputs.semantic.target;
  const token = kind === "shared" ? "shared" : `target-${String(target)}`;
  const objectKey = `${closureBuildPrefix(channel, token, identityDigest)}/record.json`;
  const object = await getStorageObject({ ...storage, objectKey });
  if (object == null) return null;
  try {
    const record = validateClosureBuildRecord(JSON.parse(object.text) as unknown, {
      channel,
      identityDigest,
      kind,
      token,
    });
    return adoptedReceipt(input, record, `closure-build-record/${kind}-v1`);
  } catch {
    return null;
  }
}

export function createReleaseWorkflowReceiptResolver(options: Readonly<{
  request: ReleaseWorkflowRequest;
  storage: StorageConfig;
}>): ReleaseWorkflowPlannerDependencies["resolveReceipt"] {
  const channel = releaseChannelDescriptor(options.request.release.channel).channel;
  return async (input) => {
    const canonical = await readCanonicalReceipt(options.storage, input);
    if (canonical != null) return canonical;
    return await adoptShellBuild(options.storage, channel, input)
      ?? await adoptClosureBuild(options.storage, channel, input);
  };
}

export async function registerReleaseWorkflowReceipt(
  storage: StorageConfig,
  receiptInput: unknown,
): Promise<"created" | "reused"> {
  const receipt = releaseWorkflowReceiptSchema.parse(receiptInput);
  const objectKey = workflowReceiptObjectKey(receipt);
  const result = await putStorageObjectWithStatus({
    ...storage,
    body: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    cacheControl: "public, max-age=31536000, immutable",
    contentType: "application/json; charset=utf-8",
    headers: { "if-none-match": "*" },
    objectKey,
  });
  if (result.ok) return "created";
  if (result.status !== 412) {
    throw new Error(`workflow receipt PUT ${result.url} failed with HTTP ${result.status}: ${result.body}`);
  }
  const existingObject = await getStorageObject({ ...storage, objectKey });
  if (existingObject == null) throw new Error(`workflow receipt disappeared after immutable conflict: ${objectKey}`);
  const existing = releaseWorkflowReceiptSchema.parse(JSON.parse(existingObject.text) as unknown);
  const contract = (value: ReleaseWorkflowReceipt) => canonicalMetadataJson({
    definitionDigest: value.definitionDigest,
    effect: value.effect,
    executionDigest: value.executionDigest,
    nodeId: value.nodeId,
    outputs: value.outputs.map(({ mediaType, role, schemaVersion }) => ({
      ...(mediaType == null ? {} : { mediaType }),
      role,
      schemaVersion,
    })),
    semanticDigest: value.semanticDigest,
    status: value.status,
  });
  if (contract(existing) !== contract(receipt)) throw new Error(`workflow receipt conflicts: ${objectKey}`);
  return "reused";
}
