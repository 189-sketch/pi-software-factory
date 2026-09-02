import test from "node:test";
import assert from "node:assert/strict";
import { feature77 } from "../src/feature-77.js";

test("feature77 returns success for valid input", () => {
  assert.deepEqual(feature77({ ok: true }), { state: "success", message: "done" });
});

test("feature77 returns error for invalid input", () => {
  assert.deepEqual(feature77({ ok: false }), { state: "error", message: "not ok" });
});
