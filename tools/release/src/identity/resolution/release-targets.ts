import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { resolveReleaseIdentity, resolveReleaseWorkspaceRoot } from "./resolve.ts";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const inputSchema = z.object({
  minShellVersion: z.string().min(1),
  shellProfiles: z.object({
    mac_arm64: digestSchema,
    mac_x64: digestSchema,
    win_x64: digestSchema,
  }).strict(),
}).strict();

const targets = [
  { closure: "closure.target.darwin-arm64", platform: "darwin-arm64", runner: "macos-14", shell: "shell.build.darwin-arm64", target: "mac_arm64" },
  { closure: "closure.target.darwin-x64", platform: "darwin-x64", runner: "macos-15-intel", shell: "shell.build.darwin-x64", target: "mac_x64" },
  { closure: "closure.target.win32-x64", platform: "win32-x64", runner: "windows-latest", shell: "shell.build.win32-x64", target: "win_x64" },
] as const;

export async function resolveReleaseTargetIdentities(inputValue: unknown, root?: string): Promise<Readonly<{
  buildMatrix: Readonly<{ include: readonly Readonly<{ closure_identity_digest: string; runner: string; shell_identity_digest: string; target: string }>[] }>;
  sharedClosureIdentityDigest: string;
}>> {
  const input = inputSchema.parse(inputValue);
  const workspaceRoot = resolveReleaseWorkspaceRoot(root);
  const packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as { packageManager?: unknown };
  if (typeof packageJson.packageManager !== "string") throw new Error("root packageManager is required");
  const nodeModulesAbi = process.versions.modules;
  const nodeNapi = process.versions.napi;
  if (nodeModulesAbi == null || nodeNapi == null) throw new Error("Node modules ABI and N-API versions are required");
  const common = { nodeModulesAbi, nodeNapi, nodeVersion: process.version, packageManager: packageJson.packageManager };
  const sharedClosureIdentityDigest = (await resolveReleaseIdentity({
    id: "closure.shared.build",
    parameters: { minShellVersion: input.minShellVersion, nodeVersion: common.nodeVersion, packageManager: common.packageManager },
    workspaceRoot,
  })).digest;
  const include = await Promise.all(targets.map(async (entry) => ({
    closure_identity_digest: (await resolveReleaseIdentity({
      id: entry.closure,
      parameters: { ...common, target: entry.platform },
      workspaceRoot,
    })).digest,
    runner: entry.runner,
    shell_identity_digest: (await resolveReleaseIdentity({
      id: entry.shell,
      parameters: { profileDigest: input.shellProfiles[entry.target], target: entry.platform },
      workspaceRoot,
    })).digest,
    target: entry.target,
  })));
  return Object.freeze({ buildMatrix: Object.freeze({ include: Object.freeze(include) }), sharedClosureIdentityDigest });
}

export async function resolveReleaseTargetIdentitiesCli(options: Readonly<{ input: string; output?: string; root?: string }>): Promise<void> {
  const result = await resolveReleaseTargetIdentities(JSON.parse(await readFile(resolve(options.input), "utf8")) as unknown, options.root);
  const body = JSON.stringify(result, null, 2) + "\n";
  if (options.output == null) process.stdout.write(body);
  else await writeFile(resolve(options.output), body, "utf8");
}
