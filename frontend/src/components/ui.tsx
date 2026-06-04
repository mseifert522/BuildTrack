import React from 'react';

// Status badge colors
export const statusColors: Record<string, string> = {
  // Project status
  active_rehab: 'bg-green-100 text-green-800',
  rehab_completed: 'bg-blue-100 text-blue-800',
  long_term_holding: 'bg-amber-100 text-amber-800',
  commercial: 'bg-cyan-100 text-cyan-800',
  on_market: 'bg-amber-100 text-amber-800',
  closed_sold: 'bg-gray-100 text-gray-700',
  // Legacy
  active: 'bg-green-100 text-green-800',
  in_progress: 'bg-blue-100 text-blue-800',
  on_hold: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-700',
  archived: 'bg-red-100 text-red-700',
  // Punch list status
  not_started: 'bg-gray-100 text-gray-700',
  waiting_materials: 'bg-orange-100 text-orange-800',
  needs_review: 'bg-purple-100 text-purple-800',
  // Invoice status
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-800',
  reviewed: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  paid: 'bg-emerald-100 text-emerald-800',
};

export const priorityColors: Record<string, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

export const statusLabels: Record<string, string> = {
  active_rehab: 'Active Rehab',
  rehab_completed: 'Rehab Completed',
  long_term_holding: 'Long-Term Holding',
  commercial: 'Commercial',
  on_market: 'On Market',
  closed_sold: 'Closed and Sold',
  // Legacy
  active: 'Active',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  completed: 'Completed',
  archived: 'Archived',
  not_started: 'Not Started',
  waiting_materials: 'Waiting Materials',
  needs_review: 'Needs Review',
  draft: 'Draft',
  submitted: 'Submitted',
  reviewed: 'Reviewed',
  approved: 'Approved',
  paid: 'Paid',
};

interface BadgeProps {
  status: string;
  type?: 'status' | 'priority';
  className?: string;
}

export function StatusBadge({ status, type = 'status', className = '' }: BadgeProps) {
  const colors = type === 'priority' ? priorityColors : statusColors;
  const label = statusLabels[status] || status.replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-700'} ${className}`}>
      {label}
    </span>
  );
}

interface LoadingProps { message?: string; }
export function Loading({ message = 'Loading...' }: LoadingProps) {
  return (
    <div className="bt-responsive-container py-8" role="status" aria-live="polite" aria-label={message}>
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="bt-skeleton-line mb-3 h-5 w-44" />
          <div className="bt-skeleton-line h-3 w-64 max-w-full" />
        </div>
        <div className="bt-skeleton-block h-12 w-12 flex-shrink-0" />
      </div>
      <div className="bt-fluid-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="bt-skeleton-card">
            <div className="bt-skeleton-block mb-4 h-24 w-full" />
            <div className="bt-skeleton-line mb-3 h-4 w-3/4" />
            <div className="bt-skeleton-line h-3 w-1/2" />
          </div>
        ))}
      </div>
      <span className="sr-only">{message}</span>
    </div>
  );
}

interface EmptyProps { message?: string; icon?: React.ReactNode; }
export function Empty({ message = 'No items found', icon }: EmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-4">
      {icon && <div className="mb-3 text-gray-300">{icon}</div>}
      <p className="text-gray-500 text-sm">{message}</p>
    </div>
  );
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  description?: string;
}

export function Modal({ isOpen, onClose, title, children, size = 'md', description }: ModalProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const getFocusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || []).filter(element => !element.hasAttribute('aria-hidden'));

    window.setTimeout(() => {
      const focusable = getFocusable();
      (focusable[0] || dialogRef.current)?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;
  const sizeClass = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-950/45" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`bt-modal-panel relative flex max-h-[90vh] w-full ${sizeClass} flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-xl`}
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h3 id={titleId} className="text-base font-bold text-slate-950">{title}</h3>
            {description && <p id={descriptionId} className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label={`Close ${title}`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}
