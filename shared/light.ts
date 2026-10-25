export interface Light {
  index: number;
  name: string;
  paired: boolean;
  online: boolean;
  available?: boolean;
  connecting: boolean;
  on: boolean | null;
  brightness: number | null;
  temperature: number | null;
  dimmable: boolean;
  tunable: boolean;
  minKelvin: number;
  maxKelvin: number;
  color: boolean;
  colorMode: "white" | "color";
  hue: number;
  saturation: number;
  hex: string;
}
