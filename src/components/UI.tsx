import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { X, ArrowUpRight, Check, LoaderCircle } from "lucide-react";
export const yen = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
export const stamp = () => ({
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
export const money = (value: FormDataEntryValue | null, allowZero = false) => {
  const n = Number(value);
  if (
    !Number.isSafeInteger(n) ||
    n < (allowZero ? 0 : 1) ||
    n > 999_999_999_999
  )
    throw new Error(
      allowZero
        ? "0円以上の整数を入力してください。"
        : "1円以上の整数を入力してください。",
    );
  return n;
};
export const textValue = (f: FormData, key: string) =>
  String(f.get(key) ?? "").trim();
export function Sheet({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el)?.focus({
      preventScroll: true,
    });
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab" && el) {
        const list = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
          ),
        ).filter((x) => x.offsetParent !== null);
        const first = list[0],
          last = list.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === el)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", handler);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`sheet ${wide ? "wide" : ""}`}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="sheet-handle" />
        <header className="sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" aria-label="閉じる" onClick={onClose}>
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function AsyncForm({
  onSubmit,
  children,
  label = "保存する",
  className = "",
  disabled = false,
}: {
  onSubmit: (form: FormData) => Promise<void>;
  children: ReactNode;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (guard.current || disabled) return;
    const form = new FormData(e.currentTarget);
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit(form);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "保存できませんでした。もう一度お試しください。",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <form className={`form-stack ${className}`} onSubmit={submit}>
      {children}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <button
          type="submit"
          disabled={busy || disabled}
          className="button button-primary full"
        >
          {busy ? (
            <LoaderCircle size={20} className="spin" />
          ) : (
            <Check size={19} />
          )}{" "}
          {busy ? "保存しています…" : label}
        </button>
      </div>
    </form>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({
  icon,
  children,
  action,
}: {
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <p>{children}</p>
      {action}
    </div>
  );
}
export function SectionTitle({
  title,
  action,
  onClick,
}: {
  title: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {action && (
        <button className="text-button" onClick={onClick}>
          {action}
          <ArrowUpRight size={16} />
        </button>
      )}
    </div>
  );
}
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(Math.max(0, Math.min(100, value)))}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
