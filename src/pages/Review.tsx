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
          <h1 className="text-xl font-semibold tracking-tight">待处理</h1>
          <p className="mt-1 text-sm text-muted">填好的申请在这里等你确认；助手不知道怎么填、或需要你登录时也会停在这里。</p>
        </div>
        {confirmable.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              className="text-sm text-brand-700 hover:underline"
              onClick={() => setSel(chosen.length === confirmable.length ? new Set() : new Set(confirmable.map((r) => r.id)))}
            >
              {chosen.length === confirmable.length ? "取消全选" : "全选"}
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
                  `已确认 ${chosen.length} 份`,
                )
              }
            >
              确认提交所选（{chosen.length}）
            </Button>
          </div>
        )}
      </header>

      {data && !confirmable.length && !asks.length && !working.length && <Empty title="没有要处理的">新的申请填好后会出现在这里。</Empty>}

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
        {working.length > 0 && <div className="pt-2 text-sm font-medium text-muted">正在进行</div>}
        {working.map((r) => (
          <RunCard key={r.id} run={r} />
        ))}
      </div>
    </div>
  );
}
