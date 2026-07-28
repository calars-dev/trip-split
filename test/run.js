// Runs every *.test.js in this folder. `npm test`
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
let failed = 0;

for (const f of files) {
  console.log("\n════════ " + f + " ════════");
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });
  // jsdom prints "Not implemented: window.scrollTo" for things it doesn't emulate
  process.stdout.write((r.stdout || "").split("\n").filter((l) => !/Not implemented/.test(l)).join("\n"));
  if (r.status !== 0) {
    failed++;
    process.stderr.write(r.stderr || "");
  }
}

console.log("\n════════════════════════════");
console.log(failed ? `${failed}/${files.length} 파일 실패` : `${files.length}개 파일 전부 통과`);
process.exit(failed ? 1 : 0);
