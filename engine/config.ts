import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultConfig,
  parseConfig,
  validName,
  type AppConfig,
} from "../shared/config.js";

export interface Slot {
  id: string;
  name: string;
  peerId?: string;
}
export async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Impossible de lire ${path} : ${error instanceof Error ? error.message : "JSON invalide"}`,
    );
  }
}
export async function loadSettings(directory: string) {
  const path = join(directory, "config.json");
  const saved = await optionalJson(join(directory, "lights.json"));
  const retained: Slot[] = [];
  if (saved !== undefined) {
    if (!Array.isArray(saved))
      throw new Error("Données d’appairage invalides.");
    const ids = new Set<string>();
    saved.forEach((slot, index) => {
      if (
        !slot ||
        typeof slot !== "object" ||
        (slot.peerId !== undefined && typeof slot.peerId !== "string")
      )
        throw new Error("Données d’appairage invalides.");
      const id = slot.id ?? `light-${index + 1}`;
      if (
        typeof id !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(id) ||
        ids.has(id)
      )
        throw new Error("Identifiant d’appairage invalide ou dupliqué.");
      ids.add(id);
      retained.push({
        id,
        name: validName(slot.name),
        ...(slot.peerId === undefined ? {} : { peerId: slot.peerId }),
      });
    });
  }
  const source = await optionalJson(path);
  let config: AppConfig;
  if (source === undefined) {
    config = defaultConfig();
    config.lights.forEach((light) => {
      const previous = retained.find((slot) => slot.id === light.id);
      if (previous) light.name = previous.name;
    });
    await writeJson(path, config);
  } else config = parseConfig(source);
  const slots: Slot[] = config.lights.map((light) => ({
    id: light.id,
    name: light.name,
    ...(retained.find((slot) => slot.id === light.id)?.peerId === undefined
      ? {}
      : { peerId: retained.find((slot) => slot.id === light.id)!.peerId }),
  }));
  const allSlots = () => [
    ...slots,
    ...retained.filter(
      (slot) => !slots.some((active) => active.id === slot.id),
    ),
  ];
  if (Array.isArray(saved) && saved.some((slot) => slot.id === undefined))
    await writeJson(join(directory, "lights.json"), allSlots());
  let saveQueue = Promise.resolve();
  return {
    config,
    slots,
    allSlots,
    rename(index: number, value: unknown) {
      const name = validName(value);
      const job = saveQueue.then(async () => {
        const next = structuredClone(config);
        next.lights[index].name = name;
        await writeJson(path, next);
        config = next;
        slots[index].name = name;
      });
      saveQueue = job.catch(() => {});
      return job;
    },
  };
}
