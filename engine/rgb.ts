import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { bounded } from "./domain.js";
import { hsvToHex } from "../shared/colors.js";
import type { Light } from "../shared/light.js";

export type RgbSource = "logitech" | "aura";
export interface RgbDiscovery {
  keyboard: string | null;
  pc: { name: string; leds: number }[];
  warnings: string[];
}
export interface RgbTransport {
  request(message: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

// Isolate vendor DLLs from the Matter controller: even a native SDK crash must
// not take the bulbs offline. A hung SDK is killed and can be retried.
export class WindowsRgbTransport implements RgbTransport {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private start() {
    if (process.platform !== "win32")
      throw new Error(
        "Les LED locales nécessitent Windows, G HUB ou Aura Sync.",
      );
    const executable = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./rgb.ps1", import.meta.url)),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.resume();
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(
            "Le contrôleur RGB s’est arrêté. Réessayez ; vérifiez G HUB et Aura Sync.",
          ),
        );
      }
      this.pending.clear();
    };
    child.on("error", failed);
    child.on("exit", failed);
    child.stdin.on("error", () => child.kill());
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (typeof message.error === "string")
        entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    return child;
  }
  request(message: Record<string, unknown>): Promise<unknown> {
    const child = this.child ?? this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(
              "Délai RGB dépassé. Vérifiez G HUB et Aura Sync, puis réessayez.",
            ),
          );
          child.kill();
        },
        message.method === "discover" ? 45000 : 15000,
      );
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  }
  async close() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
}

export class LocalRgb {
  private discovery?: RgbDiscovery;
  private failures = new Set<RgbSource>();
  private state = new Map<RgbSource, Light>();
  private lastBrightness = new Map<RgbSource, number>();
  constructor(private transport: RgbTransport = new WindowsRgbTransport()) {}
  async discover() {
    try {
      this.discovery = (await this.transport.request({
        method: "discover",
      })) as RgbDiscovery;
      this.failures.clear();
    } catch (error) {
      this.discovery = undefined;
      throw error;
    }
    return this.discovery;
  }
  snapshot(source: RgbSource, index: number, name: string): Light {
    const online =
      !this.failures.has(source) &&
      (source === "logitech"
        ? !!this.discovery?.keyboard
        : !!this.discovery?.pc.length);
    return {
      paired: true,
      connecting: false,
      on: null,
      brightness: null,
      temperature: null,
      dimmable: true,
      tunable: false,
      minKelvin: 2200,
      maxKelvin: 6500,
      color: true,
      colorMode: "color",
      hue: 0,
      saturation: 0,
      hex: "#ffffff",
      ...this.state.get(source),
      index,
      name,
      online,
      available: online,
    };
  }
  async execute(
    source: RgbSource,
    method: string,
    index: number,
    name: string,
    params: Record<string, unknown>,
  ) {
    const next = { ...this.snapshot(source, index, name) };
    if (method === "power") {
      if (typeof params.on !== "boolean")
        throw new Error("État de lumière invalide.");
      next.on = params.on;
      if (params.on && !next.brightness)
        next.brightness = this.lastBrightness.get(source) ?? 100;
    } else if (method === "brightness") {
      next.brightness = bounded(params.value, 0, 100);
      if (params.preservePower !== true) next.on = next.brightness > 0;
    } else if (method === "color") {
      next.hue = bounded(params.hue, 0, 360);
      next.saturation = bounded(params.saturation, 0, 100);
      if (params.brightness !== undefined) {
        next.brightness = bounded(params.brightness, 0, 100);
        next.on = next.brightness > 0;
      }
    } else
      throw new Error(
        "Les LED RGB locales acceptent marche/arrêt, luminosité et couleur.",
      );
    next.on ??= true;
    next.brightness ??= 100;
    const hex = hsvToHex(
      next.hue,
      next.saturation,
      next.on ? next.brightness : 0,
    );
    const rgb = [1, 3, 5].map((offset) =>
      parseInt(hex.slice(offset, offset + 2), 16),
    );
    try {
      await this.transport.request({ method: "set", source, rgb });
    } catch (error) {
      this.failures.add(source);
      throw error;
    }
    next.hex = hsvToHex(next.hue, next.saturation, next.brightness);
    this.failures.delete(source);
    if (next.brightness > 0) this.lastBrightness.set(source, next.brightness);
    this.state.set(source, next);
  }
  close() {
    return this.transport.close();
  }
}
