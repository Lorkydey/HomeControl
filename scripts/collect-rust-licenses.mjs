import { execFileSync } from "node:child_process";
import { mkdir, readdir, copyFile, writeFile, access } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
const used = new Set(metadata.resolve.nodes.map((node) => node.id));
const output = "engine/dist/licenses/rust";
await mkdir(output, { recursive: true });
const notices = [];
for (const pkg of metadata.packages.filter(
  (pkg) => pkg.source && used.has(pkg.id),
)) {
  const root = dirname(pkg.manifest_path);
  const licenses = (await readdir(root)).filter((file) =>
    /^(?:licen[cs]e|copying|copyright|notice)(?:[-_.]|$)/i.test(file),
  );
  if (pkg.license_file && !licenses.includes(pkg.license_file))
    licenses.push(pkg.license_file);
  const included = [];
  for (const file of licenses) {
    try {
      await access(join(root, file));
      const name = `${pkg.name}-${pkg.version}-${basename(file)}`;
      await copyFile(join(root, file), join(output, name));
      included.push(name);
    } catch (error) {
      if (!["EISDIR", "EPERM"].includes(error.code)) throw error;
    }
  }
  notices.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    licenseFiles: included,
  });
}
await writeFile(
  join(output, "dependencies.json"),
  `${JSON.stringify(notices, null, 2)}\n`,
);
await copyFile("LICENSE", "engine/dist/licenses/Home-Control-LICENSE.txt");
console.log(`Rust dependency notices collected (${notices.length} packages).`);
