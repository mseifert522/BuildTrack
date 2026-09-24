import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Building2, FileText, Hammer, Package, RefreshCw, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { Loading, PageHeader } from '../components/ui';
import { useAuthStore, canAccessCostAnalyzer, canEditCostAnalyzer } from '../store/authStore';
import { SPEND_TYPES, SPEND_TYPE_LABELS, getOverview } from '../lib/costAnalyzerApi';
import type { CostAnalyzerFilters, OverviewResponse } from '../lib/costAnalyzerApi';
import {
  COST_ANALYZER_TABS,
  apiError,
  cardClass,
  fieldClass,
  presetOptions,
  secondaryButton,
  useCostAnalyzerFilters,
} from '../components/costAnalyzer/shared';
import type { CostAnalyzerTab } from '../components/costAnalyzer/shared';
import OverviewTab from '../components/costAnalyzer/OverviewTab';
import VendorsTab from '../components/costAnalyzer/VendorsTab';
import ProjectsTab from '../components/costAnalyzer/ProjectsTab';
import CategoriesTab from '../components/costAnalyzer/CategoriesTab';
import MaterialsTab from '../components/costAnalyzer/MaterialsTab';
import DocumentsTab from '../components/costAnalyzer/DocumentsTab';

// Cost Analyzer page shell (spec §7): header, HR-style tab strip, one filter row
// that scopes every tab, and the active tab component. The page owns the
// /overview request because its `years_available` feeds the date presets; every
// other tab fetches its own report with the same `filters` object.

const TAB_META: Record<CostAnalyzerTab, { label: string; icon: typeof BarChart3 }> = {
  overview: { label: 'Overview', icon: BarChart3 },
  vendors: { label: 'Vendors', icon: Users },
  projects: { label: 'Projects', icon: Building2 },
  categories: { label: 'Categories', icon: Hammer },
  materials: { label: 'Materials', icon: Package },
  documents: { label: 'Documents', icon: FileText },
};

export default function CostAnalyzer() {
  const user = useAuthStore(state => state.user);
  const role = user?.role ?? '';
  const canAccess = canAccessCostAnalyzer(role);
  const canEdit = canEditCostAnalyzer(role);

  const {
    tab, setTab, filters, query, isActive, preset, setPreset, setRange, spendType, setSpendType, reset, rangeLabel,
  } = useCostAnalyzerFilters();
  const [, setSearchParams] = useSearchParams();

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The "Custom range" preset has no dates of its own: this flag keeps the
  // from/to inputs open after the person picks it, until they choose a preset.
  const [customOpen, setCustomOpen] = useState(false);
  // Query string the loaded overview corresponds to (null until the first load succeeds).
  const loadedQueryRef = useRef<string | null>(null);
  // Monotonic request id so a slow, superseded response never overwrites a newer one.
  const requestIdRef = useRef(0);

  const loadOverview = useCallback(async (forQuery: string, forFilters: CostAnalyzerFilters) => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    try {
      const data = await getOverview(forFilters);
      if (requestId !== requestIdRef.current) return;
      setOverview(data);
      setOverviewError(null);
      loadedQueryRef.current = forQuery;
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      const message = apiError(err);
      setOverviewError(message);
      toast.error(message);
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, []);

  // First load always (any tab: the presets need years_available); afterwards
  // only the Overview tab refetches when the filters change - the other tabs own
  // their own requests.
  useEffect(() => {
    if (!canAccess) return;
    const firstLoad = loadedQueryRef.current === null;
    if (!firstLoad && tab !== 'overview') return;
    if (!firstLoad && loadedQueryRef.current === query) return;
    void loadOverview(query, filters);
  }, [canAccess, tab, query, filters, loadOverview]);

  // Cross-tab vendor link: the Vendors tab reads ?vendor=<id> and opens that drawer.
  const openVendor = useCallback((vendorId: string) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('tab', 'vendors');
      next.set('vendor', vendorId);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const goToTab = useCallback((next: CostAnalyzerTab) => setTab(next), [setTab]);

  if (!user || !canAccess) {
    return (
      <div className="bt-desktop-page mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
        <PageHeader title="Cost Analyzer" subtitle="What each vendor, category and material really costs — from QuickBooks bills" />
        <div className={cardClass}>
          <p className="text-sm text-slate-700">The Cost Analyzer is available to the owner, operations managers and project managers.</p>
        </div>
      </div>
    );
  }

  const presets = presetOptions(overview?.years_available ?? []);
  const presetKnown = presets.some(option => option.id === preset);
  // A `year:<n>` preset from the URL is only listed once years_available has
  // loaded; until then treat it as a custom range so the inputs show the dates.
  const showCustom = customOpen || preset === 'custom' || !presetKnown;
  const selectValue = showCustom ? 'custom' : preset;

  const onPresetChange = (value: string) => {
    const option = presets.find(entry => entry.id === value);
    if (!option) return;
    if (option.id === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setPreset(option.id);
  };

  const onSpendTypeChange = (value: string) => {
    const next = SPEND_TYPES.find(entry => entry === value) ?? null;
    setSpendType(next);
  };

  const clearFilters = () => {
    setCustomOpen(false);
    reset();
  };

  const firstLoading = overview === null && overviewError === null;
  const dimmed = tab === 'overview' && refreshing && overview !== null;

  const renderTab = () => {
    const common = { filters, canEdit, onOpenVendor: openVendor };
    switch (tab) {
      case 'vendors':
        return <VendorsTab {...common} />;
      case 'projects':
        return <ProjectsTab {...common} />;
      case 'categories':
        return <CategoriesTab {...common} />;
      case 'materials':
        return <MaterialsTab {...common} />;
      case 'documents':
        return <DocumentsTab {...common} />;
      case 'overview':
      default:
        if (firstLoading) return <Loading message="Loading Cost Analyzer..." />;
        if (overview === null) {
          return (
            <div className={cardClass}>
              <p className="text-sm font-semibold text-slate-800">The overview could not be loaded.</p>
              <p className="mt-1 text-sm text-slate-500">{overviewError}</p>
              <button type="button" className={`${secondaryButton} mt-4`} onClick={() => { void loadOverview(query, filters); }}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Try again
              </button>
            </div>
          );
        }
        return <OverviewTab {...common} overview={overview} onGoToTab={goToTab} />;
    }
  };

  return (
    <div className="bt-desktop-page mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
      <PageHeader
        title="Cost Analyzer"
        subtitle="What each vendor, category and material really costs — from QuickBooks bills"
        actions={tab === 'overview' ? (
          <button
            type="button"
            className={secondaryButton}
            onClick={() => { void loadOverview(query, filters); }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        ) : undefined}
      />

      <div className="overflow-x-auto border-b border-slate-300">
        <nav className="flex min-w-max gap-1" aria-label="Cost Analyzer sections">
          {COST_ANALYZER_TABS.map(id => {
            const meta = TAB_META[id];
            const Icon = meta.icon;
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition ${
                  active
                    ? 'border-amber-700 text-slate-950'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {meta.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* One filter row scopes every report; changes apply immediately through the URL. */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <select
            className={`${fieldClass} sm:w-52`}
            aria-label="Date range"
            value={selectValue}
            onChange={event => onPresetChange(event.target.value)}
          >
            {presets.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          {showCustom && (
            <>
              <input
                type="date"
                className={`${fieldClass} sm:w-44`}
                aria-label="From date"
                value={filters.from ?? ''}
                max={filters.to ?? undefined}
                onChange={event => setRange(event.target.value || null, filters.to ?? null)}
              />
              <input
                type="date"
                className={`${fieldClass} sm:w-44`}
                aria-label="To date"
                value={filters.to ?? ''}
                min={filters.from ?? undefined}
                onChange={event => setRange(filters.from ?? null, event.target.value || null)}
              />
            </>
          )}
          <select
            className={`${fieldClass} sm:w-48`}
            aria-label="Spend type"
            value={spendType ?? ''}
            onChange={event => onSpendTypeChange(event.target.value)}
          >
            <option value="">All spend types</option>
            {SPEND_TYPES.map(type => (
              <option key={type} value={type}>{SPEND_TYPE_LABELS[type]}</option>
            ))}
          </select>
          {isActive && (
            <button type="button" className={secondaryButton} onClick={clearFilters}>
              <X className="h-4 w-4" aria-hidden="true" />
              Clear filters
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {tab === 'documents'
            ? 'Documents are not filtered by date.'
            : `Showing ${rangeLabel}${spendType ? ` · ${SPEND_TYPE_LABELS[spendType]} only` : ''}. Implied hourly rates always use every bill, whatever the range.`}
        </p>
      </div>

      {/* Hold the previous render at reduced opacity while the overview refetches - no skeleton flash. */}
      <div className={`transition-opacity ${dimmed ? 'opacity-60' : ''}`} aria-busy={dimmed ? true : undefined}>
        {renderTab()}
      </div>
    </div>
  );
}
