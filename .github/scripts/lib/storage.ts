import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ensure, fail } from "./control.ts";

type StorageConfig = Readonly<{
  accessKeyId: string;
  bucket: string;
  endpointUrl: string;
  region: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type Store = Readonly<{
  get(key: string): Promise<string | null>;
  putIfAbsent(key: string, value: string): Promise<Readonly<{ existing?: string; status: "created" | "exists" }>>;
}>;

function storageFromEnv(): StorageConfig | null {
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

async function signedStorageRequest(
  config: StorageConfig,
  method: "GET" | "PUT",
  key: string,
  body?: Buffer,
  immutable = false,
): Promise<Response> {
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

export function createStore(options: Readonly<{ directory?: string }>): Store {
  if (options.directory != null) {
    const directory = resolve(options.directory);
    return {
      async get(key) {
        const path = join(directory, key);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      },
      async putIfAbsent(key, value) {
        const path = join(directory, key);
        if (existsSync(path)) return { existing: readFileSync(path, "utf8"), status: "exists" };
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value, { flag: "wx" });
        return { status: "created" };
      },
    };
  }
  const config = storageFromEnv();
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
