import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestQueue } from "../shared/latest-queue.js";
import { hexToHsv, hsvToHex, hsvToXy, xyToHsv } from "../shared/colors.js";
test("a blocked bulb cannot delay a different bulb; obsolete slider values are coalesced", async () => {
  const queue = new LatestQueue(),
    sent: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = queue.run(0, "brightness", async () => {
    sent.push(0);
    await gate;
    return 0;
  });
  const updates = Array.from({ length: 30 }, (_, i) =>
    queue.run(0, "brightness", async () => {
      sent.push(i + 1);
      return i + 1;
    }),
  );
  assert.equal(await queue.run(1, "power", async () => true), true);
  release();
  await first;
  assert.deepEqual(await Promise.all(updates), Array(30).fill(30));
  assert.deepEqual(sent, [0, 30]);
});
test("the newest ordering wins across controls, and an error does not wedge a lamp", async () => {
  const queue = new LatestQueue(),
    order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const active = queue.run(0, "color", async () => {
    await gate;
  });
  const color = queue.run(0, "color", async () => {
    order.push("old");
  });
  const off = queue.run(0, "power", async () => {
    order.push("off");
  });
  const newer = queue.run(0, "color", async () => {
    order.push("new");
  });
  release();
  await Promise.all([active, color, off, newer]);
  assert.deepEqual(order, ["off", "new"]);
  await assert.rejects(
    queue.run(0, "color", async () => {
      throw Error("network");
    }),
  );
  assert.equal(await queue.run(0, "power", async () => true), true);
});
test("RGB/HSV round trips keep value and saturation; black and invalid hex are handled", () => {
  for (const hex of [
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffffff",
    "#000000",
    "#53ab8d",
    "#8040f0",
  ]) {
    const hsv = hexToHsv(hex);
    assert.equal(hsvToHex(hsv.hue, hsv.saturation, hsv.brightness), hex);
  }
  assert.equal(hsvToHex(360, 100), "#ff0000");
  assert.throws(() => hexToHsv("#wat"));
  for (const hue of [0, 60, 120, 180, 240, 300]) {
    const xy = hsvToXy(hue, 80),
      hsv = xyToHsv(xy.x, xy.y);
    assert.ok(
      Math.min(Math.abs(hsv.hue - hue), 360 - Math.abs(hsv.hue - hue)) < 2,
    );
    assert.ok(Math.abs(hsv.saturation - 80) < 2);
  }
});
