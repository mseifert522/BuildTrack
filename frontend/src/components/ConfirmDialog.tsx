import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './ui';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  error?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// In-page confirmation (Mike, 2026-09-23: no browser window.confirm/prompt boxes).
// Built on the shared Modal, so Escape / backdrop cancel and focus stay trapped.
// While `busy`, closing is blocked so a half-sent request can't be abandoned.
export default function ConfirmDialog({
  isOpen,
  title,
  description,
  children,
  confirmLabel,
  busyLabel = 'Working...',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  error,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const close = () => {
    if (!busy) onCancel();
  };
  // A failed request leaves the user where they can read it and try again.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const blocked = busy || confirmDisabled;
  return (
    <Modal isOpen={isOpen} onClose={close} title={title} description={description} size="md">
      {/* noValidate: validation is in-page only; a type=email field must never
          raise the browser's own bubble. */}
      <form
        noValidate
        onSubmit={event => {
          event.preventDefault();
          if (!blocked) onConfirm();
        }}
        className="space-y-4"
      >
        {children}
        {error ? (
          <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700 outline-none">{error}</div>
        ) : null}
        {/* aria-disabled instead of disabled: disabling the focused button would drop
            keyboard focus to <body>, outside the dialog's focus trap. */}
        <div className="flex min-w-0 flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <button type="button" onClick={close} aria-disabled={busy} className="bt-vs-btn bt-vs-btn--lg">
            {cancelLabel}
          </button>
          <button
            type="submit"
            aria-disabled={blocked}
            aria-busy={busy}
            className={`bt-vs-btn bt-vs-btn--lg ${tone === 'danger' ? 'bt-vs-btn--danger-solid' : 'bt-vs-btn--primary'}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
