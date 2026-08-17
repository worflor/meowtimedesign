import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { releaseChannelDescriptor } from "@open-design/release";
import { z } from "zod";

import { releaseCandidatePrefix, validateReleaseCandidateId } from "../candidate/identity.ts";
import { RELEASE_CANDIDATE_CACHE_CONTROL } from "../candidate/policy.ts";
import { normalizePublicUrl, publicUrl } from "../storage/common.ts";
import { assertCurrentVersionReservation, versionLockObjectKey } from "../storage/counted-version-reservation.ts";
import { rebindClosureContribution, type ClosureBuildRecord } from "../storage/closure/build-record.ts";
import { sanitizeDogfoodSegment } from "../storage/dogfood.ts";
import { shellBuildIndexObjectKey, type ShellBuildRecord } from "../storage/shell-build.ts";
import {
  copyStorageObject,
  putImmutableStorageObject,
  type StorageConfig,
} from "../storage/s3-upload.ts";
import {
  releaseWorkflowPlanSchema,
  releaseWorkflowReceiptSchema,
  releaseWorkflowRequestSchema,
  type ReleaseWorkflowReceipt,
} from "./protocol.ts";

type Target = "mac_arm64" | "mac_x64" | "win_x64";
const targetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);

export const candidateTargetProjectionInputSchema = z.object({
  candidateId: z.string().min(1),
  channel: z.string().min(1),
  publicOrigin: z.string().url(),
  receipt: releaseWorkflowReceiptSchema,
  releaseVersion: z.string().min(1),
  target: targetSchema,
}).strict();

export const replayTargetMaterializationInputSchema = z.object({
  candidateId: z.string().min(1),
  outputRoot: z.string().min(1),
  plan: releaseWorkflowPlanSchema,
  request: releaseWorkflowRequestSchema,
  target: targetSchema,
}).strict();

function shellRecord(receipt: ReleaseWorkflowReceipt): ShellBuildRecord {
  const output = receipt.outputs.find(({ role }) => role === "shellBuild");
  if (output?.value == null || typeof output.value !== "object" || Array.isArray(output.value)) {
    throw new Error("Shell workflow receipt does not carry its authoritative build record");
  }
  return output.value as ShellBuildRecord;
}

function receiptValue(receipt: ReleaseWorkflowReceipt, role: string): Record<string, unknown> {
  const output = receipt.outputs.find((entry) => entry.role === role);
  if (output?.value == null || typeof output.value !== "object" || Array.isArray(output.value)) {
    throw new Error(`workflow receipt does not carry ${role}`);
  }
  return output.value as Record<string, unknown>;
}

function expectedPlatform(target: Target): ShellBuildRecord["target"] {
  return target === "mac_arm64" ? "darwin-arm64" : target === "mac_x64" ? "darwin-x64" : "win32-x64";
}

export async function projectCandidateTargetFromShellReceipt(input: Readonly<{
  candidateId: string;
  channel: string;
  publicOrigin: string;
  receipt: unknown;
  releaseVersion: string;
  storage: StorageConfig;
  target: Target;
}>): Promise<Readonly<{
  manifestObjectKey: string;
  manifestUrl: string;
  primaryUrl: string;
}>> {
  const receipt = releaseWorkflowReceiptSchema.parse(input.receipt);
  if (receipt.effect !== "pure") throw new Error("candidate projection requires a pure Shell build receipt");
  const record = shellRecord(receipt);
  const channel = releaseChannelDescriptor(input.channel).channel;
  if (record.channel !== channel || record.target !== expectedPlatform(input.target)) {
    throw new Error("Shell workflow receipt does not match the candidate target scope");
  }
  const candidateId = validateReleaseCandidateId(input.candidateId);
  const publicOrigin = normalizePublicUrl(input.publicOrigin).replace(/\/$/u, "");
  const rootPrefix = releaseCandidatePrefix({ candidateId, channel, releaseVersion: input.releaseVersion });
  const targetPrefix = `${rootPrefix}/targets/${input.target}`;
  const kinds = input.target === "win_x64" ? ["installer", "portableZip"] : ["dmg"];
  const artifacts = kinds.flatMap((kind) => record.artifacts[kind] == null ? [] : [record.artifacts[kind]!]);
  if (artifacts.length === 0) throw new Error(`Shell build receipt has no candidate artifacts for ${input.target}`);
  const files = [];
  for (const artifact of artifacts) {
    const name = sanitizeDogfoodSegment(basename(artifact.name));
    const objectKey = `${targetPrefix}/${name}`;
    await copyStorageObject({
      ...input.storage,
      cacheControl: RELEASE_CANDIDATE_CACHE_CONTROL,
      contentType: artifact.contentType,
      objectKey,
      sourceObjectKey: artifact.objectKey,
    });
    files.push(Object.freeze({
      digest: artifact.digest,
      mediaType: artifact.contentType,
      name,
      objectKey,
      size: artifact.size,
      url: publicUrl(publicOrigin, targetPrefix, name),
    }));
  }
  const manifest = Object.freeze({
    candidateId,
    channel,
    files: Object.freeze(files),
    releaseVersion: input.releaseVersion,
    schemaVersion: 1,
    target: input.target,
  });
  const manifestObjectKey = `${targetPrefix}/manifest.json`;
  await putImmutableStorageObject({
    ...input.storage,
    body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    cacheControl: RELEASE_CANDIDATE_CACHE_CONTROL,
    contentType: "application/json; charset=utf-8",
    objectKey: manifestObjectKey,
  });
  return Object.freeze({
    manifestObjectKey,
    manifestUrl: publicUrl(publicOrigin, targetPrefix, "manifest.json"),
    primaryUrl: files[0]!.url,
  });
}

export async function materializeReplayTarget(input: Readonly<{
  candidateId: string;
  outputRoot: string;
  plan: unknown;
  request: unknown;
  storage: StorageConfig;
  target: Target;
}>): Promise<Readonly<{
  buildResultPath: string;
  closureSharedPath: string;
  closureTargetPath: string;
  platformManifestDir: string;
  platformOutputsPath: string;
  shellBuildPath: string;
}>> {
  const plan = releaseWorkflowPlanSchema.parse(input.plan);
  const request = releaseWorkflowRequestSchema.parse(input.request);
  const targetRequest = request.targets.find(({ name }) => name === input.target);
  if (targetRequest == null) throw new Error(`release request does not select ${input.target}`);
  const releaseChannel = releaseChannelDescriptor(request.release.channel).channel;
  if (releaseChannel !== "stable") {
    await assertCurrentVersionReservation(
      input.storage,
      request.release.releaseVersion,
      versionLockObjectKey(request.release.releaseVersion, releaseChannel),
      releaseChannel,
    );
  }
  const targetNodes = plan.nodes.filter((node) =>
    node.inputs.semantic.releaseTarget === input.target
    || node.inputs.semantic.target === targetRequest.platform
  );
  if (targetNodes.some(({ decision }) => decision !== "replay")) {
    throw new Error(`cannot materialize ${input.target}: its platform plan contains executable nodes`);
  }
  const shellNode = targetNodes.find(({ path }) => path === "atom.build.shell");
  if (shellNode?.receipt == null) throw new Error(`${input.target} has no replayable Shell receipt`);
  const shell = shellRecord(shellNode.receipt);
  const sharedNode = plan.nodes.find(({ path }) => path === "atom.build.closureShared");
  const closureNode = targetNodes.find(({ path }) => path === "atom.build.closureTarget");
  if (sharedNode?.receipt == null || closureNode?.receipt == null) throw new Error(`${input.target} has no replayable Closure receipts`);
  const sharedRecord = receiptValue(sharedNode.receipt, "closureSharedContribution") as unknown as ClosureBuildRecord;
  const targetRecord = receiptValue(closureNode.receipt, "closureTargetContribution") as unknown as ClosureBuildRecord;
  const publicOrigin = request.release.publicOrigin;
  const releaseVersion = request.release.releaseVersion;
  const shellBuildPath = join(input.outputRoot, "release-build", input.target, "build.json");
  const closureSharedPath = join(input.outputRoot, "release-closure", "shared", "shared-contribution.json");
  const closureTargetPath = join(input.outputRoot, "release-build", input.target, "target-contribution.json");
  const platformManifestDir = join(input.outputRoot, "release-platform-manifests");
  const platformOutputsPath = join(input.outputRoot, "release-platform-outputs", `${input.target}.json`);
  const buildResultPath = join(input.outputRoot, "release-platform-results", `${input.target}.json`);
  for (const path of [shellBuildPath, closureSharedPath, closureTargetPath, platformOutputsPath, buildResultPath]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await mkdir(join(input.outputRoot, "release-assets", input.target), { recursive: true });
  await writeFile(shellBuildPath, `${JSON.stringify({
    artifacts: Object.fromEntries(Object.entries(shell.artifacts).map(([kind, artifact]) => [kind, {
      digest: artifact.digest,
      path: "",
      size: artifact.size,
    }])),
    releaseVersion,
    resolution: {
      artifacts: shell.artifacts,
      createdAt: shell.createdAt,
      recordUrl: publicUrl(publicOrigin, "", shellBuildIndexObjectKey(shell.channel, shell.shell.type, shell.releaseDigest, shell.target)),
      state: "reused",
    },
    shell: shell.shell,
  }, null, 2)}\n`);
  await writeFile(closureSharedPath, `${JSON.stringify(rebindClosureContribution("shared", sharedRecord.contribution, {
    channel: releaseChannel,
    publicOrigin,
    version: releaseVersion,
  }), null, 2)}\n`);
  await writeFile(closureTargetPath, `${JSON.stringify(rebindClosureContribution("target", targetRecord.contribution, {
    channel: releaseChannel,
    publicOrigin,
    version: releaseVersion,
  }), null, 2)}\n`);
  const candidate = await projectCandidateTargetFromShellReceipt({
    candidateId: input.candidateId,
    channel: request.release.channel,
    publicOrigin,
    receipt: shellNode.receipt,
    releaseVersion,
    storage: input.storage,
    target: input.target,
  });
  await writeFile(buildResultPath, `${JSON.stringify({
    candidateManifestUrl: candidate.manifestUrl,
    smokeResult: "success",
    target: input.target,
    url: candidate.primaryUrl,
  }, null, 2)}\n`);
  return Object.freeze({
    buildResultPath,
    closureSharedPath,
    closureTargetPath,
    platformManifestDir,
    platformOutputsPath,
    shellBuildPath,
  });
}
