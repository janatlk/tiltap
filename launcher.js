const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function startDetached(name, cmd, args) {
  const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
  const err = fs.openSync(path.join(logDir, `${name}.log`), "a");

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: __dirname,
    env: process.env,
  });

  child.unref();
  fs.writeFileSync(path.join(__dirname, `${name}.pid`), String(child.pid));
  console.log(`[Launcher] Started ${name} with PID ${child.pid}`);
  return child.pid;
}

// Kill any previous instances
["server", "poller"].forEach((name) => {
  const pidFile = path.join(__dirname, `${name}.pid`);
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // check if running
        console.log(`[Launcher] Killing old ${name} PID ${pid}`);
        process.kill(pid, "SIGTERM");
      } catch {
        // already dead
      }
    }
  } catch {
    // no pid file
  }
});

// Wait a moment for old processes to die
setTimeout(() => {
  const serverPid = startDetached("server", process.execPath, [path.join(__dirname, "dist", "server.js")]);
  const pollerPid = startDetached("poller", process.execPath, [
    path.join(__dirname, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(__dirname, "poller.ts"),
  ]);

  console.log("[Launcher] Both processes started. Exiting.");
  process.exit(0);
}, 2000);
