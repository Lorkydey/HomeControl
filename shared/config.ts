export const lightIcons = [
  "bulb",
  "bed",
  "sofa",
  "kitchen",
  "desk",
  "sun",
  "keyboard",
  "pc",
] as const;
export type LightIcon = (typeof lightIcons)[number];
export interface AppConfig {
  version: 1;
  window: { width: number; margin: number; hideOnBlur: boolean };
  lights: {
    id: string;
    name: string;
    icon: LightIcon;
    source?: "matter" | "logitech" | "aura";
  }[];
}
export function defaultConfig(): AppConfig {
  return {
    version: 1,
    window: { width: 320, margin: 8, hideOnBlur: true },
    lights: [
      { id: "light-1", name: "Chambre", icon: "bed" },
      { id: "light-2", name: "Séjour", icon: "sofa" },
      { id: "light-3", name: "Cuisine", icon: "kitchen" },
    ],
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("La configuration doit contenir des objets JSON.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Option inconnue : ${key}.`);
}
export function validName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > 40 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(
      "Choisissez un nom de 1 à 40 caractères, sans caractères de contrôle.",
    );
  return value.trim();
}
export function parseConfig(value: unknown): AppConfig {
  const source = object(value);
  keys(source, ["version", "window", "lights"]);
  if (source.version !== 1)
    throw new Error("Version de configuration inconnue.");
  const window = object(source.window);
  keys(window, ["width", "margin", "hideOnBlur"]);
  if (
    !Number.isInteger(window.width) ||
    Number(window.width) < 280 ||
    Number(window.width) > 480
  )
    throw new Error("La largeur doit être un entier entre 280 et 480 pixels.");
  if (
    !Number.isInteger(window.margin) ||
    Number(window.margin) < 0 ||
    Number(window.margin) > 32
  )
    throw new Error("La marge doit être un entier entre 0 et 32 pixels.");
  if (typeof window.hideOnBlur !== "boolean")
    throw new Error("hideOnBlur doit être un booléen.");
  if (
    !Array.isArray(source.lights) ||
    source.lights.length < 1 ||
    source.lights.length > 8
  )
    throw new Error("Configurez entre une et huit lampes.");
  const ids = new Set<string>();
  const localSources = new Set<string>();
  const lights = source.lights.map((value) => {
    const light = object(value);
    keys(light, ["id", "name", "icon", "source"]);
    if (
      light.source !== undefined &&
      !["matter", "logitech", "aura"].includes(String(light.source))
    )
      throw new Error("Source de lumière inconnue.");
    if (light.source === "logitech" || light.source === "aura") {
      if (localSources.has(light.source))
        throw new Error(
          "Chaque source RGB locale ne peut apparaître qu’une fois.",
        );
      localSources.add(light.source);
    }
    if (
      typeof light.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(light.id) ||
      ids.has(light.id)
    )
      throw new Error(
        "Chaque lampe doit avoir un id unique : lettres minuscules, chiffres ou tirets (1 à 32 caractères).",
      );
    ids.add(light.id);
    if (!lightIcons.includes(light.icon as LightIcon))
      throw new Error("Icône de lampe inconnue.");
    return {
      id: light.id,
      name: validName(light.name),
      icon: light.icon as LightIcon,
      ...(light.source === undefined
        ? {}
        : {
            source: light.source as "matter" | "logitech" | "aura",
          }),
    };
  });
  return {
    version: 1,
    window: {
      width: Number(window.width),
      margin: Number(window.margin),
      hideOnBlur: window.hideOnBlur,
    },
    lights,
  };
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
