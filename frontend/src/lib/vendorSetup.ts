// Shared shapes for "Set Up New Vendor" (backend: routes/vendorSetup.js).

export type VendorSetupStatus = 'sent' | 'verified' | 'submitted' | 'expired';
export type VendorSetupFileKind = 'w9' | 'insurance' | 'bank';

export interface VendorSetupInvite {
  id: string;
  company_name: string;
  email: string;
  vendor_type: 'contractor' | 'supplier';
  status: VendorSetupStatus;
  created_at: string;
  last_sent_at?: string | null;
  send_count: number;
  opened_at?: string | null;
  verified_at?: string | null;
  submitted_at?: string | null;
  expires_at: string;
  requested_by_name?: string | null;
  contractor_id?: string | null;
  contractor_name?: string | null;
  match_kind?: 'email' | 'name' | null;
  w9_method?: 'online' | 'upload' | null;
  file_counts: Record<VendorSetupFileKind, number>;
  can_delete: boolean;
}

export interface VendorSetupDocument {
  id: string;
  kind: VendorSetupFileKind;
  kind_label: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  can_view: boolean;
  inline: boolean;
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Where the vendor is in the flow, in words the office uses.
export function vendorSetupStatusMeta(invite: Pick<VendorSetupInvite, 'status' | 'opened_at'>) {
  switch (invite.status) {
    case 'submitted':
      return { label: 'Completed', tone: 'emerald' as const };
    case 'verified':
      return { label: 'Filling out form', tone: 'blue' as const };
    case 'expired':
      return { label: 'Link expired', tone: 'red' as const };
    default:
      return invite.opened_at
        ? { label: 'Link opened', tone: 'blue' as const }
        : { label: 'Waiting on vendor', tone: 'amber' as const };
  }
}
