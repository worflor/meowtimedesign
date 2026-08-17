#!/usr/bin/env -S node --experimental-strip-types

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { command, commands, ensure, fail, Options, switchBy } from "./lib/control.ts";
import { git, gitPathSetDigest, type GitHashPath } from "./lib/git.ts";
import { canonicalize, canonicalJson, digest, DIGEST_PATTERN, type Digest, type Json } from "./lib/json.ts";
import { createStore } from "./lib/storage.ts";

type AtomKind = "action" | "job";
type AtomMode = "normal" | "verify";

type HashPath = GitHashPath;

type OutputDeclaration = Readonly<{
  mediaType: string;
  role: string;
  schemaVersion: number;
}>;

type AtomDeclaration = Readonly<{
  controlPaths: readonly string[];
  dependsOn: readonly string[];
  extraDigests: readonly string[];
  hashPaths: readonly HashPath[];
  id: string;
  kind: AtomKind;
  outputs: readonly OutputDeclaration[];
  schemaVersion: number;
}>;

type AtomDeclarationInput = Omit<AtomDeclaration, "hashPaths" | "id" | "kind"> & Readonly<{
  hashPaths: readonly (string | HashPath)[];
}>;

type AtomHandle = Readonly<{
  atom: Readonly<{ controlDigest: Digest; definitionDigest: Digest; id: string; kind: AtomKind; schemaVersion: number }>;
  dependencies: Readonly<Record<string, Digest>>;
  digest: Digest;
  extras: Readonly<Record<string, Digest>>;
  formatVersion: 2;
  source: Readonly<{ digest: Digest; ref: string }>;
}>;

type ReceiptOutput = OutputDeclaration & Readonly<{
  digest: Digest;
  value: Json;
}>;

type AtomReceipt = Readonly<{
  handle: AtomHandle;
  outputs: readonly ReceiptOutput[];
  provenance: Readonly<{
    actor: string;
    commit: string;
    event: string;
    repository: string;
    runAttempt: number;
    runId: string;
    workflow: string;
  }>;
  recordedAt: string;
  status: "success";
}>

type AtomPlan = Readonly<{
  decision: "execute" | "replay";
  handle: AtomHandle;
  mode: AtomMode;
  reason: "quarantined" | "receipt-hit" | "receipt-miss" | "verify";
  receipt?: AtomReceipt;
}>;

const ID_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const EXTRA_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const CONTROL_PATHS = [
  ".github/scripts/lib",
  ".github/scripts/workflow.ts",
] as const;
const DEFAULT_EXCLUDED_DIRECTORIES = [
  ".next",
  ".od",
  ".tmp",
  "__tests__",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test",
  "tests",
] as const;

function normalizeRepoPath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (
    normalized.length === 0
    || isAbsolute(value)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) throw new Error(`${label} must be a repository-relative path: ${value}`);
  return normalized;
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort();
  ensure.that(new Set(sorted).size === sorted.length, `${label} must not contain duplicates`);
  return Object.freeze(sorted);
}

function normalizeHashPath(input: string | HashPath, label: string): HashPath {
  const source = typeof input === "string" ? { path: input } : ensure.record(input, label) as HashPath;
  const allowed = ["excludeDirectoryNames", "excludePaths", "normalizePackageVersion", "normalizeTextLineEndings", "path"];
  const unknownKeys = Object.keys(source).filter((key) => !allowed.includes(key));
  ensure.that(unknownKeys.length === 0, `${label} contains unknown fields: ${unknownKeys.join(", ")}`);
  for (const field of ["normalizePackageVersion", "normalizeTextLineEndings"] as const) {
    ensure.that(source[field] == null || typeof source[field] === "boolean", `${label}.${field} must be boolean`);
  }
  for (const field of ["excludeDirectoryNames", "excludePaths"] as const) {
    if (source[field] != null && (!Array.isArray(source[field]) || source[field].some((entry) => typeof entry !== "string"))) {
      throw new Error(`${label}.${field} must be a string array`);
    }
  }
  ensure.that(typeof source.path === "string", `${label}.path must be a string`);
  const path = normalizeRepoPath(source.path, `${label}.path`);
  const excludePaths = uniqueSorted((source.excludePaths ?? []).map((entry) => normalizeRepoPath(entry, `${label}.excludePaths`)), `${label}.excludePaths`);
  const excludeDirectoryNames = uniqueSorted(source.excludeDirectoryNames ?? DEFAULT_EXCLUDED_DIRECTORIES, `${label}.excludeDirectoryNames`);
  return Object.freeze({
    ...(excludeDirectoryNames.length === 0 ? {} : { excludeDirectoryNames }),
    ...(excludePaths.length === 0 ? {} : { excludePaths }),
    ...(source.normalizePackageVersion === true ? { normalizePackageVersion: true } : {}),
    ...(source.normalizeTextLineEndings === true ? { normalizeTextLineEndings: true } : {}),
    path,
  });
}

function normalizeOutput(input: OutputDeclaration, label: string): OutputDeclaration {
  const output = ensure.record(input, label);
  const unknownKeys = Object.keys(output).filter((key) => !["mediaType", "role", "schemaVersion"].includes(key));
  ensure.that(unknownKeys.length === 0, `${label} contains unknown fields: ${unknownKeys.join(", ")}`);
  ensure.that(typeof input.role === "string" && EXTRA_PATTERN.test(input.role), `${label}.role is invalid`);
  ensure.text(input.mediaType, `${label}.mediaType`);
  ensure.integer(input.schemaVersion, `${label}.schemaVersion`);
  return Object.freeze({ mediaType: input.mediaType, role: input.role, schemaVersion: input.schemaVersion });
}

function normalizeDeclaration(kind: AtomKind, id: string, input: AtomDeclarationInput): AtomDeclaration {
  ensure.that(ID_PATTERN.test(id), `atom key is invalid: ${id}`);
  ensure.integer(input.schemaVersion, `${id}.schemaVersion`);
  const extraDigests = uniqueSorted(input.extraDigests, `${id}.extraDigests`);
  if (extraDigests.some((name) => !EXTRA_PATTERN.test(name))) fail(`${id}.extraDigests contains an invalid name`);
  const dependsOn = uniqueSorted(input.dependsOn, `${id}.dependsOn`);
  if (dependsOn.some((name) => !EXTRA_PATTERN.test(name))) fail(`${id}.dependsOn contains an invalid slot name`);
  const outputs = [...input.outputs].map((output, index) => normalizeOutput(output, `${id}.outputs[${index}]`))
    .sort((left, right) => left.role.localeCompare(right.role));
  if (new Set(outputs.map(({ role }) => role)).size !== outputs.length) fail(`${id}.outputs contains duplicate roles`);
  const declarationPath = `.github/workflow/${kind}/${id}.json`;
  const declaration = Object.freeze({
    controlPaths: uniqueSorted(
      [...CONTROL_PATHS, declarationPath, ...input.controlPaths].map((path) => normalizeRepoPath(path, `${id}.controlPaths`)),
      `${id}.controlPaths`,
    ),
    dependsOn,
    extraDigests,
    hashPaths: Object.freeze(input.hashPaths.map((path, index) => normalizeHashPath(path, `${id}.hashPaths[${index}]`))
      .sort((left, right) => left.path.localeCompare(right.path))),
    id,
    kind,
    outputs: Object.freeze(outputs),
    schemaVersion: input.schemaVersion,
  }) satisfies AtomDeclaration;
  if (declaration.hashPaths.length === 0) fail(`${id}.hashPaths must not be empty`);
  return declaration;
}

function declarationInput(value: unknown, label: string): AtomDeclarationInput {
  const input = ensure.record(value, label);
  const allowed = ["controlPaths", "dependsOn", "extraDigests", "hashPaths", "outputs", "schemaVersion"];
  ensure.exactKeys(input, allowed, label);
  const strings = (field: string): string[] => {
    const raw = input[field];
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) fail(`${label}.${field} must be a string array`);
    return raw as string[];
  };
  if (!Array.isArray(input.hashPaths)) fail(`${label}.hashPaths must be an array`);
  if (!Array.isArray(input.outputs)) fail(`${label}.outputs must be an array`);
  return {
    controlPaths: strings("controlPaths"),
    dependsOn: strings("dependsOn"),
    extraDigests: strings("extraDigests"),
    hashPaths: input.hashPaths as Array<string | HashPath>,
    outputs: input.outputs as OutputDeclaration[],
    schemaVersion: Number(input.schemaVersion),
  };
}

function createWorkflow(root: string) {
  const workspaceRoot = resolve(root);
  function load(kind: AtomKind, key: string): AtomDeclaration {
    if (!ID_PATTERN.test(key)) fail(`atom key is invalid: ${key}`);
    const path = join(workspaceRoot, ".github", "workflow", kind, `${key}.json`);
    if (!existsSync(path)) fail(`unknown workflow ${kind} key: ${key}`);
    return normalizeDeclaration(kind, key, declarationInput(parseJsonFile(path, `${kind} ${key}`), `${kind} ${key}`));
  }
  function keys(kind: AtomKind): string[] {
    const directory = join(workspaceRoot, ".github", "workflow", kind);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
  }
  return Object.freeze({
    action: (key: string) => load("action", key),
    actions: () => keys("action"),
    job: (key: string) => load("job", key),
    jobs: () => keys("job"),
  });
}

function sourceDigest(root: string, ref: string, atom: AtomDeclaration): Digest {
  return gitPathSetDigest(root, ref, atom.hashPaths, {
    domain: "open-design/workflow-source/v2",
    label: `${atom.id} hash`,
  });
}

function controlDigest(root: string, ref: string, atom: AtomDeclaration): Digest {
  return gitPathSetDigest(root, ref, atom.controlPaths.map((path) => ({ excludeDirectoryNames: [], path })), {
    domain: "open-design/workflow-control/v2",
    label: `${atom.id} control`,
  });
}

function definitionDigest(atom: AtomDeclaration): Digest {
  return digest(canonicalJson({ domain: "open-design/workflow-definition/v1", ...atom }));
}

function resolveExtras(atom: AtomDeclaration, input: unknown): Readonly<Record<string, Digest>> {
  const values = ensure.record(input, "extra digests");
  const actual = Object.keys(values).sort();
  if (canonicalJson(actual) !== canonicalJson(atom.extraDigests)) {
    fail(`${atom.id} extra digests must be exactly: ${atom.extraDigests.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(actual.map((name) => {
    const value = values[name];
    return [name, typeof value === "string" && DIGEST_PATTERN.test(value)
      ? value as Digest
      : digest(canonicalJson({ domain: "open-design/workflow-extra/v1", name, value: canonicalize(value) }))];
  })));
}

function extrasFromEnv(atom: AtomDeclaration, prefix: string): Record<string, string> {
  ensure.that(/^[A-Z][A-Z0-9_]*_$/u.test(prefix), "--extras-env-prefix must be an uppercase environment prefix ending in _");
  return Object.fromEntries(atom.extraDigests.map((name) => {
    const suffix = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
    const envName = `${prefix}${suffix}`;
    return [name, process.env[envName] ?? ensure.never(`${envName} is required by ${atom.id}`)];
  }));
}

function createHandle(options: Readonly<{
  atom: AtomDeclaration;
  dependencyHandles: Readonly<Record<string, Digest>>;
  extras: unknown;
  ref: string;
  root: string;
}>): AtomHandle {
  const expectedDependencies = options.atom.dependsOn;
  const actualDependencies = Object.keys(options.dependencyHandles).sort();
  if (canonicalJson(actualDependencies) !== canonicalJson(expectedDependencies)) {
    fail(`${options.atom.id} dependency handles must be exactly: ${expectedDependencies.join(", ")}`);
  }
  const dependencies = Object.freeze(Object.fromEntries(actualDependencies.map((id) => [id, ensure.digest(options.dependencyHandles[id], `dependency ${id}`)])));
  const extras = resolveExtras(options.atom, options.extras);
  const ref = git(["rev-parse", "--verify", `${options.ref}^{commit}`], options.root).toString("utf8").trim();
  const partial = {
    atom: {
      controlDigest: controlDigest(options.root, ref, options.atom),
      definitionDigest: definitionDigest(options.atom),
      id: options.atom.id,
      kind: options.atom.kind,
      schemaVersion: options.atom.schemaVersion,
    },
    dependencies,
    extras,
    formatVersion: 2 as const,
    source: { digest: sourceDigest(options.root, ref, options.atom), ref },
  };
  return Object.freeze({ ...partial, digest: digest(canonicalJson({ domain: "open-design/workflow-handle/v2", ...partial })) });
}

function validateHandle(value: unknown, expected?: AtomHandle): AtomHandle {
  const input = ensure.record(value, "atom handle");
  const atom = ensure.record(input.atom, "atom handle.atom");
  const source = ensure.record(input.source, "atom handle.source");
  const handle: AtomHandle = {
    atom: {
      controlDigest: ensure.digest(atom.controlDigest, "atom handle controlDigest"),
      definitionDigest: ensure.digest(atom.definitionDigest, "atom handle definitionDigest"),
      id: String(atom.id),
      kind: atom.kind === "job" ? "job" : atom.kind === "action" ? "action" : fail("atom handle kind is invalid"),
      schemaVersion: Number(atom.schemaVersion),
    },
    dependencies: Object.fromEntries(Object.entries(ensure.record(input.dependencies, "atom handle.dependencies")).map(([key, entry]) => [key, ensure.digest(entry, `dependency ${key}`)])),
    digest: ensure.digest(input.digest, "atom handle.digest"),
    extras: Object.fromEntries(Object.entries(ensure.record(input.extras, "atom handle.extras")).map(([key, entry]) => [key, ensure.digest(entry, `extra ${key}`)])),
    formatVersion: input.formatVersion === 2 ? 2 : fail("atom handle formatVersion is invalid"),
    source: { digest: ensure.digest(source.digest, "atom handle source digest"), ref: String(source.ref) },
  };
  const { digest: _digest, ...unsigned } = handle;
  if (handle.digest !== digest(canonicalJson({ domain: "open-design/workflow-handle/v2", ...unsigned }))) fail("atom handle digest is invalid");
  if (expected != null && canonicalJson(handle) !== canonicalJson(expected)) fail("atom handle does not match the sealed plan");
  return Object.freeze(handle);
}

function receiptObjectKey(prefix: string, handle: AtomHandle): string {
  return `${prefix.replace(/^\/+|\/+$/gu, "")}/receipts/v2/${handle.atom.kind}/${handle.digest.slice("sha256:".length)}.json`;
}

function quarantineObjectKey(prefix: string, handle: AtomHandle): string {
  return `${prefix.replace(/^\/+|\/+$/gu, "")}/quarantine/v2/${handle.digest.slice("sha256:".length)}.json`;
}

function parseReceipt(value: unknown, expected: AtomHandle, declaration: AtomDeclaration): AtomReceipt {
  const input = ensure.record(value, "receipt");
  const handle = validateHandle(input.handle, expected);
  if (input.status !== "success") fail("receipt status must be success");
  const outputs = ensure.array(input.outputs, "receipt outputs").map((raw, index): ReceiptOutput => {
    const output = ensure.record(raw, `receipt.outputs[${index}]`);
    return {
      digest: ensure.digest(output.digest, `receipt.outputs[${index}].digest`),
      mediaType: String(output.mediaType),
      role: String(output.role),
      schemaVersion: Number(output.schemaVersion),
      value: canonicalize(output.value),
    };
  }).sort((left, right) => left.role.localeCompare(right.role));
  const outputContract = outputs.map(({ mediaType, role, schemaVersion }) => ({ mediaType, role, schemaVersion }));
  if (canonicalJson(outputContract) !== canonicalJson(declaration.outputs)) fail("receipt output contract does not match the atom declaration");
  for (const output of outputs) {
    if (output.digest !== digest(canonicalJson(output.value))) fail(`receipt output ${output.role} digest is invalid`);
  }
  const provenance = ensure.record(input.provenance, "receipt.provenance");
  return Object.freeze({
    handle,
    outputs: Object.freeze(outputs),
    provenance: {
      actor: String(provenance.actor), commit: String(provenance.commit), event: String(provenance.event),
      repository: String(provenance.repository), runAttempt: Number(provenance.runAttempt), runId: String(provenance.runId),
      workflow: String(provenance.workflow),
    },
    recordedAt: String(input.recordedAt),
    status: "success",
  });
}

function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (error) {
    fail(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseDependencies(path: string | undefined): Readonly<Record<string, Digest>> {
  if (path == null) return {};
  const input = ensure.record(parseJsonFile(path, "dependency handles"), "dependency handles");
  return Object.fromEntries(Object.entries(input).map(([id, value]) => [id, ensure.digest(value, `dependency ${id}`)]));
}

function writeJson(path: string | undefined, value: unknown): void {
  const body = `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  if (path == null || path === "-") process.stdout.write(body);
  else {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), body);
  }
}

async function resolvePlan(args: Options): Promise<void> {
  const root = resolve(args.optional("root") ?? process.cwd());
  const atom = selectedAtom(createWorkflow(root), args);
  const ref = args.optional("ref") ?? "HEAD";
  const rawMode = args.optional("mode") ?? "normal";
  const modeValue: AtomMode = rawMode === "normal" || rawMode === "verify"
    ? rawMode
    : ensure.never("--mode must be normal or verify");
  const extrasPath = args.optional("extras");
  const extrasEnvPrefix = args.optional("extras-env-prefix");
  ensure.that((extrasPath == null) !== (extrasEnvPrefix == null), "pass exactly one of --extras or --extras-env-prefix");
  const handle = createHandle({
    atom,
    dependencyHandles: parseDependencies(args.optional("dependencies")),
    extras: extrasPath == null ? extrasFromEnv(atom, extrasEnvPrefix!) : parseJsonFile(extrasPath, "extra digests"),
    ref,
    root,
  });
  const store = createStore({ directory: args.optional("store-dir") });
  const prefix = args.optional("prefix") ?? process.env.WORKFLOW_RECEIPT_PREFIX ?? "workflow";
  const quarantined = await store.get(quarantineObjectKey(prefix, handle));
  const receiptText = quarantined == null && modeValue === "normal" ? await store.get(receiptObjectKey(prefix, handle)) : null;
  let receipt: AtomReceipt | undefined;
  if (receiptText != null) {
    try {
      receipt = parseReceipt(JSON.parse(receiptText), handle, atom);
    } catch (error) {
      process.stderr.write(`::warning title=workflow receipt rejected::${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const plan: AtomPlan = {
    decision: receipt == null ? "execute" : "replay",
    handle,
    mode: modeValue,
    reason: switchBy<AtomMode, AtomPlan["reason"]>(modeValue, {
      normal: () => quarantined != null ? "quarantined" : receipt == null ? "receipt-miss" : "receipt-hit",
      verify: () => "verify",
    }),
    ...(receipt == null ? {} : { receipt }),
  };
  const outputPrefix = args.optional("github-output-prefix");
  if (outputPrefix != null) {
    if (!/^[a-z][a-z0-9_]*$/u.test(outputPrefix)) fail("--github-output-prefix is invalid");
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput == null || githubOutput.length === 0) fail("GITHUB_OUTPUT is required with --github-output-prefix");
    appendFileSync(githubOutput, [
      `${outputPrefix}_decision=${plan.decision}`,
      `${outputPrefix}_handle=${plan.handle.digest}`,
      `${outputPrefix}_reason=${plan.reason}`,
      "",
    ].join("\n"));
  }
  writeJson(args.optional("output"), plan);
}

function provenanceFromEnv(handle: AtomHandle): AtomReceipt["provenance"] {
  const number = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  if (!Number.isSafeInteger(number) || number < 1) fail("GITHUB_RUN_ATTEMPT must be a positive integer");
  return {
    actor: process.env.GITHUB_ACTOR ?? "local",
    commit: handle.source.ref,
    event: process.env.GITHUB_EVENT_NAME ?? "local",
    repository: process.env.GITHUB_REPOSITORY ?? "local",
    runAttempt: number,
    runId: process.env.GITHUB_RUN_ID ?? "local",
    workflow: process.env.GITHUB_WORKFLOW ?? "local",
  };
}

function validateControlPlane(root: string, atom: AtomDeclaration, executedRef: string, trustedRef: string): void {
  const executed = git(["rev-parse", "--verify", `${executedRef}^{commit}`], root).toString("utf8").trim();
  const trusted = git(["rev-parse", "--verify", `${trustedRef}^{commit}`], root).toString("utf8").trim();
  for (const path of atom.controlPaths) {
    const executedObject = git(["rev-parse", `${executed}:${path}`], root).toString("utf8").trim();
    const trustedObject = git(["rev-parse", `${trusted}:${path}`], root).toString("utf8").trim();
    if (executedObject !== trustedObject) fail(`control plane changed at ${path}; refusing a formal receipt`);
  }
}

async function commitReceipt(args: Options): Promise<void> {
  const planInput = ensure.record(parseJsonFile(args.get("plan"), "atom plan"), "atom plan");
  if (planInput.decision !== "execute") fail("only an executed atom can commit a receipt");
  const handle = validateHandle(planInput.handle);
  const root = resolve(args.optional("root") ?? process.cwd());
  const workflow = createWorkflow(root);
  const atom = switchBy(handle.atom.kind, {
    action: () => workflow.action(handle.atom.id),
    job: () => workflow.job(handle.atom.id),
  });
  if (handle.atom.definitionDigest !== definitionDigest(atom)) fail("plan uses a non-authoritative atom definition");
  const recomputed = createHandle({
    atom,
    dependencyHandles: handle.dependencies,
    extras: handle.extras,
    ref: handle.source.ref,
    root,
  });
  validateHandle(handle, recomputed);
  const trustedRef = args.optional("trusted-ref");
  if (trustedRef != null) validateControlPlane(root, atom, handle.source.ref, trustedRef);
  const trustedAncestor = args.optional("require-ancestor-of");
  if (trustedAncestor != null) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", handle.source.ref, trustedAncestor], { cwd: root, stdio: "ignore" });
    } catch {
      fail(`${handle.source.ref} is not contained by trusted ref ${trustedAncestor}; refusing a formal receipt`);
    }
  }
  const result = ensure.record(parseJsonFile(args.get("result"), "atom result"), "atom result");
  const rawOutputs = ensure.record(result.outputs, "atom result.outputs");
  const roles = Object.keys(rawOutputs).sort();
  if (canonicalJson(roles) !== canonicalJson(atom.outputs.map(({ role }) => role))) {
    fail(`atom result outputs must be exactly: ${atom.outputs.map(({ role }) => role).join(", ")}`);
  }
  const outputs = atom.outputs.map((contract): ReceiptOutput => {
    const value = canonicalize(rawOutputs[contract.role]);
    return { ...contract, digest: digest(canonicalJson(value)), value };
  });
  const receipt: AtomReceipt = {
    handle,
    outputs,
    provenance: provenanceFromEnv(handle),
    recordedAt: new Date().toISOString(),
    status: "success",
  };
  const store = createStore({ directory: args.optional("store-dir") });
  const prefix = args.optional("prefix") ?? process.env.WORKFLOW_RECEIPT_PREFIX ?? "workflow";
  if (planInput.mode === "verify") {
    const auditKey = `${prefix.replace(/^\/+|\/+$/gu, "")}/audits/v2/${handle.digest.slice("sha256:".length)}/${receipt.provenance.runId}-${receipt.provenance.runAttempt}.json`;
    const audit = await store.putIfAbsent(auditKey, `${JSON.stringify(canonicalize(receipt), null, 2)}\n`);
    if (audit.existing != null && audit.existing !== `${JSON.stringify(canonicalize(receipt), null, 2)}\n`) {
      fail(`immutable workflow verification audit conflicts: ${auditKey}`);
    }
    writeJson(args.optional("output"), { handleDigest: handle.digest, status: "audited" });
    return;
  }
  if (planInput.mode !== "normal") fail("atom plan mode must be normal or verify");
  const stored = await store.putIfAbsent(receiptObjectKey(prefix, handle), `${JSON.stringify(canonicalize(receipt), null, 2)}\n`);
  if (stored.existing != null) {
    const existing = parseReceipt(JSON.parse(stored.existing), handle, atom);
    const outputIdentity = (value: AtomReceipt) => value.outputs.map(({ digest: outputDigest, mediaType, role, schemaVersion }) => ({
      digest: outputDigest, mediaType, role, schemaVersion,
    }));
    if (canonicalJson(outputIdentity(existing)) !== canonicalJson(outputIdentity(receipt))) {
      process.stdout.write(`::notice title=Workflow receipt CAS reused::${handle.atom.kind} ${handle.atom.id} already has canonical outputs for ${handle.digest}\n`);
    }
  }
  writeJson(args.optional("output"), { handleDigest: handle.digest, status: stored.status === "created" ? "created" : "reused" });
}

function replayPlan(args: Options): void {
  const plan = ensure.record(parseJsonFile(args.get("plan"), "atom plan"), "atom plan");
  if (plan.decision !== "replay") fail("only a replay plan can materialize outputs");
  const handle = validateHandle(plan.handle);
  const root = resolve(args.optional("root") ?? process.cwd());
  const workflow = createWorkflow(root);
  const atom = switchBy(handle.atom.kind, {
    action: () => workflow.action(handle.atom.id),
    job: () => workflow.job(handle.atom.id),
  });
  if (handle.atom.definitionDigest !== definitionDigest(atom)) fail("replay plan uses a non-authoritative atom definition");
  const receipt = parseReceipt(plan.receipt, handle, atom);
  const outputRoot = resolve(args.get("output-root"));
  mkdirSync(outputRoot, { recursive: true });
  for (const output of receipt.outputs) {
    writeFileSync(join(outputRoot, `${output.role}.json`), `${JSON.stringify(canonicalize(output.value), null, 2)}\n`, { flag: "wx" });
  }
}

function captureResult(args: Options): void {
  const plan = ensure.record(parseJsonFile(args.get("plan"), "atom plan"), "atom plan");
  ensure.that(plan.decision === "execute", "only an execute plan can capture outputs");
  const handle = validateHandle(plan.handle);
  const root = resolve(args.optional("root") ?? process.cwd());
  const workflow = createWorkflow(root);
  const atom = switchBy(handle.atom.kind, {
    action: () => workflow.action(handle.atom.id),
    job: () => workflow.job(handle.atom.id),
  });
  ensure.that(handle.atom.definitionDigest === definitionDigest(atom), "capture plan uses a non-authoritative atom definition");
  const inputRoot = resolve(args.get("input-root"));
  const outputs = Object.fromEntries(atom.outputs.map(({ role }) => [role, parseJsonFile(join(inputRoot, `${role}.json`), `atom output ${role}`)]));
  writeJson(args.get("output"), { outputs });
}

function receiptRequests(root: string): Array<Readonly<{ plan: string; result: string }>> {
  const requests: Array<Readonly<{ plan: string; result: string }>> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "plan.json") {
        const result = join(directory, "result.json");
        if (existsSync(result)) requests.push({ plan: path, result });
      }
    }
  };
  if (existsSync(root)) visit(root);
  return requests.sort((left, right) => left.plan.localeCompare(right.plan));
}

async function finalizeRun(args: Options): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? ensure.never("GITHUB_REPOSITORY is required");
  const token = process.env.GITHUB_TOKEN ?? ensure.never("GITHUB_TOKEN is required");
  const runId = args.get("run-id");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  ensure.that(response.ok, `GitHub artifact discovery failed with HTTP ${response.status}`);
  const payload = ensure.record(await response.json(), "GitHub artifacts response");
  const artifacts = ensure.array(payload.artifacts, "GitHub artifacts").map((value, index) => {
    const artifact = ensure.record(value, `GitHub artifact ${index}`);
    return { expired: artifact.expired === true, id: String(artifact.id), name: String(artifact.name) };
  }).filter(({ expired, name }) => !expired && name.startsWith("workflow-receipt-"));
  if (artifacts.length === 0) return;

  const temporary = mkdtempSync(join(tmpdir(), "open-design-workflow-finalize-"));
  try {
    for (const artifact of artifacts) {
      const archive = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      });
      ensure.that(archive.ok, `GitHub artifact ${artifact.name} download failed with HTTP ${archive.status}`);
      const archivePath = join(temporary, `${artifact.id}.zip`);
      const outputRoot = join(temporary, artifact.id);
      writeFileSync(archivePath, Buffer.from(await archive.arrayBuffer()));
      mkdirSync(outputRoot, { recursive: true });
      const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
        .split("\n").filter(Boolean);
      for (const entry of archiveEntries) {
        const normalized = entry.replaceAll("\\", "/");
        ensure.that(
          !isAbsolute(entry) && normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"),
          `GitHub artifact ${artifact.name} contains an unsafe path: ${entry}`,
        );
      }
      execFileSync("unzip", ["-q", archivePath, "-d", outputRoot]);
    }
    const requests = receiptRequests(temporary);
    ensure.that(requests.length === artifacts.length, `expected ${artifacts.length} receipt requests, found ${requests.length}`);
    const root = resolve(args.optional("root") ?? process.cwd());
    const trustedRef = args.get("trusted-ref");
    const workflow = createWorkflow(root);
    for (const [index, request] of requests.entries()) {
      const plan = ensure.record(parseJsonFile(request.plan, "receipt request plan"), "receipt request plan");
      const handle = validateHandle(plan.handle);
      let trustedSource = true;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", handle.source.ref, trustedRef], { cwd: root, stdio: "ignore" });
      } catch {
        trustedSource = false;
      }
      if (!trustedSource) {
        process.stdout.write(`::notice title=Workflow receipt not finalized::${handle.atom.kind} ${handle.atom.id} source is outside the trusted ref\n`);
        continue;
      }
      const trustedKeys = handle.atom.kind === "action" ? workflow.actions() : workflow.jobs();
      if (!trustedKeys.includes(handle.atom.id)) {
        process.stdout.write(`::notice title=Workflow receipt not finalized::${handle.atom.kind} ${handle.atom.id} is not declared by the trusted control plane\n`);
        continue;
      }
      const atom = switchBy(handle.atom.kind, {
        action: () => workflow.action(handle.atom.id),
        job: () => workflow.job(handle.atom.id),
      });
      const trustedControl = controlDigest(root, trustedRef, atom);
      if (handle.atom.definitionDigest !== definitionDigest(atom) || handle.atom.controlDigest !== trustedControl) {
        process.stdout.write(`::notice title=Workflow receipt not finalized::${handle.atom.kind} ${handle.atom.id} was produced outside the current trusted control plane\n`);
        continue;
      }
      await commitReceipt(new Options({
        output: join(temporary, `commit-${index}.json`),
        plan: request.plan,
        prefix: args.optional("prefix") ?? "workflow",
        "require-ancestor-of": trustedRef,
        result: request.result,
        root,
        "trusted-ref": trustedRef,
      }));
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function describe(args: Options): void {
  const root = resolve(args.optional("root") ?? process.cwd());
  const workflow = createWorkflow(root);
  const action = args.optional("action");
  const job = args.optional("job");
  writeJson(
    args.optional("output"),
    action != null || job != null
      ? selectedAtom(workflow, args)
      : { actions: workflow.actions(), jobs: workflow.jobs() },
  );
}

function selectedAtom(workflow: ReturnType<typeof createWorkflow>, args: Options): AtomDeclaration {
  const action = args.optional("action");
  const job = args.optional("job");
  if ((action == null) === (job == null)) fail("pass exactly one of --action <key> or --job <key>");
  return switchBy(action == null ? "job" as const : "action" as const, {
    action: () => workflow.action(action!),
    job: () => workflow.job(job!),
  });
}

function initRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "workflow-self-check@open-design.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "workflow self-check"], { cwd: root });
}

async function selfCheck(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "open-design-workflow-"));
  try {
    initRepo(root);
    mkdirSync(join(root, ".github", "scripts", "lib"), { recursive: true });
    writeFileSync(join(root, ".github", "scripts", "workflow.ts"), "controller-v1\n");
    writeFileSync(join(root, ".github", "scripts", "lib", "control.ts"), "library-v1\n");
    writeFileSync(join(root, "source.txt"), "source-v1\r\n");
    writeFileSync(join(root, "package.json"), '{"name":"probe","version":"1.0.0"}\n');
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    mkdirSync(join(root, ".github", "workflow", "action"), { recursive: true });
    mkdirSync(join(root, ".github", "workflow", "job"), { recursive: true });
    writeFileSync(join(root, ".github", "workflow", "action", "probe.action.json"), JSON.stringify({
      controlPaths: [], dependsOn: [], extraDigests: ["runtime"],
      hashPaths: [{ path: "source.txt", normalizeTextLineEndings: true }, { path: "package.json", normalizePackageVersion: true }],
      outputs: [{ mediaType: "application/json", role: "proof", schemaVersion: 1 }], schemaVersion: 1,
    }));
    writeFileSync(join(root, ".github", "workflow", "job", "probe.job.json"), JSON.stringify({
      controlPaths: [], dependsOn: ["action"], extraDigests: ["runtime"], hashPaths: ["source.txt"],
      outputs: [{ mediaType: "application/json", role: "proof", schemaVersion: 1 }], schemaVersion: 1,
    }));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "declarations"], { cwd: root });
    const self = createWorkflow(root);
    const runtime = digest("node24");
    const action = self.action("probe.action");
    const first = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime }, ref: "HEAD", root });
    const repeated = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime }, ref: "HEAD", root });
    if (canonicalJson(first) !== canonicalJson(repeated)) fail("same atom inputs did not produce the same sealed handle");

    writeFileSync(join(root, "package.json"), '{"name":"probe","version":"2.0.0"}\n');
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "version only"], { cwd: root });
    const normalized = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime }, ref: "HEAD", root });
    if (first.source.digest !== normalized.source.digest) fail("normalized package version changed the source digest");

    writeFileSync(join(root, "source.txt"), "source-v2\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "source change"], { cwd: root });
    const changed = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime }, ref: "HEAD", root });
    if (first.digest === changed.digest) fail("source change did not invalidate the handle");
    const differentExtra = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime: digest("node25") }, ref: "HEAD", root });
    if (changed.digest === differentExtra.digest) fail("extra digest change did not invalidate the handle");

    const job = createHandle({ atom: self.job("probe.job"), dependencyHandles: { action: changed.digest }, extras: { runtime }, ref: "HEAD", root });
    const changedChild = createHandle({ atom: self.job("probe.job"), dependencyHandles: { action: differentExtra.digest }, extras: { runtime }, ref: "HEAD", root });
    if (job.digest === changedChild.digest) fail("child handle change did not invalidate the job handle");

    const store = createStore({ directory: join(root, "store") });
    const outputValue = canonicalize({ ok: true });
    const receipt: AtomReceipt = {
      handle: changed,
      outputs: [{ ...action.outputs[0]!, digest: digest(canonicalJson(outputValue)), value: outputValue }],
      provenance: { actor: "self-check", commit: changed.source.ref, event: "self-check", repository: "local", runAttempt: 1, runId: "1", workflow: "self-check" },
      recordedAt: "2026-01-01T00:00:00.000Z",
      status: "success",
    };
    const key = receiptObjectKey("probe", changed);
    const body = `${JSON.stringify(canonicalize(receipt), null, 2)}\n`;
    if ((await store.putIfAbsent(key, body)).status !== "created") fail("first immutable receipt write was not created");
    if ((await store.putIfAbsent(key, body)).status !== "exists") fail("same immutable receipt was not reused");
    parseReceipt(JSON.parse((await store.get(key))!), changed, action);
    const tampered = JSON.parse(body) as Record<string, unknown>;
    ((tampered.outputs as Array<Record<string, unknown>>)[0]!).value = { ok: false };
    let rejected = false;
    try { parseReceipt(tampered, changed, action); } catch { rejected = true; }
    if (!rejected) fail("tampered receipt output was accepted");

    const extrasPath = join(root, "extras.json");
    const planPath = join(root, "plan.json");
    const resultPath = join(root, "result.json");
    const commitPath = join(root, "commit.json");
    const warmPath = join(root, "warm.json");
    const verifyPath = join(root, "verify.json");
    const cliStore = join(root, "cli-store");
    writeFileSync(extrasPath, JSON.stringify({ runtime }));
    writeFileSync(resultPath, JSON.stringify({ outputs: { proof: { ok: true } } }));
    const resolveArgs = {
      action: "probe.action", extras: extrasPath, prefix: "self-check", ref: "HEAD", root, "store-dir": cliStore,
    };
    await resolvePlan(new Options({ ...resolveArgs, output: planPath }));
    if (ensure.record(parseJsonFile(planPath, "cold plan"), "cold plan").decision !== "execute") fail("cold CLI resolve did not execute");
    await commitReceipt(new Options({ output: commitPath, plan: planPath, prefix: "self-check", result: resultPath, root, "store-dir": cliStore }));
    await resolvePlan(new Options({ ...resolveArgs, output: warmPath }));
    const warm = ensure.record(parseJsonFile(warmPath, "warm plan"), "warm plan");
    if (warm.decision !== "replay" || warm.reason !== "receipt-hit") fail("warm CLI resolve did not replay the receipt");
    await resolvePlan(new Options({ ...resolveArgs, mode: "verify", output: verifyPath }));
    const verify = ensure.record(parseJsonFile(verifyPath, "verify plan"), "verify plan");
    if (verify.decision !== "execute" || verify.reason !== "verify") fail("verify mode did not force execution");

    writeFileSync(join(root, ".github", "scripts", "lib", "control.ts"), "library-v2\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "control change"], { cwd: root });
    const controlChanged = createHandle({ atom: action, dependencyHandles: {}, extras: { runtime }, ref: "HEAD", root });
    if (changed.digest === controlChanged.digest) fail("shared control library change did not invalidate the handle");
    rejected = false;
    try { validateControlPlane(root, action, "HEAD", "HEAD~1"); } catch { rejected = true; }
    if (!rejected) fail("changed control plane was allowed to mint a receipt");
    process.stdout.write("workflow self-check OK\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function usage(): string {
  return `Usage:
  node --experimental-strip-types .github/scripts/workflow.ts self-check
  node --experimental-strip-types .github/scripts/workflow.ts capture --plan <json> --input-root <path> --output <json> [--root <path>]
  node --experimental-strip-types .github/scripts/workflow.ts describe [--action <key> | --job <key>] [--root <path>] [--output <path>]
  node --experimental-strip-types .github/scripts/workflow.ts resolve (--action <key> | --job <key>) --extras <json> [--dependencies <json>] [--ref <git-ref>] [--root <path>] [--mode normal|verify] [--store-dir <path>] [--prefix <key>] [--github-output-prefix <name>] [--output <path>]
  node --experimental-strip-types .github/scripts/workflow.ts replay --plan <json> --output-root <path> [--root <path>]
  node --experimental-strip-types .github/scripts/workflow.ts commit --plan <json> --result <json> [--trusted-ref <git-ref>] [--require-ancestor-of <git-ref>] [--root <path>] [--store-dir <path>] [--prefix <key>] [--output <path>]
  node --experimental-strip-types .github/scripts/workflow.ts finalize-run --run-id <id> --trusted-ref <git-ref> [--root <path>] [--prefix <key>]
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    process.stdout.write(usage());
    return;
  }
  await commands({
    capture: command(["input-root", "output", "plan", "root"], captureResult),
    commit: command(
      ["output", "plan", "prefix", "require-ancestor-of", "result", "root", "store-dir", "trusted-ref"],
      commitReceipt,
    ),
    describe: command(["action", "job", "output", "root"], describe),
    "finalize-run": command(["prefix", "root", "run-id", "trusted-ref"], finalizeRun),
    replay: command(["output-root", "plan", "root"], replayPlan),
    resolve: command(
      ["action", "dependencies", "extras", "extras-env-prefix", "github-output-prefix", "job", "mode", "output", "prefix", "ref", "root", "store-dir"],
      resolvePlan,
    ),
    "self-check": command([], selfCheck),
  }, usage).run(argv);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
