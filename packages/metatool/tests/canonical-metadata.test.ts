import { describe, expect, it } from "vitest";

import {
  canonicalMetadataJson,
  canonicalizeMetadata,
  metadataDigest,
} from "../src/identity.ts";

describe("canonical metadata", () => {
  it("orders object keys recursively without reordering arrays", () => {
    expect(canonicalizeMetadata({ z: [{ b: 2, a: 1 }], a: true })).toEqual({
      a: true,
      z: [{ a: 1, b: 2 }],
    });
    expect(canonicalMetadataJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("provides the one digest primitive used by metadata protocols", () => {
    expect(metadataDigest(canonicalMetadataJson({ z: 1, a: 2 })))
      .toBe(metadataDigest(canonicalMetadataJson({ a: 2, z: 1 })));
    expect(metadataDigest("different")).not.toBe(metadataDigest("value"));
  });

  it("rejects undefined rather than silently dropping identity input", () => {
    expect(() => canonicalMetadataJson({ missing: undefined })).toThrow(/undefined/u);
    expect(() => canonicalMetadataJson({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalMetadataJson({ value: new Date(0) })).toThrow(/plain objects/u);
    expect(() => canonicalMetadataJson({ value: () => true })).toThrow(/function/u);
  });
});
