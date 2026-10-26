import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, parseConfig, escapeHtml } from "../shared/config.js";
import { loadSettings, writeJson } from "./config.js";

test("the public example matches defaults and invalid configuration is rejected", async () => {
  const example = JSON.parse(await readFile("config.example.json", "utf8"));
  assert.deepEqual(parseConfig(example), defaultConfig());
  for (const modify of [
    (c: any) => (c.lights = []),
    (c: any) => (c.lights = Array(9).fill(c.lights[0])),
    (c: any) => (c.lights[1].id = c.lights[0].id),
    (c: any) => (c.lights[0].id = "../secrets"),
    (c: any) => (c.lights[0].icon = "<svg>"),
    (c: any) => (c.lights[0].name = "\n"),
    (c: any) => (c.window.width = 279),
    (c: any) => (c.window.width = 480.5),
    (c: any) => (c.window.margin = -1),
    (c: any) => (c.window.hideOnBlur = "false"),
    (c: any) => (c.window.typo = true),
    (c: any) => (c.version = 2),
  ]) {
    const config = structuredClone(example);
    modify(config);
    assert.throws(() => parseConfig(config));
  }
  assert.equal(
    escapeHtml('<img src=x onerror="bad()">&'),
    "&lt;img src=x onerror=&quot;bad()&quot;&gt;&amp;",
  );
});

test("migration, reordering and removing a slot never reassign or discard its pairing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homecontrol-config-"));
  try {
    await writeJson(join(directory, "lights.json"), [
      { name: "Bedroom", peerId: "existing-bedroom" },
      { name: "Office", peerId: "existing-office" },
      { name: "Kitchen", peerId: "existing-kitchen" },
    ]);
    const store = await loadSettings(directory);
    assert.deepEqual(
      store.slots.map((s) => s.id),
      ["light-1", "light-2", "light-3"],
    );
    const publicConfig = await readFile(join(directory, "config.json"), "utf8");
    assert.ok(
      !publicConfig.includes("peerId") &&
        !publicConfig.includes("existing-bedroom"),
    );
    const config = parseConfig(JSON.parse(publicConfig));
    config.lights = [config.lights[2], config.lights[0]];
    config.window.width = 360;
    await writeJson(join(directory, "config.json"), config);
    const reordered = await loadSettings(directory);
    assert.deepEqual(
      reordered.slots.map((s) => s.peerId),
      ["existing-kitchen", "existing-bedroom"],
    );
    await reordered.rename(0, "Dining room");
    await writeJson(join(directory, "lights.json"), reordered.allSlots());
    const saved = parseConfig(
      JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
    );
    assert.equal(saved.window.width, 360);
    assert.equal(saved.lights[0].name, "Dining room");
    saved.lights.push({ id: "light-2", name: "Office", icon: "desk" });
    await writeJson(join(directory, "config.json"), saved);
    const restored = await loadSettings(directory);
    assert.deepEqual(
      restored.slots.map((s) => s.peerId),
      ["existing-kitchen", "existing-bedroom", "existing-office"],
    );
    assert.equal(restored.slots[0].name, "Dining room");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid and BOM-prefixed files are handled without resetting stored pairings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homecontrol-config-error-"));
  try {
    await writeJson(join(directory, "lights.json"), [
      { name: "Lamp", peerId: "existing-peer" },
    ]);
    const settings = await loadSettings(directory);
    const pairings = await readFile(join(directory, "lights.json"), "utf8");
    await writeFile(join(directory, "config.json"), '{ "version": ');
    await assert.rejects(loadSettings(directory), /Impossible de lire/);
    assert.equal(
      await readFile(join(directory, "lights.json"), "utf8"),
      pairings,
    );
    await writeFile(
      join(directory, "config.json"),
      `\uFEFF${JSON.stringify(settings.config)}`,
    );
    assert.equal(
      (await loadSettings(directory)).slots[0].peerId,
      "existing-peer",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local RGB sources survive rename and reordering without changing Matter pairings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homecontrol-rgb-config-"));
  try {
    const config = defaultConfig();
    config.lights.push(
      { id: "keyboard", name: "Clavier", icon: "keyboard", source: "logitech" },
      { id: "pc", name: "PC", icon: "pc", source: "aura" },
    );
    assert.deepEqual(parseConfig(config), config);
    await writeJson(join(directory, "config.json"), config);
    await writeJson(join(directory, "lights.json"), [
      { id: "light-1", name: "Bedroom", peerId: "existing-bedroom" },
    ]);
    const store = await loadSettings(directory);
    await store.rename(3, "G keyboard");
    const saved = parseConfig(
      JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
    );
    assert.equal(saved.lights[3].source, "logitech");
    assert.equal(store.slots[0].peerId, "existing-bedroom");
    saved.lights.reverse();
    await writeJson(join(directory, "config.json"), saved);
    assert.equal(
      (await loadSettings(directory)).slots[4].peerId,
      "existing-bedroom",
    );
    saved.lights.push({
      id: "another-pc",
      name: "Other",
      icon: "pc",
      source: "aura",
    });
    assert.throws(() => parseConfig(saved), /une fois/);
    (saved.lights[0] as any).source = "unknown";
    assert.throws(() => parseConfig(saved), /inconnue/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
