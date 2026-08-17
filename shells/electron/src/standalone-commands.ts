import { randomUUID } from "node:crypto";

import {
  STANDALONE_HANDOFF_SCHEMA_VERSION,
  STANDALONE_RUNTIME_COMMANDS,
  createStandalonePrepareUpdateCommandInput,
  validateStandaloneUpdatePreparation,
  type StandaloneHandle,
  type StandaloneHandoffEnvelope,
  type StandaloneUpdateActivationPolicy,
  type StandaloneUpdatePreparation,
} from "@open-design/standalone/protocol";

export const OPEN_DESIGN_REGISTER_DESKTOP_AUTH_COMMAND =
  STANDALONE_RUNTIME_COMMANDS.REGISTER_DESKTOP_AUTH;
export const OPEN_DESIGN_PREPARE_UPDATE_COMMAND =
  STANDALONE_RUNTIME_COMMANDS.PREPARE_UPDATE;

/** Shell-side adapter for the product command; transport stays behind StandaloneHandle. */
export function createStandaloneDesktopAuthRegistration(input: Readonly<{
  attachmentId: string;
  handoff: StandaloneHandoffEnvelope;
  handle: Pick<StandaloneHandle, "invoke">;
  requestId?: () => string;
}>): (secret: Buffer) => Promise<boolean> {
  const requestId = input.requestId ?? randomUUID;
  return async (secret) => {
    const result = await input.handle.invoke({
      attachmentId: input.attachmentId,
      command: OPEN_DESIGN_REGISTER_DESKTOP_AUTH_COMMAND,
      handoff: input.handoff,
      input: { secret: secret.toString("base64") },
      requestId: requestId(),
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    });
    return result.outcome === "completed"
      && result.output != null
      && typeof result.output === "object"
      && !Array.isArray(result.output)
      && result.output.accepted === true;
  };
}

/** Transport release metadata to Standalone without interpreting legacy fields. */
export function createStandaloneUpdatePreparation(input: Readonly<{
  attachmentId: string;
  handoff: StandaloneHandoffEnvelope;
  handle: Pick<StandaloneHandle, "invoke">;
  requestId?: () => string;
}>): (
  metadata: Record<string, unknown>,
  options: { activationPolicy: StandaloneUpdateActivationPolicy },
) => Promise<StandaloneUpdatePreparation> {
  const requestId = input.requestId ?? randomUUID;
  return async (metadata, options) => {
    const result = await input.handle.invoke({
      attachmentId: input.attachmentId,
      command: OPEN_DESIGN_PREPARE_UPDATE_COMMAND,
      handoff: input.handoff,
      input: createStandalonePrepareUpdateCommandInput(metadata, options.activationPolicy),
      requestId: requestId(),
      schemaVersion: STANDALONE_HANDOFF_SCHEMA_VERSION,
    });
    if (result.outcome !== "completed") {
      throw new Error("Standalone update preparation failed");
    }
    return validateStandaloneUpdatePreparation(result.output);
  };
}
