import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  size = "md",
  busy,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  const v: Record<Variant, string> = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 border-brand-600",
    secondary: "bg-white text-ink hover:bg-paper border-line",
    ghost: "bg-transparent text-muted hover:text-ink hover:bg-black/5 border-transparent",
    danger: "bg-white text-red-700 hover:bg-red-50 border-red-200",
  };
  const s = size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm";
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${v[variant]} ${s} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

export type Tone = "gray" | "blue" | "amber" | "green" | "red" | "violet";
export function Badge({ tone = "gray", children, pulse }: { tone?: Tone; children: ReactNode; pulse?: boolean }) {
  const t: Record<Tone, string> = {
    gray: "bg-stone-100 text-stone-700",
    blue: "bg-sky-50 text-sky-800",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
    green: "bg-brand-50 text-brand-700",
    red: "bg-red-50 text-red-700",
    violet: "bg-violet-50 text-violet-800",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${t[tone]}`}>
      {pulse && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-white ${className}`}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm outline-none placeholder:text-stone-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white/60 px-6 py-12 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

// ---- icons (16px line icons)
const ICONS = {
  jobs: "M2.5 5.5h11v7.5h-11z M5.5 5.5V3.5h5v2 M2.5 9h11",
  inbox: "M2.5 9.5 4 3.5h8l1.5 6v3.5h-11z M2.5 9.5h3.5l.8 1.5h2.4l.8-1.5h3.5",
  profile: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 1.8v1.7 M8 12.5v1.7 M1.8 8h1.7 M12.5 8h1.7 M3.6 3.6l1.2 1.2 M11.2 11.2l1.2 1.2 M3.6 12.4l1.2-1.2 M11.2 4.8l1.2-1.2",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M10.6 10.6 14 14",
  download: "M8 2.5v7.5 M5 7l3 3 3-3 M3 13h10",
  check: "M3.5 8.5 6.5 11.5 12.5 4.5",
  x: "M4 4l8 8 M12 4l-8 8",
  external: "M9 2.5h4.5V7 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  undo: "M5.5 3.5 2.5 6.5l3 3 M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7",
  bell: "M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z M6.5 13.5a1.5 1.5 0 0 0 3 0",
  calendar: "M2.5 4h11v9.5h-11z M2.5 7h11 M5.5 2.5v3 M10.5 2.5v3",
  chart: "M2.5 13.5h11 M4.5 13.5V9 M7.5 13.5V5 M10.5 13.5V7.5",
  board: "M2.5 3h3v10h-3z M6.5 3h3v6.5h-3z M10.5 3h3v8h-3z",
  list: "M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.5 4h.5 M2.5 8h.5 M2.5 12h.5",
  spark: "M8 2v3 M8 11v3 M2 8h3 M11 8h3 M4 4l1.8 1.8 M10.2 10.2 12 12 M4 12l1.8-1.8 M10.2 5.8 12 4",
  mail: "M2.5 4h11v8.5h-11z M2.5 4.5 8 9l5.5-4.5",
  copy: "M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3",
  plus: "M8 3v10 M3 8h10",
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Fit score as a small pill: green ≥70, amber 50–69, red below. */
export function FitPill({ score, className = "" }: { score: number; className?: string }) {
  const t = score >= 70 ? "bg-brand-50 text-brand-700" : score >= 50 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${t} ${className}`} title="Fit: how well your profile meets the job's must-haves">
      Fit {score}
    </span>
  );
}

/** A square with the company's first letter, coloured by name so each company keeps its colour. */
export function Avatar({ name, className = "size-9" }: { name: string; className?: string }) {
  const palette = ["bg-brand-100 text-brand-700", "bg-sky-100 text-sky-800", "bg-amber-100 text-amber-800", "bg-violet-100 text-violet-800", "bg-rose-100 text-rose-800", "bg-stone-200 text-stone-700"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return <span className={`grid shrink-0 place-items-center rounded-md text-sm font-semibold ${palette[h % palette.length]} ${className}`}>{letter}</span>;
}

/** A "more" button with a small dropdown; closes on outside click or Escape. */
export function Menu({ label, items }: { label: ReactNode; items: Array<{ label: string; onClick: () => void; danger?: boolean; hidden?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        {label}
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-40 overflow-hidden rounded-md border border-line bg-white py-1 shadow-lg">
          {items
            .filter((i) => !i.hidden)
            .map((i) => (
              <button
                key={i.label}
                role="menuitem"
                className={`block w-full px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-paper ${i.danger ? "text-red-700" : ""}`}
                onClick={() => {
                  setOpen(false);
                  i.onClick();
                }}
              >
                {i.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---- toasts
type ToastMsg = { id: number; text: string; tone: "ok" | "err" };
let push: ((t: ToastMsg) => void) | null = null;
let seq = 0;
export function toast(text: string, tone: "ok" | "err" = "ok") {
  push?.({ id: ++seq, text, tone });
}
export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>([]);
  useEffect(() => {
    push = (t) => {
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.tone === "err" ? 7000 : 3000);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-md px-3 py-2 text-sm shadow-lg ${t.tone === "err" ? "bg-red-700 text-white" : "bg-ink text-white"}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Runs an async action with a busy flag and a toast on failure. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}
