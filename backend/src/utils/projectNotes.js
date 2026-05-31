const NOTE_ADMIN_ROLES = ['super_admin', 'operations_manager'];
const CONTRACTOR_NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function parseStoredDate(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canOverrideNoteEdit(user) {
  return NOTE_ADMIN_ROLES.includes(user?.role);
}

function isWithinContractorNoteEditWindow(note, now = Date.now()) {
  const createdAt = parseStoredDate(note?.created_at);
  if (!createdAt) return false;
  return now - createdAt.getTime() <= CONTRACTOR_NOTE_EDIT_WINDOW_MS;
}

function getNoteEditPermission(user, note) {
  const isOwner = note?.user_id === user?.id;
  const canOverride = canOverrideNoteEdit(user);

  if (!isOwner && !canOverride) {
    return { allowed: false, status: 403, error: 'You can only edit your own notes' };
  }

  if (user?.role === 'contractor') {
    if (!isOwner) {
      return { allowed: false, status: 403, error: 'Contractors can only edit their own notes' };
    }
    if (!isWithinContractorNoteEditWindow(note)) {
      return { allowed: false, status: 403, error: 'Contractor notes can only be edited within 24 hours of posting' };
    }
    return { allowed: true };
  }

  if (!canOverride && Number(note?.edit_count || 0) >= 1) {
    return { allowed: false, status: 403, error: 'This note has already been edited once' };
  }

  return { allowed: true };
}

module.exports = {
  CONTRACTOR_NOTE_EDIT_WINDOW_MS,
  canOverrideNoteEdit,
  getNoteEditPermission,
  isWithinContractorNoteEditWindow,
};
