import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (!files.length) throw new Error("No tracked files to inspect.");
const privatePath =
  /(^|\/)(?:node_modules|target|resources|matter|dist|\.preview|test-results|playwright-report)(\/|$)|(^|\/)(?:config|lights)\.json(?:\.|$)|\.env(?:\.|$)|\.(?:pem|key|pfx|p12)$/i;
const secret =
  /(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const file of files) {
  if (privatePath.test(file))
    throw new Error(`Private or generated path tracked: ${file}`);
  if (statSync(file).size > 2_000_000)
    throw new Error(`Unexpected large source file: ${file}`);
  if (!/\.(?:png|ico)$/.test(file)) {
    const text = readFileSync(file, "utf8");
    if (secret.test(text))
      throw new Error(`Credential-like content in ${file}`);
    if (
      !file.endsWith(".test.ts") &&
      [...text.matchAll(/\b\d{4}[- ]\d{3}[- ]\d{4}\b/g)].some(
        ([match]) => match.replace(/\D/g, "") !== "00000000000",
      )
    )
      throw new Error(`Matter pairing-code-like content in ${file}`);
  }
}
console.log(
  `Public source check passed (${files.length} files). This supplements manual review; it is not a complete secret scanner.`,
);
