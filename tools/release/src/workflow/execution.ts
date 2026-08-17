import { z } from "zod";

import {
  releaseWorkflowPlanNodeSchema,
  releaseWorkflowPlanSchema,
  releaseWorkflowRequestSchema,
} from "./protocol.ts";

const targetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);

export const releaseWorkflowExecutionSchema = z.object({
  acceptanceMatrix: z.object({
    include: z.array(z.object({
      artifact_dir: z.enum(["builder", "dmg"]),
      os: z.enum(["mac", "win"]),
      runner: z.string().min(1),
      target: targetSchema,
    }).strict()),
  }).strict(),
  attestTargets: z.array(targetSchema),
  buildMatrix: z.object({
    include: z.array(z.object({
      runner: z.string().min(1),
      target: targetSchema,
    }).strict()),
  }).strict(),
  executeTargets: z.array(targetSchema),
  replayTargets: z.array(targetSchema),
  sharedClosure: releaseWorkflowPlanNodeSchema,
  targets: z.array(z.object({
    closureTarget: releaseWorkflowPlanNodeSchema,
    proofs: z.array(releaseWorkflowPlanNodeSchema),
    shell: releaseWorkflowPlanNodeSchema,
    target: targetSchema,
  }).strict()),
}).strict();

export type ReleaseWorkflowExecution = Readonly<z.output<typeof releaseWorkflowExecutionSchema>>;
export type ReleaseWorkflowTargetExecution = ReleaseWorkflowExecution["targets"][number];

export const releaseWorkflowExecutionInputSchema = z.object({
  plan: releaseWorkflowPlanSchema,
  request: releaseWorkflowRequestSchema,
}).strict();

const runners = {
  mac_arm64: "macos-14",
  mac_x64: "macos-15-intel",
  win_x64: "windows-latest",
} as const;
const acceptance = {
  mac_arm64: { artifact_dir: "dmg", os: "mac" },
  mac_x64: { artifact_dir: "dmg", os: "mac" },
  win_x64: { artifact_dir: "builder", os: "win" },
} as const;

export function compileReleaseWorkflowExecution(planInput: unknown, requestInput: unknown): ReleaseWorkflowExecution {
  const plan = releaseWorkflowPlanSchema.parse(planInput);
  const request = releaseWorkflowRequestSchema.parse(requestInput);
  const executeTargets: Array<z.output<typeof targetSchema>> = [];
  const replayTargets: Array<z.output<typeof targetSchema>> = [];
  const acceptanceTargets: Array<z.output<typeof targetSchema>> = [];
  const attestTargets: Array<z.output<typeof targetSchema>> = [];
  const sharedClosure = plan.nodes.find((node) => node.path === "atom.build.closureShared");
  if (sharedClosure == null) throw new Error("release plan has no shared Closure node");
  const targetExecutions: ReleaseWorkflowTargetExecution[] = [];
  for (const target of request.targets) {
    const nodes = plan.nodes.filter((node) =>
      node.inputs.semantic.releaseTarget === target.name
      || node.inputs.semantic.target === target.platform
    );
    if (nodes.length === 0) throw new Error(`release plan has no platform nodes for ${target.name}`);
    (sharedClosure.decision === "execute" || nodes.some(({ decision }) => decision === "execute") ? executeTargets : replayTargets).push(target.name);
    const shell = nodes.find((node) => node.path === "atom.build.shell");
    const closureTarget = nodes.find((node) => node.path === "atom.build.closureTarget");
    const proofs = nodes.filter((node) => node.effect === "proof");
    if (shell == null) throw new Error(`release plan has no Shell node for ${target.name}`);
    if (closureTarget == null) throw new Error(`release plan has no Closure target node for ${target.name}`);
    if (proofs.length === 0) throw new Error(`release plan has no proof nodes for ${target.name}`);
    targetExecutions.push({ closureTarget, proofs, shell, target: target.name });
    const lifecycle = plan.nodes.find((node) =>
      node.effect === "proof"
      && node.inputs.semantic.releaseTarget === target.name
      && node.inputs.semantic.scenario === (target.name === "win_x64" ? "win-shell-lifecycle" : "mac-shell-lifecycle")
    );
    if (lifecycle == null) throw new Error(`release plan has no lifecycle proof for ${target.name}`);
    (lifecycle.decision === "replay" ? attestTargets : acceptanceTargets).push(target.name);
  }
  return releaseWorkflowExecutionSchema.parse({
    acceptanceMatrix: {
      include: acceptanceTargets.map((target) => ({
        ...acceptance[target],
        runner: runners[target],
        target,
      })),
    },
    attestTargets,
    buildMatrix: { include: executeTargets.map((target) => ({ runner: runners[target], target })) },
    executeTargets,
    replayTargets,
    sharedClosure,
    targets: targetExecutions,
  });
}

export function selectReleaseWorkflowTargetExecution(
  executionInput: unknown,
  targetInput: unknown,
): ReleaseWorkflowTargetExecution {
  const execution = releaseWorkflowExecutionSchema.parse(executionInput);
  const target = targetSchema.parse(targetInput);
  const selected = execution.targets.find((entry) => entry.target === target);
  if (selected == null) throw new Error(`release workflow execution does not select ${target}`);
  return selected;
}
