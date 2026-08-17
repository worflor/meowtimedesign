import { isDeepStrictEqual } from "node:util";

import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";
import { z } from "zod";

import { createPublicColdStartEvidence } from "../storage/cold-start-evidence.ts";
import { normalizePublicUrl, writeJson } from "../storage/common.ts";
import {
  artifactBinding,
  assertIdentity,
  assertPublicImmutableUrl,
  childRecord,
  fetchBytes,
  parseJsonBytes,
  resolvePublicClosure,
  stringField,
  type PublicAcceptanceCredential,
  type PublicArtifactBinding,
} from "../storage/public-acceptance.ts";
import { publicAcceptanceTargets } from "../storage/public-acceptance-targets.ts";
import { sha256Digest } from "../storage/latest-publication.ts";
import { releaseWorkflowPlanSchema, releaseWorkflowRequestSchema } from "./protocol.ts";

const targetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);

export const publicAttestationInputSchema = z.object({
  credentialPath: z.string().min(1),
  metadataUrl: z.string().url(),
  mutableMetadataUrl: z.string().url(),
  plan: releaseWorkflowPlanSchema,
  request: releaseWorkflowRequestSchema,
  target: targetSchema,
}).strict();

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function assertReadable(binding: PublicArtifactBinding, label: string): Promise<void> {
  let last = "no response";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(binding.url, { method: "HEAD", redirect: "follow" });
      const length = Number(response.headers.get("content-length"));
      if (response.ok && Number.isSafeInteger(length) && length === binding.size) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      last = `HTTP ${response.status}, content-length=${response.headers.get("content-length") ?? "missing"}`;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** (attempt - 1))));
  }
  throw new Error(`${label} is not publicly readable with its declared size: ${binding.url} (${last})`);
}

export async function attestWorkflowPublicTarget(inputValue: unknown): Promise<PublicAcceptanceCredential> {
  const input = publicAttestationInputSchema.parse(inputValue);
  const targetRequest = input.request.targets.find(({ name }) => name === input.target);
  if (targetRequest == null) throw new Error(`release request does not select ${input.target}`);
  if (input.plan.workflowDigest !== input.request.workflowDigest) throw new Error("workflow plan and request digests differ");
  if (input.plan.requestDigest !== metadataDigest(canonicalMetadataJson(input.request))) {
    throw new Error("workflow plan does not bind the supplied request");
  }
  const scenario = input.target === "win_x64" ? "win-shell-lifecycle" : "mac-shell-lifecycle";
  const node = input.plan.nodes.find((entry) =>
    entry.effect === "proof"
    && entry.inputs.semantic.releaseTarget === input.target
    && entry.inputs.semantic.scenario === scenario
  );
  if (node?.decision !== "replay" || node.receipt == null) {
    throw new Error(`${input.target} has no reusable canonical lifecycle proof`);
  }
  const proofOutput = node.receipt.outputs.find(({ role }) => role === "proof");
  const proofValue = record(proofOutput?.value, `${input.target} lifecycle proof output`);
  const proofEvidence = record(proofValue.evidence, `${input.target} lifecycle proof evidence`);
  const coldStart = proofEvidence.coldStart;
  if (coldStart == null) throw new Error(`${input.target} lifecycle proof has no transferable cold-start evidence`);

  const metadataUrl = normalizePublicUrl(input.metadataUrl);
  const mutableMetadataUrl = normalizePublicUrl(input.mutableMetadataUrl);
  assertPublicImmutableUrl(metadataUrl, input.request.release.publicOrigin, "metadata URL");
  const [metadataBytes, mutableBytes] = await Promise.all([
    fetchBytes(metadataUrl, fetch),
    fetchBytes(mutableMetadataUrl, fetch),
  ]);
  const metadata = parseJsonBytes(metadataBytes, "public metadata");
  const mutable = parseJsonBytes(mutableBytes, "mutable acceptance metadata");
  if (!isDeepStrictEqual(metadata, mutable)) throw new Error("mutable acceptance metadata differs from immutable metadata");
  const embeddedPlatform = childRecord(childRecord(metadata, "releaseTargets", "metadata"), input.target, "metadata.releaseTargets");
  const platformUrl = normalizePublicUrl(stringField(childRecord(embeddedPlatform, "r2", "platform"), "versionManifestUrl", "platform.r2"));
  assertPublicImmutableUrl(platformUrl, input.request.release.publicOrigin, `${input.target} platform manifest URL`);
  const platformBytes = await fetchBytes(platformUrl, fetch);
  const platform = parseJsonBytes(platformBytes, `public ${input.target} platform manifest`);
  assertIdentity({
    commit: input.request.release.commit,
    metadata,
    platform,
    releaseVersion: input.request.release.releaseVersion,
    target: input.target,
  });
  if (!isDeepStrictEqual(embeddedPlatform, platform)) throw new Error(`combined metadata ${input.target} differs from its platform manifest`);

  const definition = publicAcceptanceTargets[input.target];
  const artifacts = childRecord(platform, "artifacts", "platform");
  const primary = artifactBinding(artifacts[definition.artifactKind], `platform.artifacts.${definition.artifactKind}`);
  const checked: Array<PublicArtifactBinding & { kind: string }> = [];
  for (const [kind, value] of Object.entries(artifacts)) {
    checked.push({ ...artifactBinding(value, `platform.artifacts.${kind}`), kind: `shell:${kind}` });
  }
  const closure = childRecord(metadata, "closure", "metadata");
  for (const [digest, value] of Object.entries(childRecord(closure, "blobs", "metadata.closure"))) {
    checked.push({ ...artifactBinding(value, `metadata.closure.blobs.${digest}`), kind: `closure:${digest}` });
  }
  await Promise.all(checked.map(async (binding) => await assertReadable(binding, binding.kind)));
  const resolvedClosure = resolvePublicClosure({
    metadata,
    publicOrigin: input.request.release.publicOrigin,
    target: input.target,
  });
  const projectionDigest = metadataDigest(canonicalMetadataJson({
    checked: checked.map(({ digest, kind, size, url }) => ({ digest, kind, size, url })),
    metadata: { digest: sha256Digest(metadataBytes), size: metadataBytes.byteLength, url: metadataUrl },
    mutableMetadataUrl,
    platform: { digest: sha256Digest(platformBytes), size: platformBytes.byteLength, url: platformUrl },
  }));
  const credential: PublicAcceptanceCredential = {
    acceptedAt: stringField(metadata, "generatedAt", "metadata"),
    artifact: primary,
    artifactKind: definition.artifactKind,
    closure: resolvedClosure.binding,
    coldStart: createPublicColdStartEvidence(resolvedClosure.coldStart, coldStart),
    commit: input.request.release.commit,
    metadata: { digest: sha256Digest(metadataBytes), size: metadataBytes.byteLength, url: metadataUrl },
    namespace: targetRequest.namespace,
    platformManifest: { digest: sha256Digest(platformBytes), size: platformBytes.byteLength, url: platformUrl },
    releaseVersion: input.request.release.releaseVersion,
    schemaVersion: 4,
    status: "accepted",
    target: input.target,
    workflowProof: {
      checkedObjects: checked.length,
      mode: "canonical-receipt-and-public-projection",
      nodeId: node.nodeId,
      projectionDigest,
      receiptDigest: proofOutput!.digest,
      semanticDigest: node.semanticDigest,
      sourceRecordedAt: node.receipt.recordedAt,
    },
  };
  writeJson(input.credentialPath, credential);
  return credential;
}
