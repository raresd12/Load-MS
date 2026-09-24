import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => /^verify-.*\.mjs$/.test(name))
  .sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${file}`);
  } else {
    console.log(`ok   ${file}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} verification scripts passed`);
process.exit(failed ? 1 : 0);
