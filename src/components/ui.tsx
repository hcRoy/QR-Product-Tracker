import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const v = {
    primary: "bg-brand text-white hover:bg-brand-600",
    secondary: "bg-white text-brand border border-slate-300 hover:bg-accent",
    danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50",
    ghost: "text-brand hover:bg-accent",
  }[variant];
  return <button {...p} className={cx("inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed", v, className)} />;
}

const field = "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand disabled:bg-slate-100";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>((p, r) => <input ref={r} {...p} className={cx(field, p.className)} />);
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>((p, r) => <select ref={r} {...p} className={cx(field, p.className)} />);
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>((p, r) => <textarea ref={r} rows={3} {...p} className={cx(field, p.className)} />);

export function Field({ label, error, hint, required, children }: { label: string; error?: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}{required && <span className="text-red-600" aria-hidden> *</span>}</span>
      {children}
      {hint && !error && <span className="block text-xs text-slate-500">{hint}</span>}
      {error && <span role="alert" className="block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export const Card = ({ children, className, id }: { children: ReactNode; className?: string; id?: string }) =>
  <section id={id} className={cx("rounded-xl border border-slate-200 bg-white p-5 shadow-sm", className)}>{children}</section>;

const tones = { green: "bg-emerald-50 text-emerald-700 ring-emerald-200", amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200", slate: "bg-slate-100 text-slate-700 ring-slate-200", blue: "bg-accent text-brand ring-indigo-200" };
export const Badge = ({ tone = "slate", children }: { tone?: keyof typeof tones; children: ReactNode }) =>
  <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone])}>{children}</span>;

export const Skeleton = ({ className }: { className?: string }) => <div className={cx("animate-pulse rounded bg-slate-200", className)} />;
export const TableSkeleton = ({ rows = 6 }: { rows?: number }) =>
  <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1">{error instanceof Error ? error.message : "Unexpected error"}</p>
      {retry && <Button variant="secondary" className="mt-3" onClick={retry}>Retry</Button>}
    </div>
  );
}
export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) =>
  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"><p className="font-medium text-slate-800">{title}</p><div className="mt-2 text-sm text-slate-500">{children}</div></div>;

export const PageHeader = ({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-2xl font-semibold text-brand">{title}</h1>{sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}</div>
    <div className="flex flex-wrap gap-2">{actions}</div>
  </div>
);

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>{total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}</span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
