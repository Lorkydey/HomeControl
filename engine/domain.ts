export function slotIndex(value: unknown, count = 3): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= count)
    throw new Error("Choisissez une des lampes configur\u00e9es.");
  return Number(value);
}
export function bounded(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Choisissez une valeur entre ${min} et ${max}.`);
  return Math.round(value);
}
export function pairingCode(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Saisissez le code de jumelage Apple Maison.");
  const code = value.trim().replace(/[\s-]/g, "");
  if (
    !/^\d{11}$/.test(code) &&
    !/^\d{21}$/.test(code) &&
    !/^MT:[0-9A-Z.\-+ /]+$/i.test(value.trim())
  ) {
    throw new Error(
      "Saisissez les 11 chiffres du code de jumelage, ou le contenu du QR code Matter.",
    );
  }
  return value.trim().startsWith("MT:") ? value.trim() : code;
}
