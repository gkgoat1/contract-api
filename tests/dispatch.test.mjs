import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("dispatch files match the generator output (no drift)", () => {
  // --check exits nonzero when a committed dispatch file differs from what the
  // generator would emit from dispatch.spec.json.
  execFileSync("node", ["scripts/gen-dispatch.mjs", "--check"], { stdio: "pipe" });
});
