// Local development with the Python backend (py/): API on :8791 (restarts when a file in py/resume_agent
// changes) + Vite on :5191 (proxies /api). Same ports and env vars as scripts/dev.mjs: WEB_PORT, API_PORT.
// Needs the virtualenv once: cd py && uv sync
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const WEB_PORT = process.env.WEB_PORT ?? process.env.PORT ?? "5191";
const API_PORT = process.env.API_PORT ?? "8791";
const pyDir = path.join(root, "py");
const venvPython = path.join(pyDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

let stopping = false;
const procs = {};

function pipe(stream, out, prefix) {
  stream.on("data", (d) =>
    out.write(
      d
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => prefix + l)
        .join("\n") + "\n",
    ),
  );
}

function start(name, cmd, args, env, cwd = root) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}] `;
  pipe(p.stdout, process.stdout, prefix);
  pipe(p.stderr, process.stderr, prefix);
  p.on("error", (e) => console.log(`${prefix}could not start: ${e.message}`));
  p.on("exit", (code) => {
    if (p.restarting || stopping) return;
    // A crashed API waits for the next edit; Vite exiting ends dev.
    console.log(`${prefix}exited (${code})${name === "api" ? "; waiting for a change in py/resume_agent/" : ""}`);
    if (name !== "api") shutdown();
  });
  procs[name] = p;
  return p;
}

// The virtualenv's interpreter when it exists, otherwise uv (which creates it on first run).
const [pyCmd, pyArgs] = fs.existsSync(venvPython) ? [venvPython, ["-m", "resume_agent"]] : ["uv", ["run", "python", "-m", "resume_agent"]];
const startApi = () => start("api", pyCmd, pyArgs, { PORT: API_PORT, PYTHONUNBUFFERED: "1" }, pyDir);
startApi();
start("web", process.execPath, [path.join("node_modules", "vite", "bin", "vite.js")], { WEB_PORT, API_PORT });

// Restart the API only when a source file's contents change (Windows also reports last-access updates).
const srcDir = path.join(pyDir, "resume_agent");
const seen = new Map();
const stamp = (f) => {
  try {
    const st = fs.statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
};
for (const f of fs.readdirSync(srcDir, { recursive: true })) seen.set(path.join(srcDir, String(f)), stamp(path.join(srcDir, String(f))));
let timer = null;
fs.watch(srcDir, { recursive: true }, (_event, file) => {
  if (!file || !/\.(py|js)$/.test(file)) return;
  const full = path.join(srcDir, file);
  const now = stamp(full);
  if (seen.get(full) === now) return;
  seen.set(full, now);
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[api] ${file} changed, restarting`);
    const old = procs.api;
    if (old && old.exitCode === null) {
      old.restarting = true;
      old.once("exit", startApi);
      old.kill();
    } else startApi();
  }, 300);
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of Object.values(procs)) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
