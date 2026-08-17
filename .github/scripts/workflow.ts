#!/usr/bin/env -S node --experimental-strip-types

import { createHash, createHmac } from "node:crypto";
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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Digest = `sha256:${string}`;
type AtomKind = "action" | "job";
type AtomMode = "normal" | "verify";

type HashPath = Readonly<{
  excludeDirectoryNames?: readonly string[];
  excludePaths?: readonly string[];
  normalizePackageVersion?: boolean;
  normalizeTextLineEndings?: boolean;
  path: string;
}>;

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
  atom: Readonly<{ definitionDigest: Digest; id: string; kind: AtomKind; schemaVersion: number }>;
  dependencies: Readonly<Record<string, Digest>>;
  digest: Digest;
  extras: Readonly<Record<string, Digest>>;
  formatVersion: 1;
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

type StorageConfig = Readonly<{
  accessKeyId: string;
  bucket: string;
  endpointUrl: string;
  prefix: string;
  region: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const EXTRA_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const CONTROL_PATHS = [
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

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function canonicalize(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value, "canonical JSON value");
  return Object.fromEntries(Object.entries(object)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertDigest(value: unknown, label: string): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail(`${label} must be a sha256 digest`);
  return value as Digest;
}

function normalizeRepoPath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (
    normalized.length === 0
    || isAbsolute(value)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) fail(`${label} must be a repository-relative path: ${value}`);
  return normalized;
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail(`${label} must not contain duplicates`);
  return Object.freeze(sorted);
}

function normalizeHashPath(input: string | HashPath, label: string): HashPath {
  const source = typeof input === "string" ? { path: input } : record(input, label) as HashPath;
  const allowed = ["excludeDirectoryNames", "excludePaths", "normalizePackageVersion", "normalizeTextLineEndings", "path"];
  const unknownKeys = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) fail(`${label} contains unknown fields: ${unknownKeys.join(", ")}`);
  for (const field of ["normalizePackageVersion", "normalizeTextLineEndings"] as const) {
    if (source[field] != null && typeof source[field] !== "boolean") fail(`${label}.${field} must be boolean`);
  }
  for (const field of ["excludeDirectoryNames", "excludePaths"] as const) {
    if (source[field] != null && (!Array.isArray(source[field]) || source[field].some((entry) => typeof entry !== "string"))) {
      fail(`${label}.${field} must be a string array`);
    }
  }
  if (typeof source.path !== "string") fail(`${label}.path must be a string`);
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
  const output = record(input, label);
  const unknownKeys = Object.keys(output).filter((key) => !["mediaType", "role", "schemaVersion"].includes(key));
  if (unknownKeys.length > 0) fail(`${label} contains unknown fields: ${unknownKeys.join(", ")}`);
  if (typeof input.role !== "string" || !EXTRA_PATTERN.test(input.role)) fail(`${label}.role is invalid`);
  if (typeof input.mediaType !== "string" || input.mediaType.length === 0) fail(`${label}.mediaType is required`);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) fail(`${label}.schemaVersion must be positive`);
  return Object.freeze({ mediaType: input.mediaType, role: input.role, schemaVersion: input.schemaVersion });
}

function normalizeDeclaration(kind: AtomKind, id: string, input: AtomDeclarationInput): AtomDeclaration {
  if (!ID_PATTERN.test(id)) fail(`atom key is invalid: ${id}`);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) fail(`${id}.schemaVersion must be positive`);
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
  const input = record(value, label);
  const allowed = ["controlPaths", "dependsOn", "extraDigests", "hashPaths", "outputs", "schemaVersion"];
  const unknownKeys = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) fail(`${label} contains unknown fields: ${unknownKeys.join(", ")}`);
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

function git(args: readonly string[], cwd: string): Buffer {
  try {
    return execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`git ${args.join(" ")} failed: ${detail}`);
  }
}

type GitEntry = Readonly<{ mode: string; object: string; path: string; type: string }>;

function listGitEntries(root: string, ref: string, source: HashPath): readonly GitEntry[] {
  const raw = git(["ls-tree", "-rz", "--full-tree", ref, "--", source.path], root);
  const entries = raw.toString("utf8").split("\0").filter(Boolean).map((line): GitEntry => {
    const tab = line.indexOf("\t");
    if (tab < 0) fail(`invalid git ls-tree entry: ${line}`);
    const [mode, type, object] = line.slice(0, tab).split(" ");
    if (mode == null || type == null || object == null) fail(`invalid git ls-tree metadata: ${line}`);
    return { mode, object, path: line.slice(tab + 1), type };
  });
  const excludedDirectories = new Set(source.excludeDirectoryNames ?? []);
  const exclusions = (source.excludePaths ?? []).map((path) => `${source.path}/${path}`);
  return entries.filter((entry) => {
    const relativePath = entry.path === source.path ? "" : entry.path.slice(source.path.length + 1);
    if (relativePath.split("/").some((segment) => excludedDirectories.has(segment))) return false;
    return !exclusions.some((excluded) => entry.path === excluded || entry.path.startsWith(`${excluded}/`));
  });
}

function normalizedBlob(root: string, entry: GitEntry, source: HashPath): Readonly<{ digest: Digest; size: number }> {
  let body = git(["cat-file", "blob", entry.object], root);
  if (source.normalizePackageVersion === true && entry.path.endsWith("/package.json") || source.normalizePackageVersion === true && entry.path === "package.json") {
    try {
      const packageJson = record(JSON.parse(body.toString("utf8")), `${entry.path} package metadata`);
      delete packageJson.version;
      body = Buffer.from(`${canonicalJson(packageJson)}\n`);
    } catch {
      // The owning validation reports malformed JSON; identity remains byte-exact.
    }
  }
  if (source.normalizeTextLineEndings === true && !body.includes(0)) {
    body = Buffer.from(body.toString("utf8").replace(/\r\n?/gu, "\n"));
  }
  return { digest: digest(body), size: body.byteLength };
}

function sourceDigest(root: string, ref: string, atom: AtomDeclaration): Digest {
  const seen = new Set<string>();
  const entries: Json[] = [];
  for (const source of atom.hashPaths) {
    const matched = listGitEntries(root, ref, source);
    if (matched.length === 0) fail(`${atom.id} hash path does not exist at ${ref}: ${source.path}`);
    for (const entry of matched) {
      if (seen.has(entry.path)) fail(`${atom.id} hash paths overlap at ${entry.path}`);
      seen.add(entry.path);
      if (entry.type === "blob") {
        const normalized = normalizedBlob(root, entry, source);
        entries.push({ kind: entry.mode === "120000" ? "symlink" : "file", mode: entry.mode, path: entry.path, ...normalized });
      } else {
        entries.push({ kind: entry.type, mode: entry.mode, object: entry.object, path: entry.path });
      }
    }
  }
  entries.sort((left, right) => String((left as Record<string, Json>).path).localeCompare(String((right as Record<string, Json>).path)));
  return digest(canonicalJson({ domain: "open-design/workflow-source/v1", entries }));
}

function definitionDigest(atom: AtomDeclaration): Digest {
  return digest(canonicalJson({ domain: "open-design/workflow-definition/v1", ...atom }));
}

function resolveExtras(atom: AtomDeclaration, input: unknown): Readonly<Record<string, Digest>> {
  const values = record(input, "extra digests");
  const actual = Object.keys(values).sort();
  if (canonicalJson(actual) !== canonicalJson(atom.extraDigests)) {
    fail(`${atom.id} extra digests must be exactly: ${atom.extraDigests.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(actual.map((name) => [name, assertDigest(values[name], `extra digest ${name}`)])));
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
  const dependencies = Object.freeze(Object.fromEntries(actualDependencies.map((id) => [id, assertDigest(options.dependencyHandles[id], `dependency ${id}`)])));
  const extras = resolveExtras(options.atom, options.extras);
  const ref = git(["rev-parse", "--verify", `${options.ref}^{commit}`], options.root).toString("utf8").trim();
  const partial = {
    atom: {
      definitionDigest: definitionDigest(options.atom),
      id: options.atom.id,
      kind: options.atom.kind,
      schemaVersion: options.atom.schemaVersion,
    },
    dependencies,
    extras,
    formatVersion: 1 as const,
    source: { digest: sourceDigest(options.root, ref, options.atom), ref },
  };
  return Object.freeze({ ...partial, digest: digest(canonicalJson({ domain: "open-design/workflow-handle/v1", ...partial })) });
}

function validateHandle(value: unknown, expected?: AtomHandle): AtomHandle {
  const input = record(value, "atom handle");
  const atom = record(input.atom, "atom handle.atom");
  const source = record(input.source, "atom handle.source");
  const handle: AtomHandle = {
    atom: {
      definitionDigest: assertDigest(atom.definitionDigest, "atom handle definitionDigest"),
      id: String(atom.id),
      kind: atom.kind === "job" ? "job" : atom.kind === "action" ? "action" : fail("atom handle kind is invalid"),
      schemaVersion: Number(atom.schemaVersion),
    },
    dependencies: Object.fromEntries(Object.entries(record(input.dependencies, "atom handle.dependencies")).map(([key, entry]) => [key, assertDigest(entry, `dependency ${key}`)])),
    digest: assertDigest(input.digest, "atom handle.digest"),
    extras: Object.fromEntries(Object.entries(record(input.extras, "atom handle.extras")).map(([key, entry]) => [key, assertDigest(entry, `extra ${key}`)])),
    formatVersion: input.formatVersion === 1 ? 1 : fail("atom handle formatVersion is invalid"),
    source: { digest: assertDigest(source.digest, "atom handle source digest"), ref: String(source.ref) },
  };
  const { digest: _digest, ...unsigned } = handle;
  if (handle.digest !== digest(canonicalJson({ domain: "open-design/workflow-handle/v1", ...unsigned }))) fail("atom handle digest is invalid");
  if (expected != null && canonicalJson(handle) !== canonicalJson(expected)) fail("atom handle does not match the sealed plan");
  return Object.freeze(handle);
}

function receiptObjectKey(prefix: string, handle: AtomHandle): string {
  return `${prefix.replace(/^\/+|\/+$/gu, "")}/receipts/v1/${handle.atom.kind}/${handle.digest.slice("sha256:".length)}.json`;
}

function quarantineObjectKey(prefix: string, handle: AtomHandle): string {
  return `${prefix.replace(/^\/+|\/+$/gu, "")}/quarantine/v1/${handle.digest.slice("sha256:".length)}.json`;
}

function parseReceipt(value: unknown, expected: AtomHandle, declaration: AtomDeclaration): AtomReceipt {
  const input = record(value, "receipt");
  const handle = validateHandle(input.handle, expected);
  if (input.status !== "success") fail("receipt status must be success");
  if (!Array.isArray(input.outputs)) fail("receipt outputs must be an array");
  const outputs = input.outputs.map((raw, index): ReceiptOutput => {
    const output = record(raw, `receipt.outputs[${index}]`);
    return {
      digest: assertDigest(output.digest, `receipt.outputs[${index}].digest`),
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
  const provenance = record(input.provenance, "receipt.provenance");
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

function storageFromEnv(prefixOverride?: string): StorageConfig | null {
  const required = [
    "RELEASE_STORAGE_ACCESS_KEY_ID", "RELEASE_STORAGE_BUCKET", "RELEASE_STORAGE_ENDPOINT",
    "RELEASE_STORAGE_SECRET_ACCESS_KEY",
  ] as const;
  if (required.every((name) => process.env[name] == null || process.env[name] === "")) return null;
  for (const name of required) if (!process.env[name]) fail(`${name} is required for workflow receipt storage`);
  return {
    accessKeyId: process.env.RELEASE_STORAGE_ACCESS_KEY_ID!,
    bucket: process.env.RELEASE_STORAGE_BUCKET!,
    endpointUrl: process.env.RELEASE_STORAGE_ENDPOINT!,
    prefix: prefixOverride ?? process.env.WORKFLOW_RECEIPT_PREFIX ?? "workflow",
    region: process.env.RELEASE_STORAGE_REGION || "auto",
    secretAccessKey: process.env.RELEASE_STORAGE_SECRET_ACCESS_KEY!,
    ...(process.env.RELEASE_STORAGE_SESSION_TOKEN ? { sessionToken: process.env.RELEASE_STORAGE_SESSION_TOKEN } : {}),
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hashHex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function storageObjectUrl(config: StorageConfig, key: string): Readonly<{ canonicalUri: string; url: URL }> {
  const endpoint = new URL(config.endpointUrl.replace(/\/+$/u, ""));
  const endpointPath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/u, "");
  const objectPath = [config.bucket, ...key.split("/")].map(encodePathSegment).join("/");
  const canonicalUri = `${endpointPath}/${objectPath}`;
  const url = new URL(endpoint.toString());
  url.pathname = canonicalUri;
  return { canonicalUri, url };
}

async function signedStorageRequest(config: StorageConfig, method: "GET" | "PUT", key: string, body?: Buffer, immutable = false): Promise<Response> {
  const payloadHash = hashHex(body ?? "");
  const { canonicalUri, url } = storageObjectUrl(config, key);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = now.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": now,
    ...(method === "PUT" ? { "cache-control": "public, max-age=31536000, immutable", "content-type": "application/json; charset=utf-8" } : {}),
    ...(immutable ? { "if-none-match": "*" } : {}),
    ...(config.sessionToken ? { "x-amz-security-token": config.sessionToken } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaderNames.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", now, scope, hashHex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
  return await fetch(url, { body: body?.toString("utf8"), headers, method });
}

type Store = Readonly<{
  get(key: string): Promise<string | null>;
  putIfAbsent(key: string, value: string): Promise<Readonly<{ existing?: string; status: "created" | "exists" }>>;
}>;

function createStore(options: Readonly<{ directory?: string; prefix?: string }>): Store {
  if (options.directory != null) {
    const directory = resolve(options.directory);
    return {
      async get(key) {
        const path = join(directory, key);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      },
      async putIfAbsent(key, value) {
        const path = join(directory, key);
        if (existsSync(path)) {
          return { existing: readFileSync(path, "utf8"), status: "exists" };
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value, { flag: "wx" });
        return { status: "created" };
      },
    };
  }
  const config = storageFromEnv(options.prefix);
  if (config == null) fail("workflow receipt storage is not configured; pass --store-dir or RELEASE_STORAGE_* variables");
  return {
    async get(key) {
      const response = await signedStorageRequest(config, "GET", key);
      if (response.status === 404) return null;
      const text = await response.text();
      if (!response.ok) fail(`GET workflow receipt failed with HTTP ${response.status}: ${text}`);
      return text;
    },
    async putIfAbsent(key, value) {
      const response = await signedStorageRequest(config, "PUT", key, Buffer.from(value), true);
      const text = await response.text();
      if (response.ok) return { status: "created" };
      if (response.status !== 412) fail(`PUT workflow receipt failed with HTTP ${response.status}: ${text}`);
      const existing = await this.get(key);
      if (existing == null) fail(`workflow receipt disappeared after immutable conflict: ${key}`);
      return { existing, status: "exists" };
    },
  };
}

function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (error) {
    fail(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function option(args: readonly string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) fail(`${name} is required`);
    return undefined;
  }
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function parseDependencies(path: string | undefined): Readonly<Record<string, Digest>> {
  if (path == null) return {};
  const input = record(parseJsonFile(path, "dependency handles"), "dependency handles");
  return Object.fromEntries(Object.entries(input).map(([id, value]) => [id, assertDigest(value, `dependency ${id}`)]));
}

function writeJson(path: string | undefined, value: unknown): void {
  const body = `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  if (path == null || path === "-") process.stdout.write(body);
  else {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), body);
  }
}

async function resolvePlan(args: readonly string[]): Promise<void> {
  const root = resolve(option(args, "--root", false) ?? process.cwd());
  const atom = selectedAtom(createWorkflow(root), args);
  const ref = option(args, "--ref", false) ?? "HEAD";
  const modeValue = option(args, "--mode", false) ?? "normal";
  if (modeValue !== "normal" && modeValue !== "verify") fail("--mode must be normal or verify");
  const handle = createHandle({
    atom,
    dependencyHandles: parseDependencies(option(args, "--dependencies", false)),
    extras: parseJsonFile(option(args, "--extras")!, "extra digests"),
    ref,
    root,
  });
  const store = createStore({ directory: option(args, "--store-dir", false), prefix: option(args, "--prefix", false) });
  const prefix = option(args, "--prefix", false) ?? process.env.WORKFLOW_RECEIPT_PREFIX ?? "workflow";
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
    reason: modeValue === "verify" ? "verify" : quarantined != null ? "quarantined" : receipt == null ? "receipt-miss" : "receipt-hit",
    ...(receipt == null ? {} : { receipt }),
  };
  const outputPrefix = option(args, "--github-output-prefix", false);
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
  writeJson(option(args, "--output", false), plan);
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

async function commitReceipt(args: readonly string[]): Promise<void> {
  const planInput = record(parseJsonFile(option(args, "--plan")!, "atom plan"), "atom plan");
  if (planInput.decision !== "execute") fail("only an executed atom can commit a receipt");
  const handle = validateHandle(planInput.handle);
  const root = resolve(option(args, "--root", false) ?? process.cwd());
  const workflow = createWorkflow(root);
  const atom = handle.atom.kind === "action" ? workflow.action(handle.atom.id) : workflow.job(handle.atom.id);
  if (handle.atom.definitionDigest !== definitionDigest(atom)) fail("plan uses a non-authoritative atom definition");
  const trustedRef = option(args, "--trusted-ref", false);
  if (trustedRef != null) validateControlPlane(root, atom, handle.source.ref, trustedRef);
  const result = record(parseJsonFile(option(args, "--result")!, "atom result"), "atom result");
  const rawOutputs = record(result.outputs, "atom result.outputs");
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
  const store = createStore({ directory: option(args, "--store-dir", false), prefix: option(args, "--prefix", false) });
  const prefix = option(args, "--prefix", false) ?? process.env.WORKFLOW_RECEIPT_PREFIX ?? "workflow";
  const stored = await store.putIfAbsent(receiptObjectKey(prefix, handle), `${JSON.stringify(canonicalize(receipt), null, 2)}\n`);
  if (stored.existing != null) {
    const existing = parseReceipt(JSON.parse(stored.existing), handle, atom);
    const outputIdentity = (value: AtomReceipt) => value.outputs.map(({ digest: outputDigest, mediaType, role, schemaVersion }) => ({
      digest: outputDigest, mediaType, role, schemaVersion,
    }));
    if (canonicalJson(outputIdentity(existing)) !== canonicalJson(outputIdentity(receipt))) {
      fail(`immutable workflow receipt output conflicts: ${handle.digest}`);
    }
  }
  writeJson(option(args, "--output", false), { handleDigest: handle.digest, status: stored.status === "created" ? "created" : "reused" });
}

function describe(args: readonly string[]): void {
  const root = resolve(option(args, "--root", false) ?? process.cwd());
  const workflow = createWorkflow(root);
  const action = option(args, "--action", false);
  const job = option(args, "--job", false);
  writeJson(
    option(args, "--output", false),
    action != null || job != null
      ? selectedAtom(workflow, args)
      : { actions: workflow.actions(), jobs: workflow.jobs() },
  );
}

function selectedAtom(workflow: ReturnType<typeof createWorkflow>, args: readonly string[]): AtomDeclaration {
  const action = option(args, "--action", false);
  const job = option(args, "--job", false);
  if ((action == null) === (job == null)) fail("pass exactly one of --action <key> or --job <key>");
  return action == null ? workflow.job(job!) : workflow.action(action);
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
    mkdirSync(join(root, ".github", "scripts"), { recursive: true });
    writeFileSync(join(root, ".github", "scripts", "workflow.ts"), "controller-v1\n");
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
    const resolveArgs = [
      "--action", "probe.action", "--extras", extrasPath, "--ref", "HEAD", "--root", root,
      "--store-dir", cliStore, "--prefix", "self-check",
    ];
    await resolvePlan([...resolveArgs, "--output", planPath]);
    if (record(parseJsonFile(planPath, "cold plan"), "cold plan").decision !== "execute") fail("cold CLI resolve did not execute");
    await commitReceipt(["--plan", planPath, "--result", resultPath, "--root", root, "--store-dir", cliStore, "--prefix", "self-check", "--output", commitPath]);
    await resolvePlan([...resolveArgs, "--output", warmPath]);
    const warm = record(parseJsonFile(warmPath, "warm plan"), "warm plan");
    if (warm.decision !== "replay" || warm.reason !== "receipt-hit") fail("warm CLI resolve did not replay the receipt");
    await resolvePlan([...resolveArgs, "--mode", "verify", "--output", verifyPath]);
    const verify = record(parseJsonFile(verifyPath, "verify plan"), "verify plan");
    if (verify.decision !== "execute" || verify.reason !== "verify") fail("verify mode did not force execution");

    writeFileSync(join(root, ".github", "scripts", "workflow.ts"), "controller-v2\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "control change"], { cwd: root });
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
  node --experimental-strip-types .github/scripts/workflow.ts describe [--action <key> | --job <key>] [--root <path>] [--output <path>]
  node --experimental-strip-types .github/scripts/workflow.ts resolve (--action <key> | --job <key>) --extras <json> [--dependencies <json>] [--ref <git-ref>] [--root <path>] [--mode normal|verify] [--store-dir <path>] [--prefix <key>] [--github-output-prefix <name>] [--output <path>]
  node --experimental-strip-types .github/scripts/workflow.ts commit --plan <json> --result <json> [--trusted-ref <git-ref>] [--root <path>] [--store-dir <path>] [--prefix <key>] [--output <path>]
`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command == null || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "self-check") return await selfCheck();
  if (command === "describe") return describe(args);
  if (command === "resolve") return await resolvePlan(args);
  if (command === "commit") return await commitReceipt(args);
  fail(`unknown workflow command: ${command}\n${usage()}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
