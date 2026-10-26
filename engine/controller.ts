import {
  Environment,
  ServerNode,
  ControllerBehavior,
  NetworkClient,
  Logger,
  Seconds,
  Millis,
  ClusterId,
  EndpointNumber,
  type ClientNode,
} from "@matter/main";
import { Subscribe, PeerSet, type Peer } from "@matter/protocol";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { LevelControlClient } from "@matter/main/behaviors/level-control";
import { ColorControlClient } from "@matter/main/behaviors/color-control";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bounded, pairingCode, slotIndex } from "./domain.js";
import { hsvToHex, hsvToXy, xyToHsv } from "../shared/colors.js";
import { LatestQueue } from "../shared/latest-queue.js";
import type { Light } from "../shared/light.js";
import { loadSettings, writeJson } from "./config.js";
import { LocalRgb, type RgbSource } from "./rgb.js";

Logger.level = "error";
Logger.log = (_level, message) => process.stderr.write(`${message}\n`);
console.log = (...args) => console.error(...args);
const dataDir = process.argv[2];
if (!dataDir) throw new Error("Dossier de données manquant");
await mkdir(dataDir, { recursive: true });
Environment.default.vars.set("storage.path", join(dataDir, "matter"));
Environment.default.vars.set("log.level", "error");
const settings = await loadSettings(dataDir);
const slots = settings.slots;
const rgb = new LocalRgb();
const rgbSource = (index: number): RgbSource | undefined => {
  const source = settings.config.lights[index].source;
  return source === "logitech" || source === "aura" ? source : undefined;
};
const hasRgb = settings.config.lights.some((_, index) => rgbSource(index));

// Keep automatic, sustained subscriptions, with only lighting and the metadata needed for seeding/Leave handling.
const subscription = () =>
  Subscribe({
    attributes: [0x1d, 0x28, 0x3e, 0x31, 0x06, 0x08, 0x300].map((cluster) => ({
      clusterId: ClusterId(cluster),
    })),
    events: [
      {
        endpointId: EndpointNumber(0),
        clusterId: ClusterId(0x28),
        isUrgent: true,
      },
    ],
    fabricFilter: true,
    keepSubscriptions: false,
    minIntervalFloor: Seconds(0),
    maxIntervalCeiling: Seconds(30),
  });
const controller = await ServerNode.create(
  ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior),
  {
    id: "homecontrol",
    commissioning: { enabled: false },
    network: {
      autoStartCommissionedPeers: false,
      timing: {
        defaultConnectionTimeout: Seconds(8),
        maxDelayBetweenInitialContactRetries: Seconds(5),
        delayBeforeNextAddress: Millis(500),
        delayAfterNetworkError: Seconds(2),
      },
    },
  },
);
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
let started = false,
  closing = false,
  pairing = false;
let saveQueue = Promise.resolve();
function save() {
  const serialized = structuredClone(settings.allSlots());
  const job = saveQueue.then(() =>
    writeJson(join(dataDir, "lights.json"), serialized),
  );
  saveQueue = job.catch(() => {});
  return job;
}
function nodeFor(index: number) {
  if (rgbSource(index)) return undefined;
  return slots[index].peerId
    ? controller.peers.get(slots[index].peerId!)
    : undefined;
}
function lightEndpoint(node: ClientNode) {
  return [...node.endpoints].find(
    (e) => e.lifecycle.isReadable && e.behaviors.has(OnOffClient.id),
  );
}
function available(node: ClientNode) {
  if (node.lifecycle.isConnected) return true;
  if (!node.lifecycle.isReadable || !node.lifecycle.isSeeded) return false;
  const address = node.state.commissioning.peerAddress;
  if (!address) return false;
  // An authenticated CASE channel can accept commands while the background subscription is still seeding.
  return Boolean(
    controller.env
      .get(PeerSet)
      .get(address)
      ?.sessions.find(
        (session) =>
          !session.isClosing && !session.isPeerLost && !session.isPase,
      ),
  );
}
function snapshot(): Light[] {
  return slots.map((slot, index) => {
    const source = rgbSource(index);
    if (source) return rgb.snapshot(source, index, slot.name);
    const node = nodeFor(index),
      endpoint = node && lightEndpoint(node);
    let on: boolean | null = null,
      brightness: number | null = null,
      temperature: number | null = null;
    let dimmable = false,
      tunable = false,
      color = false,
      hue = 0,
      saturation = 0,
      minKelvin = 2200,
      maxKelvin = 6500,
      colorMode: Light["colorMode"] = "white";
    if (endpoint) {
      on = endpoint.stateOf(OnOffClient).onOff ?? null;
      dimmable = endpoint.behaviors.has(LevelControlClient.id);
      if (dimmable) {
        const value = endpoint.stateOf(LevelControlClient).currentLevel;
        brightness =
          typeof value === "number" ? Math.round((value / 254) * 100) : null;
      }
      if (endpoint.behaviors.has(ColorControlClient.id)) {
        const state = endpoint.stateOf(ColorControlClient),
          features = endpoint.featuresOf(ColorControlClient);
        tunable = Boolean(features.colorTemperature);
        color = Boolean(features.hueSaturation || features.xy);
        colorMode = state.colorMode === 2 ? "white" : "color";
        if (typeof state.currentHue === "number")
          hue = (state.currentHue / 254) * 360;
        if (typeof state.currentSaturation === "number")
          saturation = (state.currentSaturation / 254) * 100;
        if (
          state.colorMode === 1 &&
          state.currentX !== undefined &&
          state.currentY
        ) {
          const converted = xyToHsv(
            state.currentX / 65536,
            state.currentY / 65536,
          );
          hue = converted.hue;
          saturation = converted.saturation;
        }
        if (tunable && state.colorTemperatureMireds)
          temperature = Math.round(1_000_000 / state.colorTemperatureMireds);
        if (state.colorTempPhysicalMaxMireds)
          minKelvin = Math.ceil(1_000_000 / state.colorTempPhysicalMaxMireds);
        if (state.colorTempPhysicalMinMireds)
          maxKelvin = Math.floor(1_000_000 / state.colorTempPhysicalMinMireds);
      }
    }
    const online = Boolean(node?.lifecycle.isConnected && endpoint);
    const connecting = Boolean(
      node && !online && node.lifecycle.connectionState !== 3,
    );
    return {
      index,
      name: slot.name,
      paired: Boolean(slot.peerId),
      online,
      available: Boolean(node && endpoint && available(node)),
      connecting,
      on,
      brightness,
      temperature,
      dimmable,
      tunable,
      color,
      colorMode,
      hue: Math.round(hue),
      saturation: Math.round(saturation),
      hex: hsvToHex(hue, saturation, brightness ?? 100),
      minKelvin,
      maxKelvin,
    };
  });
}
let broadcastTimer: ReturnType<typeof setTimeout> | undefined,
  lastBroadcast = "";
function broadcast(force = false) {
  if (closing) return;
  const data = snapshot(),
    serialized = JSON.stringify(data);
  if (force || serialized !== lastBroadcast) {
    lastBroadcast = serialized;
    send({ event: "state", data });
  }
}
function scheduleBroadcast() {
  if (broadcastTimer || closing) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    broadcast();
  }, 8);
}
const watchedNodes = new WeakSet<ClientNode>();
const watchedEvents = new WeakSet<object>();
function watchAttributes(node: ClientNode) {
  if (!node.lifecycle.isSeeded || !node.lifecycle.isReadable) return;
  for (const endpoint of node.endpoints) {
    if (!endpoint.lifecycle.isReadable) continue;
    const groups: [boolean, () => object, string[]][] = [
      [
        endpoint.behaviors.has(OnOffClient.id),
        () => endpoint.eventsOf(OnOffClient),
        ["onOff"],
      ],
      [
        endpoint.behaviors.has(LevelControlClient.id),
        () => endpoint.eventsOf(LevelControlClient),
        ["currentLevel"],
      ],
      [
        endpoint.behaviors.has(ColorControlClient.id),
        () => endpoint.eventsOf(ColorControlClient),
        [
          "colorMode",
          "currentHue",
          "currentSaturation",
          "currentX",
          "currentY",
          "colorTemperatureMireds",
        ],
      ],
    ];
    for (const [supported, events, attributes] of groups) {
      if (!supported) continue;
      const emitter = events() as Record<
        string,
        { on: (listener: () => void) => void } | undefined
      >;
      for (const attribute of attributes) {
        const observable = emitter[`${attribute}$Changed`];
        if (observable && !watchedEvents.has(observable)) {
          watchedEvents.add(observable);
          observable.on(scheduleBroadcast);
        }
      }
    }
  }
}
function watchNode(node: ClientNode) {
  if (watchedNodes.has(node)) return;
  watchedNodes.add(node);
  node.lifecycle.connectionStateChanged.on(scheduleBroadcast);
  const refresh = () => {
    queueMicrotask(() => {
      if (!closing) {
        watchAttributes(node);
        scheduleBroadcast();
      }
    });
  };
  node.lifecycle.seeded.on(refresh);
  node.lifecycle.changed.on(refresh);
  refresh();
}
async function configure(node: ClientNode) {
  watchNode(node);
  // Replace the request atomically. Deep-merging here can retain an older wildcard Read request.
  await node.act((agent) => {
    const network = agent.get(NetworkClient);
    network.state.defaultSubscription = subscription();
    network.state.autoSubscribe = true;
  });
}
// Peers emits "added" during ClientNode construction: defer access to private fields until construction returns.
controller.peers.added.on((node) => {
  queueMicrotask(() => {
    if (!closing) watchNode(node);
  });
});
const watchedPeers = new WeakSet<Peer>();
function watchPeer(peer: Peer) {
  if (watchedPeers.has(peer)) return;
  watchedPeers.add(peer);
  peer.sessions.added.on(scheduleBroadcast);
  peer.sessions.deleted.on(scheduleBroadcast);
}
for (const peer of controller.env.get(PeerSet)) watchPeer(peer);
controller.env.get(PeerSet).added.on((peer) => {
  queueMicrotask(() => {
    if (!closing) watchPeer(peer);
  });
});
const ready = Promise.all(controller.peers.commissioned.map(configure))
  .then(() => controller.start())
  .then(() => {
    started = true;
    // Starting peers concurrently avoids waiting for a slow/offline bulb before connecting the others.
    for (const node of controller.peers.commissioned) {
      void node
        .start()
        .then(() => {
          watchAttributes(node);
          scheduleBroadcast();
        })
        .catch((error) =>
          console.error(
            "Connexion Matter",
            error instanceof Error ? error.message : "Erreur",
          ),
        );
    }
    scheduleBroadcast();
  });
ready.catch((error) => console.error("Démarrage Matter impossible", error));
const controls = new LatestQueue();
const colorRefresh = new Map<number, ReturnType<typeof setTimeout>>();
function refreshColor(
  index: number,
  endpoint: NonNullable<ReturnType<typeof lightEndpoint>>,
  hueSaturation: boolean,
) {
  clearTimeout(colorRefresh.get(index));
  colorRefresh.set(
    index,
    setTimeout(() => {
      colorRefresh.delete(index);
      if (closing) return;
      // Some lamps acknowledge a mode switch before updating its color attributes.
      // Refresh once after the gesture settles, without delaying commands or polling.
      void endpoint
        .getStateOf(
          ColorControlClient,
          hueSaturation
            ? ["colorMode", "currentHue", "currentSaturation"]
            : ["colorMode", "currentX", "currentY"],
          { includeKnownVersions: true },
        )
        .then(scheduleBroadcast)
        .catch((error) =>
          console.error(
            "Confirmation couleur",
            error instanceof Error ? error.message : "Erreur",
          ),
        );
    }, 150),
  );
}
const options = {
  optionsMask: { executeIfOff: true },
  optionsOverride: { executeIfOff: true },
};
async function execute(
  method: string,
  index: number,
  params: Record<string, unknown>,
) {
  const node = nodeFor(index);
  if (!node || !available(node))
    throw new Error(
      "Cette lumière est hors ligne. Vérifiez son alimentation et le réseau.",
    );
  const endpoint = lightEndpoint(node);
  if (!endpoint)
    throw new Error("Aucune commande de lumière disponible sur cet appareil.");
  if (method === "power") {
    if (typeof params.on !== "boolean")
      throw new Error("État de lumière invalide.");
    await (params.on
      ? endpoint.commandsOf(OnOffClient).on()
      : endpoint.commandsOf(OnOffClient).off());
  } else if (method === "brightness") {
    if (!endpoint.behaviors.has(LevelControlClient.id))
      throw new Error("Cette lumière ne permet pas de régler l’intensité.");
    const value = bounded(params.value, 0, 100);
    const command = {
      level: Math.round((value / 100) * 254),
      transitionTime: 0,
      ...options,
    };
    if (params.preservePower === true)
      await endpoint.commandsOf(LevelControlClient).moveToLevel(command);
    else
      await endpoint
        .commandsOf(LevelControlClient)
        .moveToLevelWithOnOff(command);
  } else if (method === "temperature") {
    const info = snapshot()[index];
    if (!info.tunable)
      throw new Error("Cette lumière ne permet pas de régler le blanc.");
    const value = bounded(params.value, info.minKelvin, info.maxKelvin);
    await endpoint.commandsOf(ColorControlClient).moveToColorTemperature({
      colorTemperatureMireds: Math.round(1_000_000 / value),
      transitionTime: 0,
      ...options,
    });
  } else if (method === "color") {
    if (!endpoint.behaviors.has(ColorControlClient.id))
      throw new Error("Cette lumière ne permet pas de régler la couleur.");
    const hue = bounded(params.hue, 0, 360),
      saturation = bounded(params.saturation, 0, 100);
    if (params.brightness !== undefined) bounded(params.brightness, 0, 100);
    const commands = endpoint.commandsOf(ColorControlClient),
      features = endpoint.featuresOf(ColorControlClient);
    if (features.hueSaturation)
      await commands.moveToHueAndSaturation({
        hue: Math.round((hue / 360) * 254),
        saturation: Math.round((saturation / 100) * 254),
        transitionTime: 0,
        ...options,
      });
    else if (features.xy) {
      const xy = hsvToXy(hue, saturation);
      await commands.moveToColor({
        colorX: Math.round(xy.x * 65536),
        colorY: Math.round(xy.y * 65536),
        transitionTime: 0,
        ...options,
      });
    } else
      throw new Error("Cette lumière ne prend pas en charge les couleurs.");
    if (params.brightness !== undefined) {
      const level = bounded(params.brightness, 0, 100);
      if (!endpoint.behaviors.has(LevelControlClient.id))
        throw new Error("Intensité indisponible.");
      await endpoint.commandsOf(LevelControlClient).moveToLevelWithOnOff({
        level: Math.round((level / 100) * 254),
        transitionTime: 0,
        ...options,
      });
    }
    refreshColor(index, endpoint, Boolean(features.hueSaturation));
  } else throw new Error("Commande inconnue");
  scheduleBroadcast();
  return snapshot();
}
async function dispatch(method: string, params: Record<string, unknown>) {
  if (method === "status") return snapshot();
  if (method === "detect-rgb") return rgb.discover();
  if (method === "discover") {
    await ready;
    const nodes = await controller.peers.discover({
      timeout: Seconds(6),
      discoveryCapabilities: { onIpNetwork: true, ble: false },
    });
    return { count: nodes.length };
  }
  const index = slotIndex(params.index, slots.length);
  if (method === "rename") {
    await settings.rename(index, params.name);
    await save();
    scheduleBroadcast();
    return snapshot();
  }
  if (method === "pair") {
    if (rgbSource(index))
      throw new Error("Les LED du PC ne nécessitent pas de jumelage Matter.");
    await ready;
    if (slots[index].peerId)
      throw new Error("Cette lumière est déjà appairée.");
    if (pairing)
      throw new Error(
        "Terminez le jumelage en cours avant d’ajouter une autre lumière.",
      );
    const code = pairingCode(params.code);
    pairing = true;
    try {
      const node = await controller.peers.commission({
        id: `configured-${slots[index].id}`,
        pairingCode: code,
        timeout: Seconds(90),
        discoveryCapabilities: { onIpNetwork: true, ble: false },
        autoSubscribe: true,
        defaultSubscription: subscription(),
      });
      slots[index].peerId = node.id;
      watchNode(node);
      await save();
      scheduleBroadcast();
      return snapshot();
    } catch (error) {
      console.error("Jumelage Matter", error);
      throw new Error(
        "Jumelage impossible. Dans Apple Maison, activez le mode jumelage de cette ampoule et saisissez le nouveau code. Le PC et l’ampoule doivent être sur le même réseau local.",
      );
    } finally {
      pairing = false;
    }
  }
  const source = rgbSource(index);
  if (source) {
    return controls.run(index, method, async () => {
      try {
        await rgb.execute(source, method, index, slots[index].name, params);
        return snapshot();
      } finally {
        scheduleBroadcast();
      }
    });
  }
  await ready;
  return controls.run(index, method, () => execute(method, index, params));
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message: { id: number; method: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Independent RPC requests: discovery/pairing and a slow lamp never block status or another lamp.
  void dispatch(message.method, message.params ?? {}).then(
    (result) => send({ id: message.id, result }),
    (error) =>
      send({
        id: message.id,
        error:
          error instanceof Error
            ? error.message
            : "Commande impossible. Réessayez.",
      }),
  );
});
let rgbRefreshing = false;
async function refreshRgb() {
  if (!hasRgb || rgbRefreshing || closing) return;
  rgbRefreshing = true;
  try {
    await rgb.discover();
  } catch (error) {
    console.error("Détection RGB", error);
  } finally {
    rgbRefreshing = false;
    scheduleBroadcast();
  }
}
void refreshRgb();
const heartbeat = setInterval(() => {
  if (started) broadcast(true);
  void refreshRgb();
}, 30000);
input.on("close", async () => {
  closing = true;
  clearInterval(heartbeat);
  clearTimeout(broadcastTimer);
  for (const timer of colorRefresh.values()) clearTimeout(timer);
  await saveQueue;
  await Promise.allSettled([rgb.close(), controller.close()]);
  process.exit(0);
});
