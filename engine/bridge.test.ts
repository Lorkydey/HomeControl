import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Environment, ServerNode, Endpoint, Logger } from "@matter/main";
import {
  ExtendedColorLightDevice,
  ExtendedColorLightRequirements,
} from "@matter/main/devices/extended-color-light";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
const FixtureColor = ExtendedColorLightRequirements.ColorControlServer.with(
  "HueSaturation",
  "Xy",
  "ColorTemperature",
);
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { LevelControlServer } from "@matter/main/behaviors/level-control";

function launch(directory: string) {
  const child = spawn(process.execPath, [
    resolve("engine/dist/bridge.mjs"),
    directory,
  ]);
  let sequence = 0;
  let stderr = "";
  const events: { time: number; data: any }[] = [];
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    if (response.event === "state")
      events.push({ time: performance.now(), data: response.data });
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error)
      request.reject(new Error(`${response.error}\n${stderr}`));
    else request.resolve(response.result);
  });
  child.on("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Engine exited: ${stderr}`));
    }
    pending.clear();
  });
  return {
    child,
    events,
    request(method: string, params = {}): Promise<any> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(id);
            reject(new Error(`Timeout: ${method}. ${stderr}`));
          },
          method === "pair" ? 110000 : 20000,
        );
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 3000);
  await exited;
  clearTimeout(timer);
}
test(
  "packaged Matter engine starts, rejects unavailable controls, and preserves names after restart",
  { timeout: 35000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "homecontrol-test-"));
    let engine = launch(directory);
    try {
      const lights = await engine.request("status");
      assert.deepEqual(
        lights.map((light: any) => light.name),
        ["Chambre", "Séjour", "Cuisine"],
      );
      assert.ok(
        lights.every(
          (light: any) => !light.paired && !light.online && light.on === null,
        ),
      );
      await assert.rejects(
        engine.request("power", { index: 0, on: true }),
        /hors ligne/,
      );
      await assert.rejects(
        engine.request("rename", { index: 9, name: "bad" }),
        /lampes configur/,
      );
      await engine.request("rename", { index: 1, name: "Bureau" });
      await stop(engine.child);
      engine = launch(directory);
      const restored = await engine.request("status");
      assert.equal(restored[1].name, "Bureau");
      assert.ok(restored.every((light: any) => !light.paired));
    } finally {
      await stop(engine.child);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Matter pairing, commands and fabric persistence work against a separate simulated bulb",
  { timeout: 135000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "homecontrol-matter-"));
    Logger.level = "error";
    Environment.default.vars.set("storage.path", join(directory, "fixture"));
    const bulb = await ServerNode.create({
      id: "integration-bulb",
      network: { port: 0 },
      commissioning: { passcode: 54731289, discriminator: 3917 },
    });
    const lamp = new Endpoint(ExtendedColorLightDevice.with(FixtureColor), {
      id: "lamp",
      onOff: { onOff: false },
      levelControl: { currentLevel: 127 },
      colorControl: {
        colorMode: 2,
        enhancedColorMode: 2,
        currentHue: 0,
        currentSaturation: 0,
        currentX: 20493,
        currentY: 21561,
        colorTemperatureMireds: 370,
        colorTempPhysicalMinMireds: 153,
        colorTempPhysicalMaxMireds: 555,
        coupleColorTempToLevelMinMireds: 153,
      },
    });
    await bulb.add(lamp);
    let engine = launch(join(directory, "controller"));
    try {
      await bulb.start();
      const code = bulb.state.commissioning.pairingCodes.manualPairingCode;
      let paired = await engine.request("pair", { index: 0, code });
      for (let attempt = 0; attempt < 30 && !paired[0].online; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        paired = await engine.request("status");
      }
      assert.equal(paired[0].paired, true);
      assert.equal(paired[0].online, true);
      assert.equal(paired[0].dimmable, true);
      assert.equal(paired[0].color, true);
      assert.equal(paired[0].tunable, true);
      const commandStart = performance.now();
      await engine.request("power", { index: 0, on: true });
      assert.equal(lamp.stateOf(OnOffServer).onOff, true);
      for (
        let n = 0;
        n < 100 &&
        !engine.events.some(
          (event) => event.time >= commandStart && event.data[0].on === true,
        );
        n++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const report = engine.events.find(
        (event) => event.time >= commandStart && event.data[0].on === true,
      );
      assert.ok(report, "state pushed after a light command");
      assert.ok(
        report.time - commandStart < 1000,
        "state updates must not wait for the old 2-second poll",
      );
      await engine.request("brightness", { index: 0, value: 40 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(lamp.stateOf(LevelControlServer).currentLevel, 102);
      await engine.request("color", { index: 0, hue: 210, saturation: 75 });
      assert.equal(lamp.stateOf(FixtureColor).currentHue, 148);
      assert.equal(lamp.stateOf(FixtureColor).currentSaturation, 191);
      await engine.request("temperature", { index: 0, value: 4000 });
      assert.equal(lamp.stateOf(FixtureColor).colorTemperatureMireds, 250);
      await engine.request("power", { index: 0, on: false });
      assert.equal(lamp.stateOf(OnOffServer).onOff, false);
      await stop(engine.child);
      engine = launch(join(directory, "controller"));
      let restored = await engine.request("status");
      for (let attempt = 0; attempt < 40 && !restored[0].online; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        restored = await engine.request("status");
      }
      assert.equal(restored[0].paired, true);
      assert.equal(restored[0].online, true);
      await engine.request("power", { index: 0, on: true });
      assert.equal(lamp.stateOf(OnOffServer).onOff, true);
    } finally {
      await stop(engine.child);
      await bulb.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
