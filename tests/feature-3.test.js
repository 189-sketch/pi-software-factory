import test from "node:test";
import assert from "node:assert/strict";
import { feature3 } from "../src/feature-3.js";

test("feature3 returns success for valid input", () => {
  assert.deepEqual(feature3({ ok: true }), { state: "success", message: "done" });
});

test("feature3 returns error for invalid input", () => {
  assert.deepEqual(feature3({ ok: false }), { state: "error", message: "not ok" });
});
