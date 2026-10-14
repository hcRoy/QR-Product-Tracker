import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Textarea } from "./ui";

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-title" className="m-auto w-[min(92vw,28rem)] rounded-xl p-0 shadow-xl backdrop:bg-black/40">
      {open && <div className="space-y-4 p-5"><h2 id="dlg-title" className="text-lg font-semibold text-brand">{title}</h2>{children}</div>}
    </dialog>
  );
}

/** Confirmation with an optional free-text reason (stored in the audit log). */
export function ConfirmDialog({ open, onClose, title, body, confirmLabel, danger, withReason, busy, onConfirm }: {
  open: boolean; onClose: () => void; title: string; body: ReactNode; confirmLabel: string; danger?: boolean;
  withReason?: boolean; busy?: boolean; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onClose={() => { setReason(""); onClose(); }} title={title}>
      <div className="text-sm text-slate-600">{body}</div>
      {withReason && <Textarea aria-label="Reason (optional)" placeholder="Reason (optional, saved in audit log)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={() => onConfirm(reason)}>{busy ? "Working…" : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
