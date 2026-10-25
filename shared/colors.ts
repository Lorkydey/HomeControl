export function hsvToHex(hue: number, saturation: number, value = 100): string {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const v = Math.max(0, Math.min(100, value)) / 100;
  const c = v * s,
    x = c * (1 - Math.abs((h % 2) - 1)),
    m = v - c;
  const rgb =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  return (
    "#" +
    rgb
      .map((n) =>
        Math.round((n + m) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function hexToHsv(hex: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hex))
    throw new Error("Saisissez une couleur au format #RRGGBB.");
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const hue = !delta
    ? 0
    : 60 *
      (max === r
        ? ((g - b) / delta + 6) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4);
  return {
    hue,
    saturation: max ? (delta / max) * 100 : 0,
    brightness: max * 100,
  };
}
export function hsvToXy(hue: number, saturation: number) {
  const hex = hsvToHex(hue, saturation);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  });
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const sum = x + y + z;
  return { x: sum ? x / sum : 0.3127, y: sum ? y / sum : 0.329 };
}
export function xyToHsv(x: number, y: number) {
  if (y <= 0) return { hue: 0, saturation: 0 };
  const X = x / y,
    Z = (1 - x - y) / y;
  let rgb = [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
  const max = Math.max(...rgb, 1);
  rgb = rgb
    .map((c) => Math.max(0, c / max))
    .map((c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c));
  return hexToHsv(
    "#" +
      rgb
        .map((c) =>
          Math.round(Math.min(1, c) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join(""),
  );
}
