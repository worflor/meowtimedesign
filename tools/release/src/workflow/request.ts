import { readFileSync } from "node:fs";
import { join } from "node:path";

import { releaseWorkflowRequestSchema, type ReleaseWorkflowRequest } from "./protocol.ts";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value == null || value.length === 0) throw new Error(`${name} is required to prepare a release workflow request`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = required(env, name);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function createReleaseWorkflowRequestFromEnv(options: Readonly<{
  env?: NodeJS.ProcessEnv;
  workflowDigest: string;
  workspaceRoot: string;
}>): ReleaseWorkflowRequest {
  const env = options.env ?? process.env;
  const channel = required(env, "RELEASE_CHANNEL");
  const packageJson = JSON.parse(readFileSync(join(options.workspaceRoot, "package.json"), "utf8")) as { packageManager?: unknown };
  if (typeof packageJson.packageManager !== "string") throw new Error("root package.json packageManager is required");
  const modules = process.versions.modules;
  const napi = process.versions.napi;
  if (modules == null || napi == null) throw new Error("release workflow requires Node modules ABI and N-API versions");
  return releaseWorkflowRequestSchema.parse({
    formatVersion: 1,
    provenance: {
      actor: required(env, "GITHUB_ACTOR"),
      event: required(env, "GITHUB_EVENT_NAME"),
      repository: required(env, "GITHUB_REPOSITORY"),
      runAttempt: Number(required(env, "GITHUB_RUN_ATTEMPT")),
      runId: required(env, "GITHUB_RUN_ID"),
      workflow: required(env, "GITHUB_WORKFLOW"),
    },
    release: {
      activate: boolean(env, "RELEASE_ACTIVATE"),
      channel,
      commit: required(env, "RELEASE_COMMIT"),
      minShellVersion: required(env, "RELEASE_MIN_SHELL_VERSION"),
      namespace: `release-${channel}`,
      nodeVersion: process.version,
      packageManager: packageJson.packageManager,
      profile: required(env, "RELEASE_PROFILE"),
      publicOrigin: required(env, "RELEASE_PUBLIC_ORIGIN"),
      publish: boolean(env, "RELEASE_PUBLISH"),
      releaseVersion: required(env, "RELEASE_VERSION"),
    },
    targets: [
      {
        buildTarget: "dmg",
        name: "mac_arm64",
        namespace: `release-${channel}`,
        nodeModulesAbi: modules,
        nodeNapi: napi,
        platform: "darwin-arm64",
        signMode: required(env, "RELEASE_MAC_ARM64_SIGN_MODE"),
        shellProfileDigest: required(env, "RELEASE_MAC_ARM64_SHELL_PROFILE_DIGEST"),
        smokeMatrix: "mac-shell-v3",
        standaloneProtocolVersion: 1,
      },
      {
        buildTarget: "all",
        name: "mac_x64",
        namespace: `release-${channel}-x64`,
        nodeModulesAbi: modules,
        nodeNapi: napi,
        platform: "darwin-x64",
        signMode: required(env, "RELEASE_MAC_X64_SIGN_MODE"),
        shellProfileDigest: required(env, "RELEASE_MAC_X64_SHELL_PROFILE_DIGEST"),
        smokeMatrix: "mac-shell-v2",
        standaloneProtocolVersion: 1,
      },
      {
        buildTarget: "all",
        name: "win_x64",
        namespace: `release-${channel}-win`,
        nodeModulesAbi: modules,
        nodeNapi: napi,
        platform: "win32-x64",
        signMode: required(env, "RELEASE_WIN_X64_SIGN_MODE"),
        shellProfileDigest: required(env, "RELEASE_WIN_X64_SHELL_PROFILE_DIGEST"),
        smokeMatrix: "win-shell-v2",
        standaloneProtocolVersion: 1,
      },
    ],
    workflowDigest: options.workflowDigest,
  });
}
