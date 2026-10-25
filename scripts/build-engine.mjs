import { build } from "esbuild";
import { mkdir, copyFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
await mkdir("engine/dist", { recursive: true });
await mkdir("src-tauri/resources", { recursive: true });
const result = await build({
  entryPoints: ["engine/bridge.ts"],
  outdir: "engine/dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  metafile: true,
  external: ["bun:sqlite"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
const outputs = new Set(
  Object.keys(result.metafile.outputs).map((file) => resolve(file)),
);
for (const file of await readdir("engine/dist")) {
  const path = join("engine/dist", file);
  if (file.endsWith(".mjs") && !outputs.has(resolve(path))) await unlink(path);
}
await copyFile(process.execPath, "src-tauri/resources/node.exe");
const licenseDir = "engine/dist/licenses";
await mkdir(licenseDir, { recursive: true });
if (process.versions.node === "24.15.0") {
  await copyFile(
    "third-party/Node-LICENSE.txt",
    join(licenseDir, "Node-LICENSE.txt"),
  );
} else {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  );
  if (!response.ok)
    throw new Error(
      "Impossible de récupérer la licence du runtime Node utilisé.",
    );
  await writeFile(join(licenseDir, "Node-LICENSE.txt"), await response.text());
}
const packages = new Set(
  Object.keys(result.metafile.inputs)
    .map((input) => {
      const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
      return match?.[1];
    })
    .filter(Boolean),
);
for (const name of packages) {
  const root = join("node_modules", name);
  for (const file of await readdir(root)) {
    if (/^(license|licence|notice)(\.|$)/i.test(file)) {
      await copyFile(
        join(root, file),
        join(licenseDir, `${name.replaceAll("/", "_")}-${file}`),
      );
    }
  }
}
await import("./collect-rust-licenses.mjs");
console.log("Moteur Matter et runtime local préparés.");
