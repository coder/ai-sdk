import { describe, expect, it } from "vitest";
import * as agent from "../../src/index.js";

/**
 * Every name the entry point's type surface advertises as a VALUE must be
 * defined at runtime. A runtime const re-exported only through
 * `export type * from "./coder/types.js"` typechecks for consumers but is
 * `undefined` at runtime (issue #56: `TERMINAL_STATUSES`).
 *
 * `keyof typeof agent` covers every advertised value export — including
 * values leaked type-only by `export type *` (pure types are excluded) — so
 * this record fails to typecheck when the list drifts from the public
 * surface, and the runtime loop fails when an advertised value never ships.
 */
const DECLARED_VALUE_EXPORTS: Record<keyof typeof agent, true> = {
  CHAT_ATTACHMENT_MEDIA_TYPES: true,
  chatMessagesToUIMessages: true,
  classifyTurnAction: true,
  CODER_PROVIDER_OPTIONS: true,
  CoderAgent: true,
  CoderAgentError: true,
  CoderApiError: true,
  CoderChatClient: true,
  CoderChatError: true,
  CoderLanguageModel: true,
  CoderStreamError: true,
  dataContentToFileContent: true,
  dynamicToolNames: true,
  extractSystemPrompt: true,
  MAX_CHAT_FILE_SIZE_BYTES: true,
  resolveFileContent: true,
  streamChatEvents: true,
  TERMINAL_STATUSES: true,
  toolsToDynamicTools: true,
  TurnTranslator: true,
  userContentToInputParts: true,
  watchChatEvents: true,
};

// Widened view for computed lookups: the point is probing names that may be
// missing from the runtime namespace object.
const runtimeExports: Record<string, unknown> = agent;

describe("entry point exports", () => {
  it("defines every value the public types advertise at runtime", () => {
    for (const name of Object.keys(DECLARED_VALUE_EXPORTS)) {
      expect(runtimeExports[name], `export "${name}"`).toBeDefined();
    }
  });

  it("exports the TERMINAL_STATUSES set (#56)", () => {
    expect(agent.TERMINAL_STATUSES).toBeInstanceOf(Set);
    expect([...agent.TERMINAL_STATUSES].sort()).toEqual([
      "completed",
      "error",
      "requires_action",
      "waiting",
    ]);
  });
});
