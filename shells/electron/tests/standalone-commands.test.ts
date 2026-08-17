import { describe, expect, it, vi } from "vitest";

import {
  STANDALONE_HANDOFF_SCHEMA_VERSION,
  STANDALONE_PROTOCOL_VERSION,
  createStandaloneHandoffEnvelope,
  type StandaloneHandle,
} from "@open-design/standalone/protocol";

import {
  OPEN_DESIGN_PREPARE_UPDATE_COMMAND,
  OPEN_DESIGN_REGISTER_DESKTOP_AUTH_COMMAND,
  createStandaloneDesktopAuthRegistration,
  createStandaloneUpdatePreparation,
} from "../src/standalone-commands.js";

const handoff = createStandaloneHandoffEnvelope({
  descriptor: {
    release: { version: "0.18.0-beta.4" },
    standalone: {
      digest: `sha256:${"b".repeat(64)}`,
      protocolVersion: STANDALONE_PROTOCOL_VERSION,
      version: "0.18.0-beta.4",
    },
  },
  scope: { channel: "beta", generation: 1, namespace: "release-beta" },
});

describe("Electron Standalone commands", () => {
  it("registers desktop auth through the generation-bound runtime handle", async () => {
    const invoke = vi.fn<StandaloneHandle["invoke"]>(async (request) => ({
      attachmentId: request.attachmentId,
      handoff,
      outcome: "completed",
      output: { accepted: true },
      requestId: request.requestId,
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    }));
    const register = createStandaloneDesktopAuthRegistration({
      attachmentId: "electron-a",
      handoff,
      handle: { invoke },
      requestId: () => "desktop-auth-1",
    });

    await expect(register(Buffer.from("secret"))).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith({
      attachmentId: "electron-a",
      command: OPEN_DESIGN_REGISTER_DESKTOP_AUTH_COMMAND,
      handoff,
      input: { secret: "c2VjcmV0" },
      requestId: "desktop-auth-1",
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    });
  });

  it("keeps unsupported runtime commands fail-closed", async () => {
    const register = createStandaloneDesktopAuthRegistration({
      attachmentId: "electron-a",
      handoff,
      handle: {
        async invoke(request) {
          return {
            attachmentId: request.attachmentId,
            handoff,
            outcome: "unsupported",
            requestId: request.requestId,
            schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
          };
        },
      },
    });

    await expect(register(Buffer.from("secret"))).resolves.toBe(false);
  });

  it("uses the protocol-owned v2 update command without a Shell-local wire dialect", async () => {
    const invoke = vi.fn<StandaloneHandle["invoke"]>(async (request) => ({
      attachmentId: request.attachmentId,
      handoff,
      outcome: "completed",
      output: {
        activationSource: "silent-policy",
        architecture: "standalone",
        releaseVersion: "0.18.0-beta.5",
        route: "closure",
        state: "prepared",
      },
      requestId: request.requestId,
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    }));
    const prepare = createStandaloneUpdatePreparation({
      attachmentId: "electron-a",
      handoff,
      handle: { invoke },
      requestId: () => "prepare-update-1",
    });

    await expect(prepare({ channel: "beta" }, { activationPolicy: "authorize-silent" }))
      .resolves.toMatchObject({ activationSource: "silent-policy", state: "prepared" });
    expect(OPEN_DESIGN_PREPARE_UPDATE_COMMAND).toBe("open-design.prepare-update.v2");
    expect(invoke).toHaveBeenCalledWith({
      attachmentId: "electron-a",
      command: "open-design.prepare-update.v2",
      handoff,
      input: {
        activationPolicy: "authorize-silent",
        metadata: { channel: "beta" },
      },
      requestId: "prepare-update-1",
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    });
  });
});
