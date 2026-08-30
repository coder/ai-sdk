/**
 * Scoped workspace acquisition: the workspace is provisioned on scope open and
 * torn down (per policy) on scope close — including on interruption.
 *
 * Requires an ambient `coder` CLI login and a template to create from:
 *
 *   CODER_TEMPLATE=docker pnpm example:sandbox
 */
import * as Effect from "effect/Effect";
import { CoderWorkspace, layerWorkspace } from "../src/index.js";

const program = Effect.gen(function* () {
  const workspace = yield* CoderWorkspace;
  yield* Effect.log(
    `workspace ${workspace.name} ready (created=${workspace.created}, id=${workspace.id})`,
  );
});

program.pipe(
  Effect.provide(
    layerWorkspace({
      workspace: "effect-bridge-example",
      create: { template: process.env.CODER_TEMPLATE ?? "docker" },
      teardown: "delete-if-created",
    }),
  ),
  Effect.runPromise,
);
