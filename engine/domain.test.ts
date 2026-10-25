import { test } from "node:test";
import assert from "node:assert/strict";
import { bounded, pairingCode, slotIndex } from "./domain.js";
test("only physical slots can be addressed", () => {
  for (const bad of [-1, 3, 0.5, "0", null, undefined, NaN])
    assert.throws(() => slotIndex(bad));
  assert.equal(slotIndex(2), 2);
});
test("non-finite or out-of-range light values never reach the protocol", () => {
  for (const bad of [NaN, Infinity, -1, 101, "50", null])
    assert.throws(() => bounded(bad, 1, 100));
  assert.equal(bounded(49.6, 1, 100), 50);
});
test("pairing accepts pasted manual codes and preserves QR payload separators", () => {
  assert.equal(pairingCode(" 3532-533-5079 "), "35325335079");
  assert.equal(pairingCode("MT:Y.K9042C00KA0648G00"), "MT:Y.K9042C00KA0648G00");
  for (const bad of ["", "12345", "<script>", 12345678901])
    assert.throws(() => pairingCode(bad));
});
