// DeepSeek through its OpenAI-compatible chat completions API. Any other OpenAI-compatible
// endpoint works by changing baseUrl/model in settings.
import { getSettings } from "./settings.ts";
import { run } from "./db.ts";
import { emit } from "./events.ts";

/** What a call was for, so token use can be shown per job. */
export type UsageTag = { jobId?: number | null; kind: "parse" | "tailor" | "apply" | "import" | "test" | "prep" | "email" };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: object } };

export class LlmError extends Error {}

export type LlmState = { ok: true } | { ok: false; reason: string; code: "no_key" | "no_balance" };

/**
 * Set when DeepSeek answered 402 or its balance endpoint says the account cannot be used. Until it clears
 * (a call that works, a balance check that shows money, a new key), nothing calls the model: on 2026-11-13
 * an empty balance failed every queued job one by one with the same error.
 */
let noBalance: { balance: string } | null = null;

export function llmReady(): LlmState {
  const s = getSettings();
  if (s.llmMode === "demo") return { ok: true };
  if (!s.apiKey) return { ok: false, code: "no_key", reason: "No DeepSeek API key yet: add one in Settings, or switch to demo mode first." };
  if (noBalance)
    return {
      ok: false,
      code: "no_balance",
      reason: `DeepSeek balance is too low${noBalance.balance ? ` (${noBalance.balance})` : ""}: top up, then click "Topped up, continue" on the Jobs page.`,
    };
  return { ok: true };
}

export function setNoBalance(balance: string | null) {
  const was = !!noBalance;
  noBalance = balance === null ? null : { balance };
  if (was !== !!noBalance) emit("settings");
}

export type Balance = { available: boolean; total: number; currency: string };
let balanceCache: { at: number; key: string; value: Balance | null } | null = null;

export const money = (b: Balance) => `${b.currency === "USD" ? "$" : "¥"}${b.total.toFixed(2)}`;

/** DeepSeek's balance (a free call). null for other providers, demo mode, no key, or when it cannot be read. */
export async function getBalance(fresh = false): Promise<Balance | null> {
  const s = getSettings();
  if (s.llmMode !== "deepseek" || !s.apiKey || !/(^|\.)deepseek\.com$/.test(hostOf(s.baseUrl))) return null;
  if (!fresh && balanceCache && balanceCache.key === s.apiKey && Date.now() - balanceCache.at < 60_000) return balanceCache.value;
  let value: Balance | null = null;
  try {
    const res = await fetch(`${s.baseUrl.replace(/\/+$/, "")}/user/balance`, {
      headers: { Authorization: `Bearer ${s.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const b = (await res.json()) as any;
      const infos: any[] = Array.isArray(b?.balance_infos) ? b.balance_infos : [];
      const info = infos.find((i) => i?.currency === "CNY") ?? infos[0];
      value = { available: b?.is_available === true, total: Number(info?.total_balance) || 0, currency: String(info?.currency ?? "CNY") };
    }
  } catch {
    /* offline or the endpoint moved: say nothing rather than block */
  }
  balanceCache = { at: Date.now(), key: s.apiKey, value };
  if (value) setNoBalance(value.available ? null : money(value));
  return value;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isDemo() {
  return getSettings().llmMode === "demo";
}

export async function chat(opts: {
  messages: Message[];
  tools?: ToolDef[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  usage?: UsageTag;
}): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const s = getSettings();
  if (!s.apiKey) throw new LlmError("No API key");
  const body: Record<string, unknown> = {
    model: s.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${s.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new LlmError(`Model API ${res.status}`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        const hint = res.status === 401 ? " (wrong API key)" : res.status === 402 ? " (balance too low)" : "";
        if (res.status === 402) setNoBalance(noBalance?.balance ?? "");
        throw new LlmError(`Model API ${res.status}${hint}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as any;
      if (noBalance) setNoBalance(null);
      recordUsage(opts.usage, data.usage);
      const msg = data.choices?.[0]?.message ?? {};
      return { content: msg.content ?? "", toolCalls: msg.tool_calls ?? [] };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

function recordUsage(tag: UsageTag | undefined, u: any) {
  if (!u) return;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
  try {
    run(
      "INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (?, ?, ?, ?, ?)",
      tag?.jobId ?? null,
      tag?.kind ?? "test",
      n(u.prompt_tokens),
      n(u.completion_tokens),
      n(u.prompt_cache_hit_tokens),
    );
  } catch {
    // The job may have been deleted while the call was running.
    try {
      run("INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (NULL, ?, ?, ?, ?)", tag?.kind ?? "test", n(u.prompt_tokens), n(u.completion_tokens), n(u.prompt_cache_hit_tokens));
    } catch {
      /* never let bookkeeping break a call */
    }
  }
}

/** JSON-mode call; tolerates a fenced block. */
export async function chatJson<T>(system: string, user: string, maxTokens = 4096, usage?: UsageTag): Promise<T> {
  const { content } = await chat({
    messages: [
      // JSON mode needs the word "json" in the prompt. Output costs four times what uncached input does, and
      // pretty-printed JSON spends a token or so per line on line breaks and indentation.
      { role: "system", content: `${system}\n\nRespond with a single json object, minified: no line breaks or indentation.` },
      { role: "user", content: user },
    ],
    json: true,
    maxTokens,
    usage,
  });
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`The model did not return valid JSON: ${text.slice(0, 200)}`);
  }
}
