import "./style.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Light } from "../shared/light";
import { hsvToHex, hexToHsv } from "../shared/colors";
import { LatestQueue } from "../shared/latest-queue";
import { defaultConfig, parseConfig, escapeHtml } from "../shared/config";

const paths = {
  bulb: '<path d="M9 18h6m-5 3h4M8.6 14.5a6 6 0 1 1 6.8 0c-.9.6-1.4 1.3-1.4 2.5h-4c0-1.2-.5-1.9-1.4-2.5Z"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  bed: '<path d="M3 17V7m18 10V9M3 14h18M3 10h18v9M3 19v2m18-2v2M6 10V7h5v3m2 0V7h5v3"/>',
  sofa: '<path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3M5 17h14M5 11a2 2 0 0 0-4 0v6a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-6a2 2 0 0 0-4 0v4H5v-4ZM5 19v2m14-2v2"/>',
  kitchen:
    '<path d="M5 9h14v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9Zm0 3H2m17 0h3M4 6h16M9 3h6"/>',
  desk: '<path d="M3 12h18M5 12v9m14-9v9M8 4h8v5H8zM12 9v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
};
const svg = (key: keyof typeof paths) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]}</svg>`;
const native = isTauri();
const config = native
  ? parseConfig(await invoke("app_config"))
  : defaultConfig();
const positions = config.lights.map((light) => light.name);
const physicalIndexes = positions.map((_, index) => index);
const masterIndex = positions.length;
const roomIcon = (index: number) => config.lights[index].icon;
const roomMark = (index: number) =>
  index === masterIndex ? "" : svg(roomIcon(index));
const swatches = [
  ["#ff4848", "Rouge"],
  ["#ffad33", "Orange"],
  ["#ffe066", "Jaune"],
  ["#54dc80", "Vert"],
  ["#41b7ed", "Bleu"],
  ["#ad80ff", "Violet"],
  ["#ff76ba", "Rose"],
];
const whites = [
  [2200, "Ambré"],
  [2700, "Chaud"],
  [4000, "Neutre"],
  [6500, "Froid"],
] as const;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
let confirmed: Light[] = positions.map((name, index) => ({
  index,
  name,
  paired: false,
  online: false,
  connecting: false,
  on: null,
  brightness: null,
  temperature: null,
  dimmable: false,
  tunable: false,
  minKelvin: 2200,
  maxKelvin: 6500,
  color: false,
  colorMode: "white",
  hue: 0,
  saturation: 0,
  hex: "#ffffff",
}));
let lights = confirmed.map((light) => ({ ...light }));
let selected = -1,
  connected = false,
  pairIndex = 0,
  pairInProgress = false,
  sequence = 0;
const motionAllowed = matchMedia("(prefers-reduced-motion: no-preference)");
const masterStorageKey = "homecontrol.master-brightness";
let masterBrightness = 100,
  lastMasterBrightness = 100;
try {
  const saved = localStorage.getItem(masterStorageKey),
    last = localStorage.getItem(`${masterStorageKey}.last-on`);
  if (
    saved !== null &&
    Number.isFinite(Number(saved)) &&
    Number(saved) >= 0 &&
    Number(saved) <= 100
  )
    masterBrightness = Number(saved);
  if (
    last !== null &&
    Number.isFinite(Number(last)) &&
    Number(last) > 0 &&
    Number(last) <= 100
  )
    lastMasterBrightness = Number(last);
  else if (masterBrightness > 0) lastMasterBrightness = masterBrightness;
} catch {}
let masterSaveTimer: ReturnType<typeof setTimeout> | undefined;
function saveMasterBrightness() {
  clearTimeout(masterSaveTimer);
  masterSaveTimer = undefined;
  try {
    localStorage.setItem(masterStorageKey, String(masterBrightness));
    localStorage.setItem(
      `${masterStorageKey}.last-on`,
      String(lastMasterBrightness),
    );
  } catch {}
}
function setMasterBrightness(value: number, final = false) {
  masterBrightness = value;
  if (value > 0) lastMasterBrightness = value;
  clearTimeout(masterSaveTimer);
  if (final) saveMasterBrightness();
  else masterSaveTimer = setTimeout(saveMasterBrightness, 250);
}
type Method = "power" | "brightness" | "temperature" | "color";
type Patch = Partial<Light>;
type Field = keyof Light;
interface Pending {
  token: number;
  value: unknown;
  acked: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
interface Draft {
  token: number;
  index: number;
  method: Method;
  params: Record<string, unknown>;
  patch: Patch;
}
const pending = new Map<number, Map<Field, Pending>>(),
  queue = new LatestQueue();
const live = new Map<
  string,
  { draft: Draft; timer: ReturnType<typeof setTimeout> }
>();

$("#app").innerHTML = `
<main><h1 class="sr-only">Éclairage</h1><div class="views"><section class="bars" id="home-view" aria-label="Lampes">
${[masterIndex, ...physicalIndexes]
  .map((index) => {
    const name = escapeHtml(
      index === masterIndex ? "Toutes les lampes" : positions[index],
    );
    return `<article class="lamp ${index === masterIndex ? "master-row" : ""}" id="light-${index}"><div class="brightness-shell"><div class="bar-fill" aria-hidden="true"></div><div class="bar-sheen" aria-hidden="true"></div><span class="bar-readout" aria-hidden="true">0 %</span><input class="brightness-bar" id="brightness-${index}" data-brightness="${index}" type="range" min="0" max="100" step="1" value="0" aria-label="Luminosité de ${name}"/><button class="lamp-power" id="power-${index}" data-power="${index}" role="switch" aria-checked="false" aria-label="Allumer ${name}"><span class="power-state state-off" aria-hidden="true">${svg("bulb")}</span><span class="power-state state-on" aria-hidden="true">${svg("bulb")}</span></button></div><span class="room-icon" ${index === masterIndex ? "hidden" : ""} role="img" aria-label="${name}">${roomMark(index)}<span class="lamp-name ${index === masterIndex ? "sr-only" : ""}">${name}</span></span><button class="color-open" id="color-open-${index}" data-edit="${index}" aria-label="Couleur de ${name}" aria-expanded="false" aria-controls="editor"><span class="color-chip" aria-hidden="true"></span></button></article>`;
  })
  .join("")}
</section>
<section id="editor" aria-label="Réglages de couleur" aria-hidden="true" inert><div class="editor-inner"><nav class="editor-nav" aria-label="Navigation couleur"><button class="icon-button" id="editor-close" aria-label="Retour aux lampes">${svg("back")}</button><span id="editor-room" role="img"><span id="selected-room-icon" aria-hidden="true"></span><span id="editor-name" class="sr-only"></span></span></nav>
<div class="color-modes" role="group" aria-label="Mode de lumière" data-active="white"><span class="mode-indicator" aria-hidden="true"></span><button data-mode="white" aria-pressed="true">Blanc</button><button data-mode="color" aria-pressed="false">Couleur</button></div>
<div class="white-controls"><div class="range-group"><label for="temperature">Blanc</label><output id="temperature-value" for="temperature">—</output><input class="temperature-range" id="temperature" data-range="temperature" type="range" min="2200" max="6500" value="3000"/></div><div class="white-presets" role="group" aria-label="Nuances de blanc">${whites.map(([value, label]) => `<button data-white="${value}">${label}</button>`).join("")}</div></div>
<div class="color-controls" hidden><div class="color-picker-row"><label class="color-picker-label" for="color-picker">Couleur<input type="color" id="color-picker" value="#ff0000"/></label><label for="hex"><span class="sr-only">Code couleur hexadécimal</span><input id="hex" class="hex-input" value="#ff0000" spellcheck="false" maxlength="7"/></label></div><div class="color-swatches" role="group" aria-label="Couleurs rapides">${swatches.map(([hex, name]) => `<button class="swatch" data-swatch="${hex}" style="--swatch:${hex}" aria-label="${name}"></button>`).join("")}</div>
<div class="range-group"><label for="hue">Teinte</label><output id="hue-value" for="hue">0°</output><input class="hue-range" id="hue" data-range="hue" type="range" min="0" max="360" value="0"/></div><div class="range-group"><label for="saturation">Saturation</label><output id="saturation-value" for="saturation">100 %</output><input class="saturation-range" id="saturation" data-range="saturation" type="range" min="0" max="100" value="100"/></div></div>
</div></section></div><p id="message" role="status" aria-live="polite"></p></main>
<dialog id="pair-dialog" aria-labelledby="pair-title"><form id="pair-form"><div class="dialog-heading"><h2 id="pair-title">Appairer Chambre</h2><button type="button" class="icon-button dialog-close" aria-label="Fermer le jumelage">${svg("close")}</button></div><p class="dialog-description">Dans l’application qui contrôle déjà cette lampe, activez le <strong>partage Matter</strong> ou le mode jumelage.</p><label class="field-label" for="pair-code">Code temporaire</label><input id="pair-code" class="text-input pairing-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="0000-000-0000" aria-describedby="pair-error" required/><p class="form-error" id="pair-error" role="alert"></p><button class="primary-button" id="pair-submit" type="submit">Appairer</button></form></dialog>
<dialog id="settings-dialog" aria-labelledby="settings-title"><div class="dialog-heading"><h2 id="settings-title">Réglages</h2><button class="icon-button settings-close" aria-label="Fermer les réglages">${svg("close")}</button></div><form id="names-form">${positions.map((name, index) => `<label class="field-label" for="name-${index}">${escapeHtml(name)}</label><input class="text-input" id="name-${index}" maxlength="40" required/>`).join("")}<p class="form-error" id="settings-error" role="alert"></p><button class="primary-button" type="submit">Enregistrer</button></form></dialog>`;

const pairDialog = $<HTMLDialogElement>("#pair-dialog"),
  settingsDialog = $<HTMLDialogElement>("#settings-dialog"),
  codeInput = $<HTMLInputElement>("#pair-code");
const editor = $("#editor"),
  editorInner = $(".editor-inner"),
  home = $("#home-view"),
  views = $(".views");
let editorOpen = false,
  editorHeight = 0,
  editorFrame = 0,
  shrinkUntil = 0,
  shrinkTimer: ReturnType<typeof setTimeout> | undefined;
const oneShotAnimations = new WeakMap<HTMLElement, Animation>();
let visibilityGeneration = 0;
function entrance(element: HTMLElement) {
  oneShotAnimations.get(element)?.cancel();
  if (!motionAllowed.matches) return;
  const animation = element.animate(
    [
      { opacity: 0, transform: "translateY(6px) scale(.985)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    { duration: 260, easing: "cubic-bezier(.16,1,.3,1)" },
  );
  oneShotAnimations.set(element, animation);
}
function syncEditor(open: boolean) {
  const opening = open && !editorOpen;
  editorOpen = open;
  editor.inert = !open;
  editor.setAttribute("aria-hidden", String(!open));
  editor.classList.toggle("is-open", open);
  home.inert = open;
  home.setAttribute("aria-hidden", String(open));
  views.classList.toggle("editing", open);
  if (opening) $("#editor-close").focus({ preventScroll: true });
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => {
    editorFrame = 0;
    const height = Math.max(
      home.scrollHeight,
      editorOpen ? editorInner.scrollHeight : 0,
    );
    if (height !== editorHeight) {
      clearTimeout(shrinkTimer);
      if (motionAllowed.matches && height < editorHeight) {
        shrinkUntil = performance.now() + 300;
        shrinkTimer = setTimeout(() => {
          shrinkUntil = 0;
          resizePanel();
        }, 310);
      } else shrinkUntil = 0;
      editorHeight = height;
      views.style.height = `${height}px`;
      resizePanel();
    }
  });
}
const bars = [...physicalIndexes, masterIndex].map((index) => ({
  card: $(`#light-${index}`),
  input: $<HTMLInputElement>(`#brightness-${index}`),
  readout: $(`#light-${index} .bar-readout`),
  power: $<HTMLButtonElement>(`#power-${index}`),
  name: $(`#light-${index} .lamp-name`),
  identity: $(`#light-${index} .room-icon`),
  color: $<HTMLButtonElement>(`#color-open-${index}`),
}));
const ranges = Object.fromEntries(
  ["temperature", "hue", "saturation"].map((kind) => [
    kind,
    { input: $<HTMLInputElement>(`#${kind}`), output: $(`#${kind}-value`) },
  ]),
) as Record<
  "temperature" | "hue" | "saturation",
  { input: HTMLInputElement; output: HTMLElement }
>;
const canControl = (light: Light) => light.online || !!light.available;
const lampColor = (light: Light) =>
  light.color && light.colorMode === "color"
    ? hsvToHex(light.hue, light.saturation)
    : "#eeeeee";
function targets(index: number) {
  if (index < 0 || index > masterIndex) return [];
  return (index === masterIndex ? lights : [lights[index]]).filter(canControl);
}
function group(): Light {
  const members = targets(masterIndex),
    first = members[0] ?? lights[0],
    tunable = members.filter((light) => light.tunable);
  return {
    ...first,
    index: masterIndex,
    name: "Toutes les lampes",
    paired: lights.some((light) => light.paired),
    online: members.length > 0,
    available: members.length > 0,
    on: members.length > 0 && members.every((light) => light.on),
    brightness: masterBrightness,
    dimmable: members.some((light) => light.dimmable),
    color: members.some((light) => light.color),
    tunable: tunable.length > 0,
    minKelvin: tunable.length
      ? Math.max(...tunable.map((light) => light.minKelvin))
      : 2200,
    maxKelvin: tunable.length
      ? Math.min(...tunable.map((light) => light.maxKelvin))
      : 6500,
  };
}
function iconInk(hex: string) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722 > 0.179
    ? "#000000"
    : "#ffffff";
}
async function request<T = Light[]>(
  method: string,
  params: object = {},
): Promise<T> {
  return invoke<T>("engine_request", { method, params });
}
function message(text: string) {
  $("#message").textContent = text;
}
function equal(field: Field, actual: unknown, expected: unknown) {
  if (typeof actual === "number" && typeof expected === "number") {
    const d = Math.abs(actual - expected);
    return field === "hue"
      ? Math.min(d, 360 - d) <= 2
      : d <= (field === "temperature" ? 60 : 1);
  }
  return actual === expected;
}
function update(next?: Light[]) {
  if (next) confirmed = next;
  lights = confirmed.map((actual) => {
    const view = { ...actual },
      entries = pending.get(actual.index);
    for (const [field, entry] of entries ?? []) {
      if (entry.acked && equal(field, actual[field], entry.value)) {
        clearTimeout(entry.timer);
        entries!.delete(field);
      } else Object.assign(view, { [field]: entry.value });
    }
    view.hex = hsvToHex(view.hue, view.saturation, view.brightness ?? 100);
    return view;
  });
  const all = group(),
    members = targets(masterIndex),
    colors = members.map(lampColor),
    mixed = new Set(colors).size > 1;
  for (const light of [...lights, all]) {
    const c = bars[light.index],
      available = canControl(light),
      on = available && !!light.on,
      mixedPower =
        light.index === masterIndex && members.some((l) => l.on) && !on,
      level = on || mixedPower ? (light.brightness ?? 100) : 0,
      color =
        light.index === masterIndex && mixed ? "#eeeeee" : lampColor(light);
    c.card.style.setProperty("--progress", String(level / 100));
    c.readout.textContent = `${level} %`;
    c.card.style.setProperty("--lamp-color", color);
    c.card.style.setProperty(
      "--icon-ink",
      level >= 34 ? iconInk(color) : "#eeeeee",
    );
    c.card.style.setProperty(
      "--icon-bg",
      level >= 34 ? "transparent" : "#000000bb",
    );
    c.card.classList.toggle("is-on", on);
    c.card.classList.toggle("is-mixed", mixedPower);
    c.card.classList.toggle("offline", light.paired && !available);
    c.card.classList.toggle("selected", selected === light.index);
    c.card.setAttribute(
      "aria-busy",
      String(
        light.index === masterIndex
          ? lights.some((l) => pending.get(l.index)?.size)
          : !!pending.get(light.index)?.size,
      ),
    );
    c.name.textContent = light.name;
    c.identity.setAttribute("aria-label", light.name);
    c.input.disabled = !available || !light.dimmable;
    if (document.activeElement !== c.input) c.input.value = String(level);
    c.input.setAttribute(
      "aria-label",
      light.index === masterIndex
        ? "Luminosité de toutes les lampes"
        : `Luminosité de ${light.name}`,
    );
    c.input.setAttribute("aria-valuetext", `${level} %`);
    c.power.disabled =
      light.index === masterIndex
        ? !available
        : light.paired
          ? !available
          : pairInProgress || !connected;
    c.power.setAttribute(
      "role",
      light.index === masterIndex
        ? "checkbox"
        : light.paired
          ? "switch"
          : "button",
    );
    if (light.paired || light.index === masterIndex)
      c.power.setAttribute("aria-checked", mixedPower ? "mixed" : String(on));
    else c.power.removeAttribute("aria-checked");
    const title =
      !light.paired && light.index < masterIndex
        ? `Appairer ${light.name}`
        : !available
          ? `${light.name} · ${light.connecting ? "Connexion…" : "Hors ligne"}`
          : `${on ? "Éteindre" : "Allumer"} ${light.index === masterIndex ? "toutes les lampes" : light.name}`;
    c.power.setAttribute("aria-label", title);
    c.color.disabled = !available || !(light.color || light.tunable);
    c.color.setAttribute("aria-expanded", String(selected === light.index));
    c.color.setAttribute(
      "aria-label",
      light.index === masterIndex
        ? "Couleur de toutes les lampes"
        : `Couleur de ${light.name}`,
    );
    c.color.style.setProperty("--chip-color", lampColor(light));
    c.color.style.setProperty(
      "--chip-image",
      light.index === masterIndex && mixed
        ? `conic-gradient(${colors.map((value, i) => `${value} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`).join(",")})`
        : "none",
    );
  }
  const light = selected === masterIndex ? all : lights[selected],
    expanded = !!light && canControl(light) && (light.color || light.tunable);
  if (!expanded) {
    if (selected >= 0) {
      bars[selected].color.setAttribute("aria-expanded", "false");
      selected = -1;
    }
    syncEditor(false);
    return;
  }
  $("#editor-name").textContent = light.name;
  $("#editor-room").setAttribute("aria-label", light.name);
  $("#editor-room").hidden = selected === masterIndex;
  if ($("#selected-room-icon").dataset.index !== String(selected)) {
    $("#selected-room-icon").innerHTML = roomMark(selected);
    $("#selected-room-icon").dataset.index = String(selected);
  }
  editor.setAttribute("aria-label", `Couleur de ${light.name}`);
  const colored = light.color && light.colorMode === "color";
  $(".color-modes").dataset.active = colored ? "color" : "white";
  $(".color-modes").hidden = !light.color || !light.tunable;
  $(".white-controls").hidden = colored || !light.tunable;
  $(".color-controls").hidden = !colored;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-mode]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === light.colorMode),
    );
  for (const input of [
    $<HTMLInputElement>("#color-picker"),
    $<HTMLInputElement>("#hex"),
  ])
    if (document.activeElement !== input) input.value = light.hex;
  for (const kind of ["temperature", "hue", "saturation"] as const) {
    const { input, output } = ranges[kind],
      value = light[kind];
    if (kind === "temperature") {
      input.min = String(light.minKelvin);
      input.max = String(light.maxKelvin);
    }
    if (document.activeElement !== input) input.value = String(value ?? 3000);
    output.textContent =
      value === null
        ? "—"
        : `${value}${kind === "temperature" ? " K" : kind === "hue" ? "°" : " %"}`;
  }
  ranges.saturation.input.style.setProperty(
    "--saturation-color",
    hsvToHex(light.hue, 100),
  );
  syncEditor(true);
}

function draft(
  method: Method,
  index: number,
  params: Record<string, unknown>,
  patch: Patch,
): Draft {
  const job = {
      token: ++sequence,
      index,
      method,
      params: { ...params, index },
      patch,
    },
    entries = pending.get(index) ?? new Map<Field, Pending>();
  pending.set(index, entries);
  for (const [field, value] of Object.entries(patch)) {
    clearTimeout(entries.get(field as Field)?.timer);
    entries.set(field as Field, { token: job.token, value, acked: false });
  }
  update();
  return job;
}
async function dispatch(job: Draft): Promise<boolean> {
  try {
    await queue.run(job.index, job.method, () =>
      request(job.method, job.params),
    );
    for (const field of Object.keys(job.patch) as Field[]) {
      const entry = pending.get(job.index)?.get(field);
      if (entry?.token !== job.token) continue;
      entry.acked = true;
      entry.timer = setTimeout(() => {
        if (pending.get(job.index)?.get(field) === entry) {
          pending.get(job.index)!.delete(field);
          update();
        }
      }, 1200);
    }
    update();
    return true;
  } catch (error) {
    let current = false;
    for (const field of Object.keys(job.patch) as Field[])
      if (pending.get(job.index)?.get(field)?.token === job.token) {
        pending.get(job.index)!.delete(field);
        current = true;
      }
    if (current) message(`${lights[job.index].name} : ${String(error)}`);
    update();
    return false;
  }
}
function flush(index: number) {
  for (const [key, entry] of live)
    if (entry.draft.index === index) {
      clearTimeout(entry.timer);
      live.delete(key);
      void dispatch(entry.draft);
    }
}
function control(
  method: Method,
  index: number,
  params: Record<string, unknown>,
  patch: Patch,
) {
  flush(index);
  message("");
  return dispatch(draft(method, index, params, patch));
}
function stream(
  method: Method,
  index: number,
  params: Record<string, unknown>,
  patch: Patch,
  final = false,
) {
  const job = draft(method, index, params, patch),
    key = `${index}:${method}`,
    existing = live.get(key);
  if (existing) {
    existing.draft = job;
    if (final) flush(index);
    return;
  }
  const timer = setTimeout(() => {
    const entry = live.get(key);
    if (entry) {
      live.delete(key);
      void dispatch(entry.draft);
    }
  }, 40);
  live.set(key, { draft: job, timer });
  if (final) flush(index);
}
function colorPatch(
  hue: number,
  saturation: number,
  brightness?: number,
): Patch {
  return {
    hue,
    saturation,
    colorMode: "color",
    ...(brightness !== undefined ? { brightness, on: brightness > 0 } : {}),
  };
}
function sendColor(
  index: number,
  hue: number,
  saturation: number,
  brightness?: number,
  streaming = false,
  final = false,
) {
  if (index === masterIndex && brightness !== undefined)
    setMasterBrightness(brightness, !streaming || final);
  const params = {
    hue,
    saturation,
    ...(brightness !== undefined ? { brightness } : {}),
  };
  for (const light of targets(index).filter((light) => light.color)) {
    const patch = colorPatch(hue, saturation, brightness);
    if (streaming) stream("color", light.index, params, patch, final);
    else void control("color", light.index, params, patch);
  }
}
function chooseColor(
  index: number,
  hex: string,
  streaming = false,
  final = false,
) {
  try {
    const hsv = hexToHsv(hex);
    sendColor(
      index,
      Math.round(hsv.hue),
      Math.round(hsv.saturation),
      Math.round(hsv.brightness),
      streaming,
      final,
    );
    $("#hex").removeAttribute("aria-invalid");
  } catch (error) {
    $("#hex").setAttribute("aria-invalid", "true");
    message(String(error));
  }
}
function sendWhite(
  index: number,
  value: number,
  streaming = false,
  final = false,
) {
  for (const light of targets(index).filter((light) => light.tunable)) {
    const bounded = Math.max(light.minKelvin, Math.min(light.maxKelvin, value)),
      patch: Patch = { temperature: bounded, colorMode: "white" };
    if (streaming)
      stream("temperature", light.index, { value: bounded }, patch, final);
    else void control("temperature", light.index, { value: bounded }, patch);
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-power]").forEach((button) =>
  button.addEventListener("click", () => {
    const index = Number(button.dataset.power);
    if (index < masterIndex && !lights[index].paired) {
      openPair(index);
      return;
    }
    const members = targets(index),
      on = !members.every((light) => light.on);
    if (index === masterIndex && on && masterBrightness === 0) {
      setMasterBrightness(lastMasterBrightness, true);
      void Promise.all(
        members.map((light) =>
          light.dimmable
            ? control(
                "brightness",
                light.index,
                { value: masterBrightness },
                { brightness: masterBrightness, on: true },
              )
            : control("power", light.index, { on: true }, { on: true }),
        ),
      );
      return;
    }
    void Promise.all(
      members
        .filter((light) => light.on !== on)
        .map((light) => control("power", light.index, { on }, { on })),
    );
  }),
);
document
  .querySelectorAll<HTMLInputElement>("[data-brightness]")
  .forEach((input) => {
    const index = Number(input.dataset.brightness);
    const gesture = (active: boolean) => {
      bars[index].card.classList.toggle("scrubbing", active);
      for (const [i, bar] of bars.entries())
        if (index === masterIndex || i === index)
          bar.card.classList.toggle("dragging", active);
    };
    input.addEventListener("pointerdown", () => gesture(true));
    input.addEventListener("pointerup", () => gesture(false));
    input.addEventListener("pointercancel", () => gesture(false));
    input.addEventListener("lostpointercapture", () => gesture(false));
    input.addEventListener("blur", () => gesture(false));
    input.addEventListener("keydown", (event) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(event.key)
      )
        gesture(true);
    });
    input.addEventListener("keyup", () => gesture(false));
    const change = (final: boolean) => {
      const value = Number(input.value);
      if (index === masterIndex) setMasterBrightness(value, final);
      message("");
      for (const light of targets(Number(input.dataset.brightness)).filter(
        (light) => light.dimmable,
      ))
        stream(
          "brightness",
          light.index,
          { value },
          { brightness: value, on: value > 0 },
          final,
        );
    };
    input.addEventListener("input", () => change(false));
    input.addEventListener("change", () => change(true));
  });
document.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((button) =>
  button.addEventListener("click", () => {
    const index = Number(button.dataset.edit);
    selected = selected === index ? -1 : index;
    update();
  }),
);
function closeEditor() {
  const index = selected;
  selected = -1;
  update();
  bars[index]?.color.focus();
}
$("#editor-close").addEventListener("click", closeEditor);
document.querySelectorAll<HTMLInputElement>("[data-range]").forEach((input) => {
  const change = (final: boolean) => {
    if (selected < 0) return;
    const light = selected === masterIndex ? group() : lights[selected],
      value = Number(input.value);
    if (input.dataset.range === "temperature")
      sendWhite(selected, value, true, final);
    else
      sendColor(
        selected,
        input.dataset.range === "hue" ? value : light.hue,
        input.dataset.range === "saturation" ? value : light.saturation,
        undefined,
        true,
        final,
      );
  };
  input.addEventListener("input", () => change(false));
  input.addEventListener("change", () => change(true));
});
const picker = $<HTMLInputElement>("#color-picker");
picker.addEventListener("input", () =>
  chooseColor(selected, picker.value, true),
);
picker.addEventListener("change", () =>
  chooseColor(selected, picker.value, true, true),
);
$("#hex").addEventListener("change", () =>
  chooseColor(selected, $<HTMLInputElement>("#hex").value),
);
document
  .querySelectorAll<HTMLButtonElement>("[data-swatch]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      const hsv = hexToHsv(button.dataset.swatch!);
      sendColor(selected, Math.round(hsv.hue), Math.round(hsv.saturation));
    }),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-mode],[data-white]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      if (selected < 0) return;
      const light = selected === masterIndex ? group() : lights[selected];
      if (button.dataset.mode === "color")
        sendColor(selected, light.hue, light.saturation || 100);
      else
        sendWhite(
          selected,
          Number(button.dataset.white ?? light.temperature ?? 2700),
        );
    }),
  );

function openPair(index: number) {
  if (pairInProgress) return;
  pairIndex = index;
  $("#pair-title").textContent = `Appairer ${lights[index].name}`;
  codeInput.value = "";
  codeInput.removeAttribute("aria-invalid");
  $("#pair-error").textContent = "";
  pairDialog.showModal();
  codeInput.focus();
}
$(".dialog-close").addEventListener("click", () => pairDialog.close());
pairDialog.addEventListener("cancel", (event) => {
  if (pairInProgress) event.preventDefault();
});
$("#pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pairInProgress) return;
  pairInProgress = true;
  update();
  const submit = $<HTMLButtonElement>("#pair-submit");
  submit.disabled = true;
  codeInput.disabled = true;
  $<HTMLButtonElement>(".dialog-close").disabled = true;
  submit.textContent = "Jumelage…";
  $("#pair-error").textContent = "";
  try {
    update(await request("pair", { index: pairIndex, code: codeInput.value }));
    codeInput.value = "";
    pairDialog.close();
  } catch (error) {
    $("#pair-error").textContent = String(error);
    codeInput.setAttribute("aria-invalid", "true");
  } finally {
    pairInProgress = false;
    submit.disabled = false;
    codeInput.disabled = false;
    $<HTMLButtonElement>(".dialog-close").disabled = false;
    submit.textContent = "Appairer";
    update();
    if (pairDialog.open) codeInput.focus();
  }
});
function openSettings() {
  lights.forEach(
    (light) => ($<HTMLInputElement>(`#name-${light.index}`).value = light.name),
  );
  $("#settings-error").textContent = "";
  if (!settingsDialog.open) settingsDialog.showModal();
}
$(".settings-close").addEventListener("click", () => settingsDialog.close());
$("#names-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("#names-form button");
  button.disabled = true;
  try {
    for (const light of [...lights]) {
      const name = $<HTMLInputElement>(`#name-${light.index}`).value.trim();
      if (name !== light.name)
        update(await request("rename", { index: light.index, name }));
    }
    settingsDialog.close();
  } catch (error) {
    $("#settings-error").textContent = String(error);
  } finally {
    button.disabled = false;
  }
});
async function hidePanel() {
  if (!native) return;
  const generation = ++visibilityGeneration,
    root = $("#app");
  oneShotAnimations.get(root)?.cancel();
  if (motionAllowed.matches) {
    const animation = root.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(4px) scale(.99)" },
      ],
      { duration: 130, easing: "ease-out", fill: "forwards" },
    );
    oneShotAnimations.set(root, animation);
    await animation.finished.catch(() => {});
  }
  if (generation === visibilityGeneration) await invoke("hide_window");
}
let resizeFrame = 0,
  lastPanelHeight = 0;
function resizePanel() {
  if (!native || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    let height = Math.ceil(
      $("main").scrollHeight -
        views.getBoundingClientRect().height +
        editorHeight +
        14,
    );
    for (const dialog of [pairDialog, settingsDialog])
      if (dialog.open) height = Math.max(height, dialog.scrollHeight + 40);
    height = Math.max(120, Math.min(560, height));
    if (motionAllowed.matches && performance.now() < shrinkUntil)
      height = Math.max(height, lastPanelHeight);
    if (Math.abs(height - lastPanelHeight) <= 1) return;
    lastPanelHeight = height;
    void invoke("resize_panel", { height }).catch((error) =>
      console.error("Redimensionnement du panneau", error),
    );
  });
}
const panelObserver = new ResizeObserver(resizePanel);
for (const selector of [
  ".bars",
  "#editor",
  "#message",
  "#pair-dialog",
  "#settings-dialog",
])
  panelObserver.observe($(selector));
const editorObserver = new ResizeObserver(() => syncEditor(editorOpen));
editorObserver.observe(editorInner);
editorObserver.observe(home);
const dialogObserver = new MutationObserver((records) => {
  for (const record of records) {
    const dialog = record.target as HTMLDialogElement;
    if (dialog.open) entrance(dialog);
  }
  resizePanel();
});
for (const dialog of [pairDialog, settingsDialog])
  dialogObserver.observe(dialog, {
    attributes: true,
    attributeFilter: ["open"],
  });
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !pairDialog.open &&
    !settingsDialog.open &&
    native
  )
    selected >= 0 ? closeEditor() : void hidePanel();
});
async function start() {
  if (!native) {
    update();
    return;
  }
  await listen<Light[]>("lights-state", (event) => {
    connected = true;
    update(event.payload);
  });
  await listen<string>("engine-error", (event) => {
    connected = false;
    pending.clear();
    confirmed = confirmed.map((light) => ({
      ...light,
      online: false,
      available: false,
      connecting: false,
    }));
    message(event.payload);
    update();
  });
  await listen("open-settings", openSettings);
  await listen("panel-hidden", () => {
    visibilityGeneration++;
    oneShotAnimations.get($("#app"))?.cancel();
    settingsDialog.close();
    if (!pairInProgress) pairDialog.close();
    for (const bar of bars) bar.card.classList.remove("dragging", "scrubbing");
    selected = -1;
    update();
  });
  await listen("panel-shown", () => {
    visibilityGeneration++;
    entrance($("#app"));
  });
  try {
    const state = await request("status");
    connected = true;
    update(state);
  } catch (error) {
    message(String(error));
    update();
  }
}
update();
void start();
requestAnimationFrame(() =>
  requestAnimationFrame(() => $("#app").classList.add("motion-ready")),
);
motionAllowed.addEventListener("change", () => {
  if (!motionAllowed.matches) {
    shrinkUntil = 0;
    clearTimeout(shrinkTimer);
    for (const animation of document.getAnimations()) animation.cancel();
  }
  syncEditor(editorOpen);
  resizePanel();
});
