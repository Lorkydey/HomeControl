import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalRgb, type RgbTransport } from "./rgb.js";

function fixture() {
  const commands: Record<string, unknown>[] = [];
  let fail = false;
  const transport: RgbTransport = {
    async request(message) {
      commands.push(message);
      if (fail) throw new Error("SDK disconnected");
      return message.method === "discover"
        ? {
            keyboard: "Test keyboard",
            pc: [{ name: "Mainboard", leds: 2 }],
            warnings: [],
          }
        : true;
    },
    async close() {},
  };
  return {
    rgb: new LocalRgb(transport),
    commands,
    disconnect: () => {
      fail = true;
    },
    reconnect: () => {
      fail = false;
    },
  };
}

test("RGB discovery is read-only, unknown hardware state stays unknown, and slots keep their identities", async () => {
  const { rgb, commands } = fixture();
  assert.equal(rgb.snapshot("logitech", 3, "Keyboard").online, false);
  await rgb.discover();
  assert.deepEqual(commands, [{ method: "discover" }]);
  const state = rgb.snapshot("logitech", 3, "Keyboard");
  assert.equal(state.on, null);
  assert.equal(state.brightness, null);
  assert.equal(state.paired, true);
  assert.equal(state.online, true);
  assert.equal(state.tunable, false);
  await rgb.execute("logitech", "color", 3, "Keyboard", {
    hue: 240,
    saturation: 100,
    brightness: 40,
  });
  assert.deepEqual(commands.at(-1), {
    method: "set",
    source: "logitech",
    rgb: [0, 0, 102],
  });
  assert.equal(rgb.snapshot("aura", 4, "PC").on, null);
  assert.equal(rgb.snapshot("logitech", 1, "Renamed").index, 1);
  assert.equal(rgb.snapshot("logitech", 1, "Renamed").name, "Renamed");
});

test("RGB power restores brightness and color, while preservePower never turns an off device on", async () => {
  const { rgb, commands } = fixture();
  await rgb.discover();
  await rgb.execute("aura", "color", 4, "PC", {
    hue: 120,
    saturation: 100,
    brightness: 60,
  });
  await rgb.execute("aura", "brightness", 4, "PC", { value: 0 });
  await rgb.execute("aura", "power", 4, "PC", { on: true });
  assert.deepEqual(commands.at(-1)?.rgb, [0, 153, 0]);
  await rgb.execute("aura", "power", 4, "PC", { on: false });
  await rgb.execute("aura", "brightness", 4, "PC", {
    value: 30,
    preservePower: true,
  });
  assert.deepEqual(commands.at(-1)?.rgb, [0, 0, 0]);
  assert.equal(rgb.snapshot("aura", 4, "PC").on, false);
  await rgb.execute("aura", "power", 4, "PC", { on: true });
  assert.deepEqual(commands.at(-1)?.rgb, [0, 77, 0]);
});

test("invalid controls never reach an SDK; failures preserve confirmed state and other devices", async () => {
  const f = fixture();
  await f.rgb.discover();
  for (const [method, params] of [
    ["power", { on: "yes" }],
    ["brightness", { value: -1 }],
    ["color", { hue: NaN, saturation: 100 }],
    ["color", { hue: 200, saturation: 100, brightness: 101 }],
    ["temperature", { value: 4000 }],
    ["pair", {}],
  ] as const)
    await assert.rejects(f.rgb.execute("aura", method, 4, "PC", params));
  assert.equal(f.commands.length, 1);
  await f.rgb.execute("logitech", "brightness", 3, "Keyboard", { value: 25 });
  f.disconnect();
  await assert.rejects(
    f.rgb.execute("logitech", "brightness", 3, "Keyboard", { value: 80 }),
    /disconnected/,
  );
  assert.equal(f.rgb.snapshot("logitech", 3, "Keyboard").brightness, 25);
  assert.equal(f.rgb.snapshot("logitech", 3, "Keyboard").online, false);
  assert.equal(f.rgb.snapshot("aura", 4, "PC").online, true);
  f.reconnect();
  await f.rgb.discover();
  assert.equal(f.rgb.snapshot("logitech", 3, "Keyboard").online, true);
});
