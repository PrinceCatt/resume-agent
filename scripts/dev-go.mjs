// Local development with the Go backend: builds go/ and runs it as the API on :8791 (rebuilt and
// restarted when a .go file changes) + Vite on :5191 (proxies /api), like scripts/dev.mjs does for the
// Node server. Needs Go on PATH, or GO=<path to go executable>.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const goDir = path.join(root, "go");
const WEB_PORT = process.env.WEB_PORT ?? process.env.PORT ?? "5191";
const API_PORT = process.env.API_PORT ?? "8791";
const GO = process.env.GO ?? "go";
const bin = path.join(goDir, process.platform === "win32" ? "resume-agent.exe" : "resume-agent");

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
  p.on("error", (e) => console.log(`${prefix}${e.message}`));
  p.on("exit", (code) => {
    if (p.restarting || stopping) return;
    console.log(`${prefix}exited (${code})${name === "api" ? "; waiting for a change in go/" : ""}`);
    if (name !== "api") shutdown();
  });
  procs[name] = p;
  return p;
}

function build() {
  const r = spawnSync(GO, ["build", "-o", bin, "."], { cwd: goDir, env: process.env, encoding: "utf8" });
  if (r.error) {
    console.log(`[api] cannot run ${GO}: ${r.error.message} (put Go on PATH or set GO=<path to go executable>)`);
    return false;
  }
  if (r.status !== 0) {
    process.stdout.write(
      (r.stderr || r.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => `[api] ${l}\n`)
        .join(""),
    );
    console.log("[api] build failed; waiting for a change in go/");
    return false;
  }
  return true;
}

const startApi = () => {
  if (build()) start("api", bin, [], { PORT: API_PORT });
};
startApi();
start("web", process.execPath, [path.join("node_modules", "vite", "bin", "vite.js")], { WEB_PORT, API_PORT });

// Rebuild only when a .go file's contents change (the Windows watcher also reports reads).
const seen = new Map();
const stamp = (f) => {
  try {
    const st = fs.statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
};
for (const f of fs.readdirSync(goDir, { recursive: true })) seen.set(path.join(goDir, String(f)), stamp(path.join(goDir, String(f))));
let timer = null;
fs.watch(goDir, { recursive: true }, (_event, file) => {
  if (!file || !/\.(go|js)$/.test(file) || /_test\.go$/.test(file)) return;
  const full = path.join(goDir, file);
  const now = stamp(full);
  if (seen.get(full) === now) return;
  seen.set(full, now);
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[api] ${file} changed, rebuilding`);
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
