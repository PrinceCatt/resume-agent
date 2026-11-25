import { useState } from "react";
import { api, useApi, type RunView } from "../api.ts";
import { RunCard } from "../components/RunCard.tsx";
import { Button, Empty, useAction } from "../components/ui.tsx";

export default function ReviewPage() {
  const { data } = useApi<{ runs: RunView[] }>("/runs?active=1", ["run"]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const { busy, run } = useAction();
  const runs = data?.runs ?? [];
  const confirmable = runs.filter((r) => r.status === "awaiting_confirm");
  const asks = runs.filter((r) => r.status === "need_user");
  const working = runs.filter((r) => r.status === "running" || r.status === "queued");
  const chosen = confirmable.filter((r) => sel.has(r.id));

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Waiting for you</h1>
          <p className="mt-1 text-sm text-muted">Filled-in applications wait here for your confirmation. The agent also stops here when it doesn't know what to enter or needs you to sign in.</p>
        </div>
        {confirmable.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              className="text-sm text-brand-700 hover:underline"
              onClick={() => setSel(chosen.length === confirmable.length ? new Set() : new Set(confirmable.map((r) => r.id)))}
            >
              {chosen.length === confirmable.length ? "Select none" : "Select all"}
            </button>
            <Button
              variant="primary"
              disabled={!chosen.length}
              busy={busy === "batch"}
              onClick={() =>
                run(
                  "batch",
                  async () => {
                    for (const r of chosen) await api(`/runs/${r.id}/reply`, { body: { type: "confirm" } });
                    setSel(new Set());
                  },
                  `Confirmed ${chosen.length}`,
                )
              }
            >
              Submit selected ({chosen.length})
            </Button>
          </div>
        )}
      </header>

      {data && !confirmable.length && !asks.length && !working.length && <Empty title="Nothing waiting">New applications show up here once they are filled in.</Empty>}

      <div className="space-y-4">
        {asks.map((r) => (
          <RunCard key={r.id} run={r} />
        ))}
        {confirmable.map((r) => (
          <RunCard
            key={r.id}
            run={r}
            selectable={confirmable.length > 1}
            selected={sel.has(r.id)}
            onSelect={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(r.id); else n.delete(r.id); return n; })}
          />
        ))}
        {working.length > 0 && <div className="pt-2 text-sm font-medium text-muted">In progress</div>}
        {working.map((r) => (
          <RunCard key={r.id} run={r} />
        ))}
      </div>
    </div>
  );
}
