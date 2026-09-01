/**
 * Start FastAPI dev server using the project venv (Windows + Linux/macOS).
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const root = path.join(__dirname, "..");
const isWin = process.platform === "win32";
const host = "127.0.0.1";
const preferredPort = Number(process.env.PORT || 8080);
const python = isWin
  ? path.join(root, "venv", "Scripts", "python.exe")
  : path.join(root, "venv", "bin", "python");

if (!fs.existsSync(python)) {
  console.error("Python venv not found.");
  console.error("");
  console.error("Create it once:");
  if (isWin) {
    console.error("  python -m venv venv");
    console.error("  venv\\Scripts\\pip install -r requirements.txt");
  } else {
    console.error("  python3 -m venv venv");
    console.error("  venv/bin/pip install -r requirements.txt");
  }
  console.error("");
  console.error("Then run: npm run dev");
  process.exit(1);
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    if (isWin) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portListeners(portNumber) {
  if (!isWin) return [];
  try {
    const out = execSync(`netstat -ano | findstr ":${portNumber}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

function canBind(portNumber) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(portNumber, host);
  });
}

async function findFreePort(startPort, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    if (await canBind(candidate)) return candidate;
  }
  return null;
}

async function main() {
  let port = preferredPort;
  const bindable = await canBind(port);

  if (!bindable) {
    const listeners = portListeners(port).filter(pidAlive);
    const ghostOnly = portListeners(port).filter((pid) => !pidAlive(pid));

    console.warn("");
    if (listeners.length) {
      console.warn(`Port ${port} is in use (PID: ${listeners.join(", ")}).`);
      if (isWin) {
        console.warn("Stop it with:");
        for (const pid of listeners) {
          console.warn(`  taskkill /PID ${pid} /F`);
        }
      } else {
        console.warn(`  kill ${listeners.join(" ")}`);
      }
    }
    if (ghostOnly.length) {
      console.warn(
        `Port ${port} looks stuck (ghost socket from PID ${ghostOnly.join(", ")}).`
      );
    }

    const fallback = await findFreePort(port + 1);
    if (!fallback) {
      console.error(`No free port found near ${port}.`);
      process.exit(1);
    }

    console.warn(`Using http://${host}:${fallback}/ instead.`);
    console.warn("");
    port = fallback;
  }

  console.log(`Starting dev server at http://${host}:${port}/`);

  const args = [
    "-m",
    "uvicorn",
    "main:app",
    "--host",
    host,
    "--port",
    String(port),
    "--reload",
  ];

  const child = spawn(python, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

main();
