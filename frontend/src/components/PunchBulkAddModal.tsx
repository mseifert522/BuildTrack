import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Check, FileImage, ImagePlus, ListPlus, Loader2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import { uploadProjectMedia } from '../lib/projectMediaUpload';
import { isBrowserImageMedia } from '../lib/progressMedia';

// Bulk Add for the desktop punch list: type items line by line, drop a pile of
// pictures into the tray, then drag each picture (or check it and press
// "Put here") onto the line it belongs to — a new line or an item that already
// exists. Nothing is uploaded until Save: the lines are created in one
// request, then each item's pictures go up with punch_list_item_id through the
// shared uploadProjectMedia path (chunked/split for big batches automatically).

const STAGED_PHOTO_MIME = 'application/x-bt-punch-staged-photo';
const MAX_STAGED_PHOTOS = 300;
const MAX_LINES = 200;
const UPLOAD_GROUP_SIZE = 100; // the photos endpoint accepts at most 100 files per request
const PICTURE_ACCEPT = 'image/*,.heic,.heif,.dng,.tif,.tiff';
const PICTURE_EXTENSIONS = /\.(avif|bmp|dib|gif|heic|heif|jpe?g|jfif|pjpeg|pjp|png|tiff?|webp|dng)$/i;

type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Target = { kind: 'line'; key: string } | { kind: 'item'; id: string };
type BulkLine = { key: string; title: string; priority: Priority };
type StagedPhoto = { key: string; file: File; url: string | null; target: Target | null };
type ExistingItem = { id: string; title: string; status?: string; photo_count?: number; created_now?: boolean };

const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

function newKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newLine(title = ''): BulkLine {
  return { key: newKey(), title, priority: 'medium' };
}

function isPictureFile(file: File) {
  return String(file.type || '').toLowerCase().startsWith('image/') || PICTURE_EXTENSIONS.test(String(file.name || ''));
}

function splitPastedLines(text: string) {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function targetId(target: Target | null) {
  if (!target) return 'tray';
  return target.kind === 'line' ? `line:${target.key}` : `item:${target.id}`;
}

function hasStagedPhotoDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes(STAGED_PHOTO_MIME);
}

function hasFileDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function StagedPhotoTile({
  photo,
  selected,
  compact,
  disabled,
  clearLabel,
  onToggle,
  onDragStart,
  onClear,
}: {
  photo: StagedPhoto;
  selected: boolean;
  compact?: boolean;
  disabled?: boolean;
  clearLabel: string;
  onToggle: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={selected}
      aria-label={`${photo.file.name}${selected ? ' (checked)' : ''}`}
      tabIndex={0}
      title={`${photo.file.name} — drag onto a line, or click to check it`}
      draggable={!disabled}
      onDragStart={onDragStart}
      onClick={onToggle}
      onKeyDown={event => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onToggle();
        }
      }}
      className={`group relative flex-shrink-0 cursor-grab overflow-hidden rounded-lg border bg-gray-100 outline-none transition active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-blue-400 ${compact ? 'h-12 w-12' : 'aspect-square w-full'} ${selected ? 'border-amber-400 ring-2 ring-amber-300' : 'border-gray-200'}`}
    >
      {photo.url ? (
        <img src={photo.url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center p-1 text-center">
          <FileImage className={compact ? 'h-4 w-4 text-gray-400' : 'h-6 w-6 text-gray-400'} aria-hidden="true" />
          {!compact && <span className="mt-1 w-full truncate text-[9px] font-bold text-gray-500">{photo.file.name}</span>}
        </div>
      )}
      <span
        aria-hidden="true"
        className={`absolute left-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-md border transition ${selected ? 'border-amber-400 bg-amber-500 text-white' : 'border-white/80 bg-black/50 text-white opacity-0 group-hover:opacity-100'}`}
      >
        {selected ? <Check className="h-3 w-3" /> : null}
      </span>
      <button
        type="button"
        onClick={event => { event.stopPropagation(); onClear(); }}
        aria-label={clearLabel}
        title={clearLabel}
        disabled={disabled}
        className="absolute right-1 top-1 hidden rounded-md bg-black/60 p-0.5 text-white group-hover:inline-flex"
      >
        <X className="h-3 w-3" />
      </button>
      {!compact && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 text-[9px] font-bold text-white">
          {photo.file.name}
        </div>
      )}
    </div>
  );
}

export default function PunchBulkAddModal({
  projectId,
  isOpen,
  onClose,
  onSaved,
}: {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [lines, setLines] = useState<BulkLine[]>(() => [newLine(), newLine(), newLine()]);
  const [photos, setPhotos] = useState<StagedPhoto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [items, setItems] = useState<ExistingItem[]>([]);
  const [showExisting, setShowExisting] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [saveUnmatched, setSaveUnmatched] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState('');

  const lineInputs = useRef<Map<string, HTMLInputElement>>(new Map());
  const pendingFocus = useRef<string | null>(null);
  const photosRef = useRef<StagedPhoto[]>([]);
  photosRef.current = photos;

  const revokeAll = (list: StagedPhoto[]) => {
    list.forEach(photo => { if (photo.url) URL.revokeObjectURL(photo.url); });
  };

  // Fresh sheet every time the modal opens; the existing items are loaded
  // unfiltered so every real item is available as a drop target.
  useEffect(() => {
    if (!isOpen) return;
    revokeAll(photosRef.current);
    setLines([newLine(), newLine(), newLine()]);
    setPhotos([]);
    setSelected(new Set());
    setItems([]);
    setShowExisting(false);
    setDropTarget(null);
    setSaveUnmatched(true);
    setSaving(false);
    setProgress('');
    let cancelled = false;
    api.get(`/projects/${projectId}/punch-list`)
      .then(res => {
        if (cancelled || !Array.isArray(res.data)) return;
        setItems(res.data.map((item: any) => ({
          id: String(item.id),
          title: String(item.title || ''),
          status: item.status,
          photo_count: Number(item.photo_count || 0),
        })));
      })
      .catch(() => { /* the tray still works; existing items just stay hidden */ });
    return () => { cancelled = true; };
  }, [isOpen, projectId]);

  useEffect(() => () => revokeAll(photosRef.current), []);

  useEffect(() => {
    if (!pendingFocus.current) return;
    lineInputs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [lines]);

  const unmatched = useMemo(() => photos.filter(photo => !photo.target), [photos]);
  const matchedCount = photos.length - unmatched.length;
  const titledCount = lines.filter(line => line.title.trim()).length;

  // ---- lines -------------------------------------------------------------
  const updateLine = (key: string, patch: Partial<BulkLine>) => {
    setLines(prev => prev.map(line => (line.key === key ? { ...line, ...patch } : line)));
  };

  const insertLineAfter = (key: string | null, title = '') => {
    if (lines.length >= MAX_LINES) {
      toast.error(`Up to ${MAX_LINES} lines per bulk add`);
      return;
    }
    const line = newLine(title);
    pendingFocus.current = line.key;
    setLines(prev => {
      const index = key ? prev.findIndex(item => item.key === key) : prev.length - 1;
      const next = [...prev];
      next.splice(index + 1, 0, line);
      return next;
    });
  };

  const removeLine = (key: string) => {
    setPhotos(prev => prev.map(photo => (photo.target?.kind === 'line' && photo.target.key === key ? { ...photo, target: null } : photo)));
    setLines(prev => {
      const remaining = prev.filter(line => line.key !== key);
      return remaining.length ? remaining : [newLine()];
    });
  };

  const onLineKeyDown = (line: BulkLine, index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      insertLineAfter(line.key);
    } else if (event.key === 'Backspace' && !line.title && lines.length > 1) {
      event.preventDefault();
      pendingFocus.current = lines[index - 1]?.key || lines[index + 1]?.key || null;
      removeLine(line.key);
    } else if (event.key === 'ArrowDown' && lines[index + 1]) {
      event.preventDefault();
      lineInputs.current.get(lines[index + 1].key)?.focus();
    } else if (event.key === 'ArrowUp' && lines[index - 1]) {
      event.preventDefault();
      lineInputs.current.get(lines[index - 1].key)?.focus();
    }
  };

  // Pasting a multi-line list fills this line and adds one line per extra row.
  const onLinePaste = (line: BulkLine) => (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = splitPastedLines(event.clipboardData.getData('text'));
    if (pasted.length <= 1) return;
    event.preventDefault();
    const extra = pasted.slice(1, Math.max(1, MAX_LINES - lines.length + 1)).map(title => newLine(title));
    if (extra.length) pendingFocus.current = extra[extra.length - 1].key;
    setLines(prev => {
      const index = prev.findIndex(item => item.key === line.key);
      if (index < 0) return prev;
      const next = [...prev];
      next.splice(index, 1, { ...prev[index], title: `${prev[index].title}${pasted[0]}`.slice(0, 500) }, ...extra);
      return next;
    });
    if (pasted.length - 1 > extra.length) toast.error(`Only the first ${MAX_LINES} lines were kept`);
  };

  // ---- pictures ----------------------------------------------------------
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    const pictures = files.filter(isPictureFile);
    const skipped = files.length - pictures.length;
    const room = Math.max(0, MAX_STAGED_PHOTOS - photosRef.current.length);
    const accepted = pictures.slice(0, room);
    const staged: StagedPhoto[] = accepted.map(file => ({
      key: newKey(),
      file,
      url: isBrowserImageMedia({ name: file.name, type: file.type }) ? URL.createObjectURL(file) : null,
      target: null,
    }));
    if (staged.length) setPhotos(prev => [...prev, ...staged]);
    if (pictures.length > accepted.length) toast.error(`Up to ${MAX_STAGED_PHOTOS} pictures per bulk add`);
    if (skipped) toast.error(`${plural(skipped, 'file')} skipped — pictures only`);
  };

  const placePhotos = (keys: string[], target: Target | null) => {
    const keySet = new Set(keys);
    setPhotos(prev => prev.map(photo => (keySet.has(photo.key) ? { ...photo, target } : photo)));
    setSelected(new Set());
  };

  const discardPhoto = (key: string) => {
    const photo = photosRef.current.find(item => item.key === key);
    if (photo?.url) URL.revokeObjectURL(photo.url);
    setPhotos(prev => prev.filter(item => item.key !== key));
    setSelected(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const toggleSelected = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startPhotoDrag = (photo: StagedPhoto) => (event: DragEvent<HTMLDivElement>) => {
    const keys = selected.has(photo.key) ? Array.from(selected) : [photo.key];
    event.dataTransfer.setData(STAGED_PHOTO_MIME, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = 'move';
    if (keys.length > 1) {
      const ghost = document.createElement('div');
      ghost.textContent = `${keys.length} pictures`;
      ghost.style.cssText = 'position:fixed;top:-100px;left:-100px;padding:6px 10px;border-radius:8px;background:#f59e0b;color:#0f172a;font:700 12px system-ui,sans-serif;';
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 24, 14);
      window.setTimeout(() => ghost.remove(), 0);
    }
  };

  const dropHandlers = (target: Target | null, acceptFiles = false) => {
    const id = targetId(target);
    const accepts = (event: DragEvent) => hasStagedPhotoDrag(event) || (acceptFiles && hasFileDrag(event));
    return {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (saving || !accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(id);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (saving || !accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = hasStagedPhotoDrag(event) ? 'move' : 'copy';
        if (dropTarget !== id) setDropTarget(id);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget(current => (current === id ? null : current));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (saving || !accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        if (hasStagedPhotoDrag(event)) {
          let keys: string[] = [];
          try {
            const parsed = JSON.parse(event.dataTransfer.getData(STAGED_PHOTO_MIME));
            if (Array.isArray(parsed)) keys = parsed.map(String);
          } catch {
            keys = [];
          }
          if (keys.length) placePhotos(keys, target);
        } else {
          addFiles(Array.from(event.dataTransfer.files || []));
        }
      },
    };
  };

  // ---- save --------------------------------------------------------------
  const save = async () => {
    if (saving) return;
    const titled = lines.filter(line => line.title.trim());
    const orphanLine = lines.find(line => !line.title.trim() && photos.some(photo => photo.target?.kind === 'line' && photo.target.key === line.key));
    if (orphanLine) {
      toast.error(`Line ${lines.indexOf(orphanLine) + 1} has pictures but no title`);
      lineInputs.current.get(orphanLine.key)?.focus();
      return;
    }
    const onExisting = photos.some(photo => photo.target?.kind === 'item');
    if (!titled.length && !onExisting) {
      toast.error('Type at least one punch list line, or match pictures to an existing item');
      return;
    }

    setSaving(true);
    let workingPhotos = photos;
    let workingItems = items;
    let createdCount = 0;
    let uploadedCount = 0;
    let bucketCount = 0;
    let discardedCount = 0;
    const finishUpload = (done: StagedPhoto[]) => {
      const keys = new Set(done.map(photo => photo.key));
      revokeAll(done);
      workingPhotos = workingPhotos.filter(photo => !keys.has(photo.key));
      setPhotos(workingPhotos);
    };
    const uploadGroup = (group: StagedPhoto[], fields: Record<string, string>) => {
      const form = new FormData();
      group.forEach(photo => form.append('photos', photo.file));
      form.append('capture_project_id', projectId);
      form.append('client_project_id', projectId);
      Object.entries(fields).forEach(([key, value]) => form.append(key, value));
      return uploadProjectMedia(projectId, form);
    };

    try {
      if (titled.length) {
        setProgress(`Creating ${plural(titled.length, 'item')}…`);
        const res = await api.post(`/projects/${projectId}/punch-list/bulk`, {
          items: titled.map(line => ({ client_key: line.key, title: line.title.trim(), priority: line.priority, status: 'not_started' })),
        });
        const created: Array<{ id: string; title: string; client_key?: string | null }> = Array.isArray(res.data?.items) ? res.data.items : [];
        createdCount = created.length;
        const idByKey = new Map<string, string>();
        created.forEach((row, index) => idByKey.set(String(row.client_key || titled[index]?.key || ''), String(row.id)));
        // The lines are real items now: show them with the existing items and
        // re-point their pictures so a failed upload can simply be retried.
        workingItems = [
          ...created.map(row => ({ id: String(row.id), title: String(row.title || ''), status: 'not_started', photo_count: 0, created_now: true })),
          ...workingItems,
        ];
        workingPhotos = workingPhotos.map(photo => {
          if (photo.target?.kind !== 'line') return photo;
          const id = idByKey.get(photo.target.key);
          return { ...photo, target: id ? { kind: 'item', id } : null };
        });
        setItems(workingItems);
        setShowExisting(true);
        setPhotos(workingPhotos);
        setLines([newLine()]);
      }

      const groups = new Map<string, StagedPhoto[]>();
      workingPhotos.forEach(photo => {
        if (photo.target?.kind !== 'item') return;
        const list = groups.get(photo.target.id) || [];
        list.push(photo);
        groups.set(photo.target.id, list);
      });
      const totalMatched = Array.from(groups.values()).reduce((sum, list) => sum + list.length, 0);
      for (const [itemId, group] of groups) {
        const title = workingItems.find(item => item.id === itemId)?.title || 'punch list item';
        for (let start = 0; start < group.length; start += UPLOAD_GROUP_SIZE) {
          const slice = group.slice(start, start + UPLOAD_GROUP_SIZE);
          setProgress(`Uploading pictures ${uploadedCount + 1}–${uploadedCount + slice.length} of ${totalMatched} · ${title}`);
          await uploadGroup(slice, { punch_list_item_id: itemId, caption: `Punch list: ${title}` });
          uploadedCount += slice.length;
          finishUpload(slice);
        }
      }

      const leftover = workingPhotos.filter(photo => !photo.target);
      if (leftover.length && saveUnmatched) {
        for (let start = 0; start < leftover.length; start += UPLOAD_GROUP_SIZE) {
          const slice = leftover.slice(start, start + UPLOAD_GROUP_SIZE);
          setProgress(`Saving unmatched pictures ${bucketCount + 1}–${bucketCount + slice.length} of ${leftover.length} to the Photos Bucket`);
          await uploadGroup(slice, { caption: 'Punch list bulk upload (not matched to an item)' });
          bucketCount += slice.length;
          finishUpload(slice);
        }
      } else if (leftover.length) {
        discardedCount = leftover.length;
        finishUpload(leftover);
      }

      const summary: string[] = [];
      if (createdCount) summary.push(`${plural(createdCount, 'item')} added`);
      if (uploadedCount) summary.push(`${plural(uploadedCount, 'picture')} matched`);
      if (bucketCount) summary.push(`${bucketCount} saved to the Photos Bucket`);
      if (discardedCount) summary.push(`${discardedCount} unmatched not uploaded`);
      toast.success(summary.join(' · ') || 'Saved');
      await onSaved();
      onClose();
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Bulk add failed';
      const kept: string[] = [];
      if (createdCount) kept.push(`${plural(createdCount, 'item')} created`);
      if (uploadedCount) kept.push(`${plural(uploadedCount, 'picture')} uploaded`);
      toast.error(`${message}.${kept.length ? ` Already saved: ${kept.join(', ')}.` : ''} Press Save again to finish the rest.`, { duration: 8000 });
      if (createdCount || uploadedCount) await onSaved();
    } finally {
      setSaving(false);
      setProgress('');
    }
  };

  const handleClose = () => {
    if (saving) return;
    revokeAll(photosRef.current);
    setPhotos([]);
    onClose();
  };

  const saveLabel = (() => {
    const parts: string[] = [];
    if (titledCount) parts.push(plural(titledCount, 'item'));
    if (matchedCount) parts.push(plural(matchedCount, 'picture'));
    return parts.length ? `Save ${parts.join(' · ')}` : 'Save';
  })();

  const putHereButton = (target: Target) => (
    selected.size > 0 ? (
      <button
        type="button"
        onClick={() => placePhotos(Array.from(selected), target)}
        disabled={saving}
        className="flex-shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-black text-amber-700 hover:bg-amber-100"
      >
        Put {selected.size} here
      </button>
    ) : null
  );

  const photoStrip = (list: StagedPhoto[], clearLabel: string) => (
    list.length > 0 ? (
      <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
        {list.map(photo => (
          <StagedPhotoTile
            key={photo.key}
            photo={photo}
            compact
            selected={selected.has(photo.key)}
            disabled={saving}
            clearLabel={clearLabel}
            onToggle={() => toggleSelected(photo.key)}
            onDragStart={startPhotoDrag(photo)}
            onClear={() => placePhotos([photo.key], null)}
          />
        ))}
      </div>
    ) : null
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Bulk Add Punch List Items"
      description="One line per item. Drop pictures in the tray, then drag each one onto its line — or check pictures and press “Put here”."
      size="xl"
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-black uppercase tracking-wide text-gray-500">New items · {titledCount}</p>
            <button
              type="button"
              onClick={() => insertLineAfter(lines[lines.length - 1]?.key || null)}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-bold text-gray-700 hover:bg-gray-100 disabled:opacity-60"
            >
              <ListPlus className="h-3.5 w-3.5" aria-hidden="true" /> Add line
            </button>
          </div>

          <ol className="space-y-1.5">
            {lines.map((line, index) => {
              const linePhotos = photos.filter(photo => photo.target?.kind === 'line' && photo.target.key === line.key);
              const isOver = dropTarget === `line:${line.key}`;
              return (
                <li
                  key={line.key}
                  {...dropHandlers({ kind: 'line', key: line.key })}
                  className={`rounded-xl border bg-white px-2.5 py-2 transition ${isOver ? 'border-amber-400 ring-2 ring-amber-300/70' : 'border-gray-200'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 flex-shrink-0 text-right text-[11px] font-black tabular-nums text-gray-400">{index + 1}.</span>
                    <input
                      ref={element => {
                        if (element) lineInputs.current.set(line.key, element);
                        else lineInputs.current.delete(line.key);
                      }}
                      value={line.title}
                      onChange={event => updateLine(line.key, { title: event.target.value.slice(0, 500) })}
                      onKeyDown={onLineKeyDown(line, index)}
                      onPaste={onLinePaste(line)}
                      disabled={saving}
                      placeholder={index === 0 ? 'Type an item, press Enter for the next line…' : ''}
                      aria-label={`Line ${index + 1} title`}
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-300/60"
                    />
                    <select
                      value={line.priority}
                      onChange={event => updateLine(line.key, { priority: event.target.value as Priority })}
                      disabled={saving}
                      aria-label={`Line ${index + 1} priority`}
                      className="flex-shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-bold text-gray-700 outline-none focus:border-blue-400"
                    >
                      {PRIORITIES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {putHereButton({ kind: 'line', key: line.key })}
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      disabled={saving}
                      aria-label={`Remove line ${index + 1}`}
                      title="Remove line"
                      className="flex-shrink-0 rounded-lg p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {photoStrip(linePhotos, 'Unmatch picture (back to the tray)')}
                </li>
              );
            })}
          </ol>
          <p className="text-[11px] text-gray-500">Enter = next line · paste a list to fill several lines · Backspace on an empty line removes it</p>

          {items.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white">
              <button
                type="button"
                onClick={() => setShowExisting(value => !value)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-black uppercase tracking-wide text-gray-500"
                aria-expanded={showExisting}
              >
                <span>Existing items · {items.length}</span>
                <span className="normal-case tracking-normal text-gray-400">{showExisting ? 'Hide' : 'Show'} — pictures can go on these too</span>
              </button>
              {showExisting && (
                <ul>
                  {items.map(item => {
                    const itemPhotos = photos.filter(photo => photo.target?.kind === 'item' && photo.target.id === item.id);
                    const isOver = dropTarget === `item:${item.id}`;
                    const completed = item.status === 'completed';
                    return (
                      <li
                        key={item.id}
                        {...dropHandlers({ kind: 'item', id: item.id })}
                        className={`border-t border-gray-200 px-3 py-2 transition ${isOver ? 'bg-amber-50 ring-2 ring-inset ring-amber-300/70' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${completed ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden="true" />
                          <p className={`min-w-0 flex-1 truncate text-sm font-semibold ${completed ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{item.title}</p>
                          {item.created_now && <span className="flex-shrink-0 rounded-full bg-blue-50 px-1.5 text-[10px] font-black text-blue-700">new</span>}
                          {(item.photo_count || 0) > 0 && <span className="flex-shrink-0 text-[11px] text-gray-500">{plural(item.photo_count || 0, 'photo')}</span>}
                          {putHereButton({ kind: 'item', id: item.id })}
                        </div>
                        {photoStrip(itemPhotos, 'Unmatch picture (back to the tray)')}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 md:sticky md:top-0 md:self-start">
          <div
            {...dropHandlers(null, true)}
            className={`rounded-2xl border-2 border-dashed bg-white p-3 transition ${dropTarget === 'tray' ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-black uppercase tracking-wide text-gray-500">Pictures · {unmatched.length} unmatched</p>
              <label className={`inline-flex items-center gap-1 rounded-lg border border-blue-300/60 bg-blue-600 px-2.5 py-1 text-xs font-black text-white hover:bg-blue-500 ${saving ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" /> Add pictures
                <input
                  type="file"
                  accept={PICTURE_ACCEPT}
                  multiple
                  className="hidden"
                  disabled={saving}
                  onChange={event => {
                    addFiles(Array.from(event.target.files || []));
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            </div>

            {selected.size > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700">
                <span>{plural(selected.size, 'picture')} checked — press “Put here” on a line</span>
                <button type="button" onClick={() => setSelected(new Set())} className="font-black underline">Clear</button>
              </div>
            )}

            {unmatched.length === 0 ? (
              <div className="mt-3 rounded-xl bg-gray-50 px-3 py-8 text-center">
                <FileImage className="mx-auto mb-2 h-7 w-7 text-gray-300" aria-hidden="true" />
                <p className="text-sm font-bold text-gray-500">{photos.length ? 'Every picture is matched to a line' : 'Drop pictures here, or click Add pictures'}</p>
                <p className="mt-1 text-[11px] text-gray-400">{photos.length ? 'Drag a picture back here to unmatch it' : 'Then drag each picture onto its line'}</p>
              </div>
            ) : (
              <div className="mt-3 grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-3">
                {unmatched.map(photo => (
                  <StagedPhotoTile
                    key={photo.key}
                    photo={photo}
                    selected={selected.has(photo.key)}
                    disabled={saving}
                    clearLabel="Remove picture from this upload"
                    onToggle={() => toggleSelected(photo.key)}
                    onDragStart={startPhotoDrag(photo)}
                    onClear={() => discardPhoto(photo.key)}
                  />
                ))}
              </div>
            )}
            {matchedCount > 0 && unmatched.length > 0 && (
              <p className="mt-2 text-[11px] text-gray-500">{matchedCount} matched · drag a picture back here to unmatch it</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-gray-200 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <label className={`inline-flex items-center gap-2 text-xs font-semibold text-gray-600 ${unmatched.length ? '' : 'opacity-50'}`}>
          <input
            type="checkbox"
            checked={saveUnmatched}
            onChange={event => setSaveUnmatched(event.target.checked)}
            disabled={!unmatched.length || saving}
            className="h-4 w-4 accent-blue-600"
          />
          Save unmatched pictures to the Photos Bucket
        </label>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {progress && <span className="text-xs font-semibold text-gray-500" aria-live="polite">{progress}</span>}
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="min-h-10 rounded-xl border border-gray-300 bg-white px-4 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-blue-300/60 bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
