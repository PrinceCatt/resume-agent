// What the logged model calls cost in RMB, priced by the time of each call: DeepSeek charges half outside
// its peak hours. Prices are DeepSeek's list for deepseek-chat / V4 Flash, per million tokens, as of
// 2026-11-14 (api-docs.deepseek.com/zh-cn/quick_start/pricing). An estimate: the DeepSeek console has the bill.
import { isPeak } from "../src/offpeak.ts";
import { all } from "./db.ts";

export const PRICE = {
  peak: { hit: 0.04, miss: 2, out: 8 },
  off: { hit: 0.02, miss: 1, out: 4 },
};

export type UsageRow = { prompt_tokens: number; cache_hit_tokens: number; completion_tokens: number; ts: string };

/** One call's cost in RMB. ts is UTC in SQLite's datetime('now') format. */
export function callRmb(r: UsageRow) {
  const p = isPeak(new Date(`${r.ts.replace(" ", "T")}Z`)) ? PRICE.peak : PRICE.off;
  const hit = Math.min(r.cache_hit_tokens, r.prompt_tokens);
  return ((r.prompt_tokens - hit) * p.miss + hit * p.hit + r.completion_tokens * p.out) / 1e6;
}

export function sumRmb(rows: UsageRow[]) {
  return rows.reduce((s, r) => s + callRmb(r), 0);
}

/** Tokens and RMB of the usage rows matching a WHERE clause (or all of them). */
export function usageRows(where = "", ...params: Array<string | number>) {
  return all<UsageRow & { kind: string }>(`SELECT kind, prompt_tokens, cache_hit_tokens, completion_tokens, ts FROM usage ${where}`, ...params);
}
