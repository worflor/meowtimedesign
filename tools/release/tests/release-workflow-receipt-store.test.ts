import { afterEach, describe, expect, it, vi } from "vitest";

import { registerReleaseWorkflowReceipt } from "../src/workflow/receipt-store.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const storage = {
  accessKeyId: "access",
  bucket: "releases",
  endpointUrl: "https://account.r2.cloudflarestorage.com",
  region: "auto",
  secretAccessKey: "secret",
};
const receipt = {
  definitionDigest: digest("1"),
  effect: "proof" as const,
  executionDigest: digest("2"),
  nodeId: "proof-node",
  outputs: [{ digest: digest("3"), role: "proof", schemaVersion: 1 }],
  provenance: { runId: "1" },
  recordedAt: "2026-08-17T00:00:00.000Z",
  schemaVersion: 1 as const,
  semanticDigest: digest("4"),
  status: "success" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("release workflow receipt store", () => {
  it("treats a repeated proof contract as idempotent even when evidence metadata differs", async () => {
    const existing = {
      ...receipt,
      outputs: [{ ...receipt.outputs[0], digest: digest("5"), value: { durationMs: 10 } }],
      provenance: { runId: "previous" },
      recordedAt: "2026-08-16T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response("precondition", { status: 412 })
        : new Response(JSON.stringify(existing), { headers: { etag: '"etag"' }, status: 200 }));
    await expect(registerReleaseWorkflowReceipt(storage, receipt)).resolves.toBe("reused");
  });

  it("rejects a receipt occupying the same semantic key with another contract", async () => {
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response("precondition", { status: 412 })
        : new Response(JSON.stringify({ ...receipt, nodeId: "another-node" }), { status: 200 }));
    await expect(registerReleaseWorkflowReceipt(storage, receipt)).rejects.toThrow("workflow receipt conflicts");
  });
});
