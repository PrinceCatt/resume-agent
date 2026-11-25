// Server-sent events: the UI refetches whatever a message names, so payloads stay tiny.
import type { Response } from "express";

const clients = new Set<Response>();

export function addClient(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type: "job" | "run" | "profile" | "settings" | "browser" | "schedule", id?: number) {
  const msg = `data: ${JSON.stringify({ type, id })}\n\n`;
  for (const c of clients) c.write(msg);
}
