import { z } from "zod";

import { releaseWorkflowPlanSchema, releaseWorkflowRequestSchema } from "./protocol.ts";

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
}).strict();

export type ReleaseWorkflowExecution = Readonly<z.output<typeof releaseWorkflowExecutionSchema>>;

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
  const sharedClosureRequiresExecution = plan.nodes.some((node) =>
    node.path === "atom.build.closureShared" && node.decision === "execute"
  );
  for (const target of request.targets) {
    const nodes = plan.nodes.filter((node) =>
      node.inputs.semantic.releaseTarget === target.name
      || node.inputs.semantic.target === target.platform
    );
    if (nodes.length === 0) throw new Error(`release plan has no platform nodes for ${target.name}`);
    (sharedClosureRequiresExecution || nodes.some(({ decision }) => decision === "execute") ? executeTargets : replayTargets).push(target.name);
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
  });
}
