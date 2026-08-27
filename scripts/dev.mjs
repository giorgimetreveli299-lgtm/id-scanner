/**
 * Start FastAPI (ID/Passport :8080) and Next.js (hub + Driver License :3000).
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const uvicornWin = path.join(root, "venv", "Scripts", "uvicorn.exe");
const uvicornUnix = path.join(root, "venv", "bin", "uvicorn");
const uvicorn = fs.existsSync(uvicornWin)
  ? uvicornWin
  : fs.existsSync(uvicornUnix)
    ? uvicornUnix
    : "uvicorn";

const children = [];

function start(command, args, label) {
  console.log(`[${label}] ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${label}] stopped (code=${code}, signal=${signal})`);
    shutdown(code ?? 1);
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("ID/Passport API → http://127.0.0.1:8080");
console.log("Verification hub → http://localhost:3000");
start(uvicorn, ["main:app", "--host", "127.0.0.1", "--port", "8080", "--reload"], "api");
start("npx", ["next", "dev"], "web");
