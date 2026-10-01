// A vendor added anywhere (the top-bar Add Vendor button, a project page, the
// Documents & Agreements form) is announced on window so whatever page is open -
// the Contractors / Suppliers directory, a project's contractor list - reloads.
export const VENDOR_ADDED_EVENT = 'bt:vendor-added';

export interface AddedVendor {
  id: string;
  name: string;
  type: 'contractor' | 'supplier';
  /** The project the user wanted this vendor connected to, if any. */
  project_id?: string | null;
  /** True when the server already connected it to project_id (a new contractor).
   *  False for an existing vendor the user chose instead: the project page connects it. */
  linked?: boolean;
}

export function announceVendorAdded(vendor: AddedVendor) {
  window.dispatchEvent(new CustomEvent<AddedVendor>(VENDOR_ADDED_EVENT, { detail: vendor }));
}

export function onVendorAdded(handler: (vendor: AddedVendor) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<AddedVendor>).detail);
  window.addEventListener(VENDOR_ADDED_EVENT, listener);
  return () => window.removeEventListener(VENDOR_ADDED_EVENT, listener);
}

// What happened to a quote's vendor when the quote was saved (server: quoteVendorIntake.js).
export interface QuoteVendorResolution {
  status: 'linked' | 'created' | 'needs_clarification' | 'unchanged' | 'error' | 'missing';
  vendor_name?: string;
  contractor_id?: string;
  read_name?: string;
  reason?: string;
  notification?: { sent: boolean; reason: string; to: string };
}

// One wording for every page that saves a quote. Returns null when there is
// nothing worth telling the user (the vendor was already linked).
export function quoteVendorMessage(resolution?: QuoteVendorResolution | null): { tone: 'success' | 'warning'; text: string } | null {
  if (!resolution) return null;
  if (resolution.status === 'created') {
    return { tone: 'success', text: `${resolution.vendor_name} was added to Contractors / Suppliers.` };
  }
  if (resolution.status === 'needs_clarification') {
    const n = resolution.notification;
    const emailed = n?.sent
      ? ` The office (${n.to}) was emailed to clarify the vendor's name.`
      : n?.reason === 'not_requested'
        ? ' Enter the vendor\'s company name to add them.'
        : ' The clarification email could not be sent - please tell the office.';
    return { tone: 'warning', text: `Vendor could not be added: ${resolution.reason || 'the vendor name could not be read.'}${emailed}` };
  }
  if (resolution.status === 'error') {
    return { tone: 'warning', text: 'The quote was saved, but its vendor could not be added automatically.' };
  }
  return null;
}
