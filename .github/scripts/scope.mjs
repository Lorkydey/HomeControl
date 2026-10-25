import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const { BASE_SHA, HEAD_SHA, GITHUB_OUTPUT } = process.env;
let docsOnly = false;
if (
  /^[a-f0-9]{40}$/.test(BASE_SHA ?? "") &&
  /^[a-f0-9]{40}$/.test(HEAD_SHA ?? "")
) {
  const files = execFileSync(
    "git",
    ["diff", "--name-only", BASE_SHA, HEAD_SHA],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  docsOnly =
    files.length > 0 &&
    files.every((file) =>
      /^(?:README\.md|LICENSE|(?:CONTRIBUTING|SECURITY|THIRD_PARTY_NOTICES)\.md|docs\/.+\.(?:md|png))$/.test(
        file,
      ),
    );
}
appendFileSync(GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
console.log(
  docsOnly ? "Documentation checks only" : "Full Windows validation required",
);
