/**
 * In-page confirm/alert dialogs, replacing window.confirm()/alert(). Native
 * dialogs block the page's script (polling and countdowns freeze), cannot be
 * styled or worded with a title and specific button labels, and in the
 * toolbar popup they can lose focus and close the popup.
 *
 * Usage: wrap the app in <DialogProvider>, then
 *   const dialog = useDialog();
 *   if (await dialog.confirm({ title: "Delete rule?", confirmLabel: "Delete", danger: true })) …
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Label of the button that confirms; name the action ("Delete"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: red confirm button, and Cancel gets the initial focus. */
  danger?: boolean;
}
export interface AlertOptions {
  title: string;
  message?: ReactNode;
  okLabel?: string;
}
export interface Dialogs {
  confirm(o: ConfirmOptions): Promise<boolean>;
  alert(o: AlertOptions): Promise<void>;
}

type Pending = { id: number; resolve: (v: boolean) => void } & ({ kind: "confirm"; o: ConfirmOptions } | { kind: "alert"; o: AlertOptions });

let nextId = 1;

const DialogContext = createContext<Dialogs | null>(null);

export function useDialog(): Dialogs {
  const d = useContext(DialogContext);
  if (!d) throw new Error("useDialog() needs a <DialogProvider> above it");
  return d;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  // A queue, so a second request made while one dialog is open waits its turn.
  const [queue, setQueue] = useState<Pending[]>([]);

  const open = useCallback(
    (p: { kind: "confirm"; o: ConfirmOptions } | { kind: "alert"; o: AlertOptions }) =>
      new Promise<boolean>((resolve) => setQueue((q) => [...q, { ...p, id: nextId++, resolve }])),
    [],
  );
  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (o) => open({ kind: "confirm", o }),
      alert: (o) => open({ kind: "alert", o }).then(() => undefined),
    }),
    [open],
  );

  const current = queue[0];
  const close = (value: boolean) => {
    current?.resolve(value);
    setQueue((q) => q.slice(1));
  };

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {current && <DialogView key={current.id} pending={current} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogView({ pending, onClose }: { pending: Pending; onClose: (v: boolean) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { o } = pending;
  const isConfirm = pending.kind === "confirm";
  const danger = isConfirm && !!pending.o.danger;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Destructive confirms focus Cancel, so a stray Enter does not delete anything.
    boxRef.current?.querySelector<HTMLButtonElement>(danger ? "[data-cancel]" : "[data-ok]")?.focus();
    return () => previous?.focus?.();
  }, [danger]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose(false);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea") ?? [])];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div ref={boxRef} className="dialog" role={isConfirm ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="dialog-title" aria-describedby={o.message ? "dialog-message" : undefined} onKeyDown={onKeyDown}>
        <h3 id="dialog-title">{o.title}</h3>
        {o.message && (
          <div id="dialog-message" className="dialog-message">
            {o.message}
          </div>
        )}
        <div className="dialog-actions">
          {isConfirm && (
            <button data-cancel onClick={() => onClose(false)}>
              {pending.o.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button data-ok className={danger ? "danger-solid" : "primary"} onClick={() => onClose(true)}>
            {isConfirm ? (pending.o.confirmLabel ?? "OK") : ((o as AlertOptions).okLabel ?? "OK")}
          </button>
        </div>
      </div>
    </div>
  );
}
