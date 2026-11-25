// Local development: API on :8791 (restarts when a server file changes) + Vite on :5191 (proxies /api).
// Note: an API restart drops the connection to your browser (and interrupts runs in progress);
// with the extension token saved in Settings it reconnects without asking on the next job.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const WEB_PORT = process.env.WEB_PORT ?? process.env.PORT ?? "5191";
const API_PORT = process.env.API_PORT ?? "8791";

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

function start(name, args, env) {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}] `;
  pipe(p.stdout, process.stdout, prefix);
  pipe(p.stderr, process.stderr, prefix);
  p.on("exit", (code) => {
    if (p.restarting || stopping) return;
    // A crashed API waits for the next edit (like node --watch did); Vite exiting ends dev.
    console.log(`${prefix}exited (${code})${name === "api" ? "; waiting for a change in server/" : ""}`);
    if (name !== "api") shutdown();
  });
  procs[name] = p;
  return p;
}

const startApi = () => start("api", ["--disable-warning=ExperimentalWarning", "server/index.ts"], { PORT: API_PORT });
startApi();
start("web", [path.join("node_modules", "vite", "bin", "vite.js")], { WEB_PORT, API_PORT });

// Restart the API only when a server file's contents change. node --watch-path restarted it
// whenever a file in server/ was merely read: on Windows the watcher also reports last-access
// updates, so a grep over server/ dropped the connection to your browser.
const serverDir = path.join(root, "server");
const seen = new Map();
const stamp = (f) => {
  try {
    const st = fs.statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
};
for (const f of fs.readdirSync(serverDir, { recursive: true })) seen.set(path.join(serverDir, String(f)), stamp(path.join(serverDir, String(f))));
let timer = null;
fs.watch(serverDir, { recursive: true }, (_event, file) => {
  if (!file || !/\.(ts|json)$/.test(file)) return;
  const full = path.join(serverDir, file);
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
