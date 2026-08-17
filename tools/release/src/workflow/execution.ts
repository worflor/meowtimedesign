import { z } from "zod";

import { releaseWorkflowPlanSchema, releaseWorkflowRequestSchema } from "./protocol.ts";

const targetSchema = z.enum(["mac_arm64", "mac_x64", "win_x64"]);

export const releaseWorkflowExecutionSchema = z.object({
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

export function compileReleaseWorkflowExecution(planInput: unknown, requestInput: unknown): ReleaseWorkflowExecution {
  const plan = releaseWorkflowPlanSchema.parse(planInput);
  const request = releaseWorkflowRequestSchema.parse(requestInput);
  const executeTargets: Array<z.output<typeof targetSchema>> = [];
  const replayTargets: Array<z.output<typeof targetSchema>> = [];
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
  }
  return releaseWorkflowExecutionSchema.parse({
    buildMatrix: { include: executeTargets.map((target) => ({ runner: runners[target], target })) },
    executeTargets,
    replayTargets,
  });
}
