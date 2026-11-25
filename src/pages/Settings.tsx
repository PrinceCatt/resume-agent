import { useEffect, useState } from "react";
import { api, pref, rmb, tokens, useApi, type AppState, type Balance, type PublicSettings, type Usage, type UsageSum } from "../api.ts";
import { Button, Card, Field, Icon, inputCls, toast, useAction } from "../components/ui.tsx";

const KIND: Record<string, string> = { parse: "读取岗位", tailor: "改简历", apply: "填表", prep: "面试准备", email: "写邮件", import: "导入简历", test: "测试连接" };

function NotifyCard() {
  const supported = typeof Notification !== "undefined";
  const [on, setOn] = useState(() => pref.get("notify") === "1");
  const [perm, setPerm] = useState(() => (supported ? Notification.permission : "denied"));
  const toggle = async (want: boolean) => {
    if (want && supported && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== "granted") {
        toast("浏览器没有允许通知；可以在地址栏左边的站点设置里打开", "err");
        return;
      }
    }
    pref.set("notify", want ? "1" : "0");
    setOn(want);
    if (want) new Notification("投递助手", { body: "通知已打开：申请等你确认或回答时会这样提醒你。" });
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <Icon name="bell" className="size-4 text-stone-400" />
        通知
      </h2>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-brand-600" disabled={!supported} checked={on && perm === "granted"} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          有申请填好等你确认、或者要你回答问题时，弹系统通知；面试、笔试开始前一小时，投递截止前一天，也会提醒
          <span className="block text-xs text-muted">
            {!supported ? "这个浏览器不支持通知。" : perm === "denied" ? "浏览器拦了这个页面的通知，要先在站点设置里允许。" : "等你处理的申请只在这个页面不在前台时弹；标签页标题上也会显示数量。要保持这个页面开着才会提醒。"}
          </span>
        </span>
      </label>
    </Card>
  );
}

/** DeepSeek's balance, read from its free balance endpoint (nothing shows for other providers or demo mode). */
function BalanceLine() {
  const { data } = useApi<{ balance: Balance | null }>("/balance", ["settings"]);
  const b = data?.balance;
  if (!b) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${b.available ? "text-muted" : "text-red-700"}`}>
      <span>
        账户余额：<span className="font-medium tabular-nums">{b.currency === "USD" ? "$" : "¥"}{b.total.toFixed(2)}</span>
        {!b.available && "，不够用了：读取、改简历、填表都会先停下"}
      </span>
      <a className="text-brand-700 hover:underline" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">
        去 DeepSeek 后台充值
      </a>
    </div>
  );
}

function UsageCard() {
  const { data } = useApi<Usage>("/usage", ["job", "run"]);
  if (!data) return null;
  const cell = (label: string, u: UsageSum) => (
    <div className="rounded-md bg-paper px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        约 {rmb(u.rmb)} <span className="text-sm font-normal text-muted">· {tokens(u.input + u.output)} tokens</span>
      </div>
      <div className="text-xs text-muted tabular-nums">
        {u.calls} 次 · 输入 {tokens(u.input)}
        {u.cached > 0 && `（缓存 ${tokens(u.cached)}）`} · 输出 {tokens(u.output)}
      </div>
    </div>
  );
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">模型用量</h2>
        <a className="text-xs text-brand-700 hover:underline" href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer">
          DeepSeek 后台看花费
        </a>
      </div>
      {data.total.calls === 0 ? (
        <p className="text-sm text-muted">还没有调用过模型（演示模式不算）。</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            {cell("今天", data.today)}
            {cell("本月", data.month)}
            {cell("一共", data.total)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {data.byKind.map((k) => (
              <span key={k.kind}>
                {KIND[k.kind] ?? k.kind}：约 {rmb(k.rmb)} · {tokens(k.tokens)}（{k.calls} 次）
              </span>
            ))}
          </div>
          <p className="text-xs text-stone-400">钱数按 DeepSeek 2026 年 11 月的价目、每次调用所在的时段（高峰 / 闲时）估算，以 DeepSeek 后台的账单为准。</p>
        </>
      )}
    </Card>
  );
}

type SaveFn = (patch: Partial<PublicSettings> & { apiKey?: string; extensionToken?: string }, ok?: string) => Promise<unknown>;

function BrowserCard({ data, s, save, busy, run, token, setToken }: {
  data: AppState;
  s: PublicSettings;
  save: SaveFn;
  busy: string | null;
  run: (name: string, fn: () => Promise<unknown>, ok?: string) => Promise<unknown>;
  token: string;
  setToken: (v: string) => void;
}) {
  const b = data.browser;
  const which = s.browserChannel === "chrome" ? "Chrome" : "Edge";
  const status =
    b.status === "on"
      ? { dot: "bg-brand-500", text: `已连上你的 ${which}` }
      : b.status === "waiting"
        ? { dot: "bg-amber-400", text: b.tokenSet ? `正在连接你的 ${which}…` : `等你在 ${which} 里点允许：它打开了一个 Playwright 的连接页` }
        : { dot: "bg-stone-300", text: `没连上 ${which}` };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-medium">浏览器</h2>
      <p className="text-sm text-muted">
        助手在你平时用的 {which} 里开新标签页填表（归在一个标签组里），用的就是你已经登录的账号，不会另开窗口。连接靠装在 {which} 里的 Playwright Extension（微软出的扩展）。遇到验证码、人机验证、Singpass、建账号这类步骤，助手会停下来叫你。
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className={`size-2 shrink-0 rounded-full ${status.dot}`} />
          {status.text}
        </span>
        <Button
          size="sm"
          variant={b.status === "on" ? undefined : "primary"}
          busy={busy === "connect"}
          onClick={() => void run("connect", () => api("/browser/open", { body: {} }))}
        >
          {b.status === "on" ? "重新连接" : b.status === "waiting" ? "重新打开连接页" : "连接"}
        </Button>
      </div>
      {b.error && b.status !== "on" && <p className="text-sm text-red-700">{b.error}</p>}
      {b.status !== "on" && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            在 {which} 里打开{" "}
            <a className="text-brand-700 underline" href={b.extensionUrl} target="_blank" rel="noreferrer">
              Playwright Extension
            </a>{" "}
            安装：它在 Chrome 应用商店里（商店页面上有时叫 Playwright MCP Bridge），Edge 自己的扩展商店搜不到。页面顶上 Edge 会问是否允许来自其他商店的扩展，选允许，再点「获取」。只装一次。
          </li>
          <li>点上面的「连接」：{which} 里会打开扩展的连接页，在上面点允许。</li>
          <li>可选：点工具栏里 Playwright Extension 的图标（在拼图图标里），状态页上有令牌，复制后填到下面，以后不用每次点允许。</li>
        </ol>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="用哪个浏览器" hint="你平时用、已经登录各个网站的那个">
          <select className={inputCls} value={s.browserChannel} onChange={(e) => save({ browserChannel: e.target.value as PublicSettings["browserChannel"] })}>
            <option value="msedge">Microsoft Edge</option>
            <option value="chrome">Google Chrome</option>
          </select>
        </Field>
        <Field label="扩展令牌（可选）" hint={s.hasExtensionToken ? "已保存；连接时不用再点允许" : "点工具栏里 Playwright Extension 的图标，会打开它的状态页；点复制，整行粘贴到这里"}>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder={s.hasExtensionToken ? "已保存（输入新的会替换）" : "粘贴令牌"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            {token.trim() ? (
              <Button busy={busy === "save"} onClick={() => save({ extensionToken: token.trim() }, "令牌已保存").then(() => setToken(""))}>
                保存
              </Button>
            ) : (
              s.hasExtensionToken && (
                <Button busy={busy === "save"} onClick={() => save({ extensionToken: "" }, "令牌已清除")}>
                  清除
                </Button>
              )
            )}
          </div>
        </Field>
      </div>
      {data.sites.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="text-sm font-medium">新加坡常用的招聘网站</div>
          <p className="mt-0.5 text-xs text-muted">
            在你的 {which} 里登录过就行，助手用的是同一个登录状态。验证码、人机验证、Singpass 都要你自己来，助手不会去绕过。
          </p>
          <ul className="mt-3 divide-y divide-line rounded-md border border-line">
            {data.sites.map((site) => (
              <li key={site.key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{site.name}</div>
                  <div className="text-xs text-muted">{site.note}</div>
                </div>
                <a className="text-sm text-brand-700 hover:underline" href={site.login} target="_blank" rel="noreferrer">
                  打开登录页
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-400">
            LinkedIn、JobStreet 这些网站的用户协议一般不允许自动化工具，用多了账号有被限制的风险，而这里用的是你自己的账号。每份都是你确认才提交；量别太大，「同时填几份」设 1 最稳。
          </p>
        </div>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const { data, reload } = useApi<AppState>("/state", ["settings", "browser"]);
  const [s, setS] = useState<PublicSettings | null>(null);
  const [key, setKey] = useState("");
  const [token, setToken] = useState("");
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  if (!s || !data) return null;

  const save = (patch: Partial<PublicSettings> & { apiKey?: string; extensionToken?: string }, ok = "已保存") =>
    run("save", async () => {
      await api("/settings", { method: "PUT", body: patch });
      await reload();
    }, ok);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted">所有数据（资料库、岗位、截图、API key）都只存在这台电脑的 resume-agent/data 文件夹里。网站的登录状态在你自己的浏览器里，助手不保存。</p>
      </header>

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">模型</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["deepseek", "DeepSeek", "真正读岗位、改简历、看懂各种申请表"],
              ["demo", "演示模式", "不调用模型，只能填简单表单，用来熟悉流程"],
            ] as const
          ).map(([v, label, desc]) => (
            <button
              key={v}
              onClick={() => save({ llmMode: v }, v === "demo" ? "已切到演示模式" : "已切到 DeepSeek")}
              className={`rounded-md border px-3 py-2.5 text-left ${s.llmMode === v ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-line hover:bg-paper"}`}
            >
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted">{desc}</div>
            </button>
          ))}
        </div>
        <Field label="DeepSeek API key" hint={<>在 platform.deepseek.com 的「API keys」里创建。{s.hasKey && <> 当前：<code>{s.keyHint}</code></>}</>}>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder={s.hasKey ? "已保存（输入新的会替换）" : "sk-…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!key.trim()}
              busy={busy === "save"}
              onClick={() => save({ apiKey: key.trim(), llmMode: "deepseek" }, "API key 已保存").then(() => setKey(""))}
            >
              保存
            </Button>
          </div>
        </Field>
        <BalanceLine />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="接口地址">
            <input className={inputCls} value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} onBlur={() => save({ baseUrl: s.baseUrl })} />
          </Field>
          <Field label="模型" hint="deepseek-chat 快，够用">
            <input className={inputCls} value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} onBlur={() => save({ model: s.model })} />
          </Field>
        </div>
        <Button
          size="sm"
          disabled={!s.hasKey}
          busy={busy === "test"}
          onClick={() => run("test", async () => { const r = await api<{ ok: boolean; model: string }>("/settings/test", { body: {} }); toast(r.ok ? `连接正常（${r.model}）` : "接口有回应，但回答不对", r.ok ? "ok" : "err"); })}
        >
          测试连接
        </Button>
      </Card>

      <BrowserCard data={data} s={s} save={save} busy={busy} run={run} token={token} setToken={setToken} />

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">投递</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="同时填几份" hint="每份一个标签页；填完都停在提交前">
            <select className={inputCls} value={s.concurrency} onChange={(e) => save({ concurrency: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="每份最多走几步" hint="超过就停下，页面留给你接手">
            <input className={inputCls} type="number" min={10} max={120} value={s.maxSteps} onChange={(e) => setS({ ...s, maxSteps: Number(e.target.value) })} onBlur={() => save({ maxSteps: s.maxSteps })} />
          </Field>
          <Field label="简历语言">
            <select className={inputCls} value={s.resumeLanguage} onChange={(e) => save({ resumeLanguage: e.target.value as PublicSettings["resumeLanguage"] })}>
              <option value="auto">跟岗位一致（英文岗位写英文，中文岗位写中文）</option>
              <option value="en">总是英文</option>
              <option value="zh">总是中文</option>
            </select>
          </Field>
          <Field label="求职信" hint="关掉时，只给岗位写明要求求职信的写；填表时表单要了也会现写一封">
            <label className="flex h-[34px] items-center gap-2 text-sm">
              <input type="checkbox" className="accent-brand-600" checked={s.coverLetter} onChange={(e) => save({ coverLetter: e.target.checked })} />
              所有岗位都写一封
            </label>
          </Field>
          <Field label="自动流程的匹配度门槛" hint="一次贴很多链接时，匹配度低的读完就停下，不自动改简历和投递；手动点仍然可以继续">
            <select className={inputCls} value={s.minFit} onChange={(e) => save({ minFit: Number(e.target.value) })}>
              <option value={0}>不设门槛，全部自动走完</option>
              {[...new Set([40, 50, 60, 70, s.minFit])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  低于 {n} 分就停下
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="省钱：等闲时再处理"
            hint="DeepSeek 工作日 9–12 点、14–18 点（北京时间，和新加坡一样）是高峰价，其余时间半价。打开后，一键处理和自动流程里的改简历、填表在高峰时段先排着，到点自动开始；读取岗位照常马上做，单个岗位上点按钮也马上做。"
          >
            <label className="flex h-[34px] items-center gap-2 text-sm">
              <input type="checkbox" className="accent-brand-600" checked={s.offPeakOnly} onChange={(e) => save({ offPeakOnly: e.target.checked })} />
              批量处理只在闲时跑
            </label>
          </Field>
        </div>
      </Card>

      <NotifyCard />
      <UsageCard />
    </div>
  );
}
