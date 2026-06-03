import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ClipboardList,
  FileText,
  FolderOpen,
  MessageSquare,
  Truck,
  Users,
} from 'lucide-react';
import api from '../lib/api';
import { formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';
import Avatar from './Avatar';
import { Modal } from './ui';

type ActivityTab = 'all' | 'notes' | 'projects' | 'invoices' | 'contractors' | 'suppliers';

interface RecentNote {
  id: string;
  project_id: string;
  user_name: string;
  user_avatar_url?: string | null;
  note: string;
  note_type?: string | null;
  created_at: string;
  project_address?: string | null;
  project_job_name?: string | null;
}

interface ActivityLog {
  id: string;
  project_id?: string | null;
  user_name: string;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: string | null;
  created_at: string;
  project_address?: string | null;
  project_job_name?: string | null;
}

interface ActivityItem {
  id: string;
  tab: ActivityTab;
  icon: typeof Activity;
  userName: string;
  description: string;
  connectedRecord: string;
  preview?: string;
  createdAt: string;
  to: string;
}

const tabs: Array<{ id: ActivityTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'notes', label: 'Notes' },
  { id: 'projects', label: 'Projects' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'contractors', label: 'Contractors' },
  { id: 'suppliers', label: 'Suppliers' },
];

function actionLabel(action: string, details?: Record<string, any> | null) {
  const labels: Record<string, string> = {
    note_added: 'added a project note',
    note_updated: 'updated a project note',
    project_created: 'created a project',
    project_updated: 'updated a project',
    project_archived: 'archived a project',
    invoice_created: 'created an invoice',
    invoice_submitted: 'submitted an invoice',
    invoice_status_updated: `updated invoice status${details?.status ? ` to ${String(details.status).replace(/_/g, ' ')}` : ''}`,
    punch_item_created: 'created a punch list item',
    punch_item_updated: 'updated a punch list item',
    document_uploaded: 'uploaded a document',
    document_deleted: 'deleted a document',
    contractor_profile_created: 'created a contractor record',
    contractor_profile_updated: 'updated a contractor record',
    supplier_profile_created: 'created a supplier record',
    supplier_profile_updated: 'updated a supplier record',
    avatar_updated: 'updated a profile photo',
  };
  return labels[action] || action.replace(/_/g, ' ');
}

function safeDetails(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tabFor(log: ActivityLog): ActivityTab {
  const subject = `${log.action} ${log.entity_type || ''}`.toLowerCase();
  if (subject.includes('invoice')) return 'invoices';
  if (subject.includes('contractor')) return 'contractors';
  if (subject.includes('supplier')) return 'suppliers';
  if (subject.includes('project') || subject.includes('punch') || subject.includes('material') || subject.includes('document')) return 'projects';
  return 'all';
}

function iconFor(tab: ActivityTab) {
  if (tab === 'notes') return MessageSquare;
  if (tab === 'projects') return FolderOpen;
  if (tab === 'invoices') return FileText;
  if (tab === 'contractors') return Users;
  if (tab === 'suppliers') return Truck;
  return ClipboardList;
}

function itemLink(log: ActivityLog, tab: ActivityTab) {
  if (log.project_id && log.entity_type === 'invoice' && log.entity_id) {
    return `/projects/${log.project_id}/invoices/${log.entity_id}`;
  }
  if (log.project_id) return `/projects/${log.project_id}`;
  if (tab === 'contractors') return '/contractors';
  if (tab === 'suppliers') return '/suppliers';
  if (tab === 'invoices') return '/invoices';
  return '/dashboard';
}

export default function RecentActivityModal({ userId }: { userId?: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActivityTab>('all');
  const [doNotShowAgain, setDoNotShowAgain] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>([]);

  const sessionKey = userId ? `buildtrack-recent-activity-dismissed:${userId}` : '';
  const preferenceKey = userId ? `buildtrack-recent-activity-never:${userId}` : '';

  useEffect(() => {
    if (!userId || !sessionKey || !preferenceKey) return;
    if (sessionStorage.getItem(sessionKey) === '1' || localStorage.getItem(preferenceKey) === '1') return;

    setOpen(true);
    setLoading(true);
    let cancelled = false;
    Promise.all([
      api.get('/notes/recent?limit=25').catch(() => ({ data: [] })),
      api.get('/activity').catch(() => ({ data: [] })),
    ]).then(([notesRes, activityRes]) => {
      if (cancelled) return;
      const noteItems: ActivityItem[] = (Array.isArray(notesRes.data) ? notesRes.data : []).map((note: RecentNote) => ({
        id: `note-${note.id}`,
        tab: 'notes',
        icon: MessageSquare,
        userName: note.user_name || 'Unknown user',
        description: 'added a project note',
        connectedRecord: note.project_address || note.project_job_name || 'Project note',
        preview: note.note,
        createdAt: note.created_at,
        to: `/projects/${note.project_id}#notes`,
      }));
      const logItems: ActivityItem[] = (Array.isArray(activityRes.data) ? activityRes.data : []).map((log: ActivityLog) => {
        const details = safeDetails(log.details);
        const tab = tabFor(log);
        return {
          id: `activity-${log.id}`,
          tab,
          icon: iconFor(tab),
          userName: log.user_name || 'Unknown user',
          description: actionLabel(log.action, details),
          connectedRecord: log.project_address || log.project_job_name || log.entity_type || 'BuildTrack',
          preview: details?.note || details?.title || details?.name || details?.scope_title || details?.material_name,
          createdAt: log.created_at,
          to: itemLink(log, tab),
        };
      });
      setItems([...noteItems, ...logItems]
        .sort((left, right) =>
          (parseBuildTrackTimestamp(right.createdAt)?.getTime() || 0) -
          (parseBuildTrackTimestamp(left.createdAt)?.getTime() || 0)
        )
        .slice(0, 50));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [userId, sessionKey, preferenceKey]);

  const visibleItems = useMemo(() => (
    activeTab === 'all' ? items : items.filter(item => item.tab === activeTab)
  ), [activeTab, items]);

  const close = () => {
    if (sessionKey) sessionStorage.setItem(sessionKey, '1');
    if (doNotShowAgain && preferenceKey) localStorage.setItem(preferenceKey, '1');
    setOpen(false);
  };

  const openItem = (to: string) => {
    close();
    navigate(to);
  };

  const viewFullActivity = () => {
    close();
    navigate('/dashboard#recent-activity');
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Recent Activity & Notes"
      description="Latest project notes and system activity entered by the team."
      size="xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Recent activity filters">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg border px-3 py-2 text-xs font-bold transition-colors ${
                activeTab === tab.id
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div id="recent-activity-list" className="max-h-[54vh] overflow-y-auto rounded-lg border border-slate-200">
          {loading ? (
            <div className="space-y-3 p-4" role="status" aria-live="polite">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex gap-3">
                  <div className="h-9 w-9 rounded-lg bg-slate-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-slate-200" />
                    <div className="h-3 w-2/3 rounded bg-slate-100" />
                  </div>
                </div>
              ))}
              <span className="sr-only">Loading recent activity</span>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center p-8 text-center">
              <Activity className="mb-3 h-8 w-8 text-slate-300" />
              <p className="text-sm font-bold text-slate-700">No recent activity yet.</p>
              <p className="mt-1 text-xs text-slate-500">New notes and updates will appear here after the team starts entering them.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 bg-white">
              {visibleItems.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openItem(item.to)}
                    className="grid w-full grid-cols-[auto_1fr_auto] gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
                  >
                    <Avatar name={item.userName} size={36} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-slate-950">{item.userName}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                          <Icon className="h-3 w-3" />
                          {tabs.find(tab => tab.id === item.tab)?.label || 'Activity'}
                        </span>
                      </span>
                      <span className="mt-1 block text-sm text-slate-700">{item.description}</span>
                      <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">{item.connectedRecord}</span>
                      {item.preview && <span className="mt-2 block line-clamp-2 text-sm text-slate-600">{item.preview}</span>}
                    </span>
                    <span className="whitespace-nowrap text-right text-xs font-semibold text-slate-500">
                      {formatEasternDateTime(item.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600">
            <input
              type="checkbox"
              checked={doNotShowAgain}
              onChange={event => setDoNotShowAgain(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            Do not show this again
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={viewFullActivity} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
              View Full Activity
            </button>
            <button type="button" onClick={close} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800">
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
