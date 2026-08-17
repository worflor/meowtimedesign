import { afterEach, describe, expect, it, vi } from "vitest";

import { copyStorageObject } from "../src/storage/s3-upload.ts";

const storage = {
  accessKeyId: "access",
  bucket: "releases",
  endpointUrl: "https://account.r2.cloudflarestorage.com",
  region: "auto",
  secretAccessKey: "secret",
};

afterEach(() => vi.unstubAllGlobals());

describe("storage server-side copy", () => {
  it("signs a CopyObject request without downloading its body", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("<CopyObjectResult />", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await copyStorageObject({
      ...storage,
      cacheControl: "public, max-age=60",
      contentType: "application/zip",
      objectKey: "beta/versions/new/file.zip",
      sourceObjectKey: "beta/builds/old file.zip",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/releases/beta/versions/new/file.zip");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("x-amz-copy-source"))
      .toBe("/releases/beta/builds/old%20file.zip");
    expect(new Headers(init?.headers).get("authorization")).toContain("x-amz-copy-source");
  });

  it("rejects an S3 error returned inside HTTP 200", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }));
    await expect(copyStorageObject({
      ...storage,
      cacheControl: "public, max-age=60",
      contentType: "application/zip",
      objectKey: "target",
      sourceObjectKey: "source",
    })).rejects.toThrow("InternalError");
  });
});
