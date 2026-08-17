import { canonicalMetadataJson, metadataDigest } from "@open-design/metatool";
import { z } from "zod";

import { githubInfo } from "../storage/common.ts";
import type { StorageConfig } from "../storage/s3-upload.ts";
import { releaseWorkflowPlanSchema } from "./protocol.ts";
import { registerReleaseWorkflowReceipt } from "./receipt-store.ts";

export const scenarioReceiptRegistrationInputSchema = z.object({
  plan: releaseWorkflowPlanSchema,
  summary: z.unknown(),
  target: z.enum(["mac_arm64", "mac_x64", "win_x64"]),
}).strict();

function timingEvidence(summary: unknown, scenario: string): Record<string, unknown> {
  if (summary == null || typeof summary !== "object" || Array.isArray(summary)) throw new Error("Shell smoke summary must be an object");
  const timings = (summary as Record<string, unknown>).timings;
  if (!Array.isArray(timings)) throw new Error("Shell smoke summary timings are required");
  const timing = timings.find((entry) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record.step === scenario && record.status === "success";
  });
  if (timing == null || typeof timing !== "object" || Array.isArray(timing)) {
    throw new Error(`Shell smoke summary has no successful scenario: ${scenario}`);
  }
  return timing as Record<string, unknown>;
}

export async function registerScenarioReceipts(input: Readonly<{
  plan: unknown;
  registerReceipt?: typeof registerReleaseWorkflowReceipt;
  storage: StorageConfig;
  summary: unknown;
  target: "mac_arm64" | "mac_x64" | "win_x64";
}>): Promise<readonly string[]> {
  const plan = releaseWorkflowPlanSchema.parse(input.plan);
  const registerReceipt = input.registerReceipt ?? registerReleaseWorkflowReceipt;
  const nodes = plan.nodes.filter((node) =>
    node.effect === "proof"
    && node.decision === "execute"
    && node.inputs.semantic.releaseTarget === input.target
  );
  const registered: string[] = [];
  for (const node of nodes) {
    const scenario = node.inputs.semantic.scenario;
    if (typeof scenario !== "string") throw new Error(`proof node ${node.nodeId} has no scenario binding`);
    const evidence = timingEvidence(input.summary, scenario);
    const evidenceDigest = metadataDigest(canonicalMetadataJson({ evidence, scenario }));
    await registerReceipt(input.storage, {
      definitionDigest: node.definitionDigest,
      effect: node.effect,
      executionDigest: node.executionDigest,
      nodeId: node.nodeId,
      outputs: node.outputs.map(({ mediaType, role, schemaVersion }) => ({
        digest: evidenceDigest,
        ...(mediaType == null ? {} : { mediaType }),
        role,
        schemaVersion,
        value: { evidence, scenario },
      })),
      provenance: githubInfo(),
      recordedAt: new Date().toISOString(),
      schemaVersion: 1,
      semanticDigest: node.semanticDigest,
      status: "success",
    });
    registered.push(node.nodeId);
  }
  return Object.freeze(registered);
}
