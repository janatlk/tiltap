const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getGitInfo() {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    const message = execSync("git log -1 --pretty=%s", { encoding: "utf-8" }).trim();
    return { commit, message };
  } catch {
    return { commit: "unknown", message: "unknown" };
  }
}

const info = {
  builtAt: new Date().toISOString(),
  ...getGitInfo(),
};

const webDir = path.join(__dirname, "..", "public", "web");
const distWebDir = path.join(__dirname, "..", "dist", "public", "web");

for (const dir of [webDir, distWebDir]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify(info, null, 2));
}

console.log("Wrote build-info.json", info);
