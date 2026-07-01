import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, Save, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MarkupCanvas, { type MarkupCanvasHandle, type MarkupShape, type MarkupTool } from './MarkupCanvas';
import VoiceTextarea from './VoiceTextarea';
import {
  type MarkupPhoto,
  deletePhotoMarkup,
  hasMarkup,
  parseAnnotations,
  photoNoteText,
  photoOriginalSrc,
  savePhotoMarkup,
  savePhotoNote,
} from '../lib/photoMarkup';

type PhotoMarkupModalProps = {
  open: boolean;
  projectId: string;
  photo: MarkupPhoto | null;
  onClose: () => void;
  onSaved: (photo: MarkupPhoto) => void;
  title?: string;
};

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#0f172a'];
const SIZES: { key: string; label: string; value: number }[] = [
  { key: 'sm', label: 'Thin', value: 0.004 },
  { key: 'md', label: 'Medium', value: 0.008 },
  { key: 'lg', label: 'Thick', value: 0.014 },
];

const TOOLS: { key: MarkupTool; label: string }[] = [
  { key: 'circle', label: 'Circle' },
  { key: 'free', label: 'Draw' },
  { key: 'arrow', label: 'Arrow' },
];

function ToolGlyph({ tool }: { tool: MarkupTool }) {
  if (tool === 'circle') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
        <ellipse cx="12" cy="12" rx="8" ry="6" />
      </svg>
    );
  }
  if (tool === 'free') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17c2-1 3-5 5-5s2 4 4 4 3-7 5-7 2 3 4 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19L19 5" />
      <path d="M10 5h9v9" />
    </svg>
  );
}

export default function PhotoMarkupModal({
  open,
  projectId,
  photo,
  onClose,
  onSaved,
  title = 'Mark up photo',
}: PhotoMarkupModalProps) {
  const canvasRef = useRef<MarkupCanvasHandle | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const [tool, setTool] = useState<MarkupTool>('circle');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<number>(SIZES[1].value);
  const [note, setNote] = useState('');
  const [shapeCount, setShapeCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [imageError, setImageError] = useState(false);

  const photoId = photo?.id ?? '';
  const imageUrl = photo ? photoOriginalSrc(projectId, photo) : '';
  const initialAnnotations = photo ? (parseAnnotations(photo) as MarkupShape[]) : [];

  // Reset editor state whenever a different photo is opened.
  useEffect(() => {
    if (!open || !photo) return;
    setNote(photoNoteText(photo));
    setTool('circle');
    setColor(COLORS[0]);
    setSize(SIZES[1].value);
    setShapeCount(0);
    setSaving(false);
    setImageError(false);
  }, [open, photoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the note so the mobile keyboard pops up (requirement). Tapping the
  // canvas blurs it again so the user can draw without the keyboard in the way.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      noteRef.current?.focus();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [open, photoId]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Escape closes (but not while saving).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  const handlePointerStart = useCallback(() => {
    // Dismiss the keyboard when the user starts drawing.
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName === 'TEXTAREA') active.blur();
  }, []);

  const handleSave = useCallback(async () => {
    if (!photo || !photoId || saving) return;
    const trimmedNote = note.trim();
    const hadMarkup = hasMarkup(photo);
    const hasShapes = (canvasRef.current?.hasContent() ?? false) && shapeCount > 0;
    setSaving(true);
    try {
      let updated: MarkupPhoto;
      if (hasShapes) {
        const composite = await canvasRef.current?.exportComposite();
        if (!composite) {
          toast.error('Could not render the markup');
          setSaving(false);
          return;
        }
        updated = await savePhotoMarkup(projectId, photoId, {
          blob: composite.blob,
          annotations: composite.annotations,
          note: trimmedNote,
        });
      } else if (hadMarkup) {
        // Markup cleared in the editor — drop the overlay, keep the note.
        await deletePhotoMarkup(projectId, photoId);
        updated = await savePhotoNote(projectId, photoId, trimmedNote);
      } else {
        updated = await savePhotoNote(projectId, photoId, trimmedNote);
      }
      toast.success(hasShapes ? 'Markup saved' : 'Saved');
      onSaved(updated);
      onClose();
    } catch (err) {
      console.error('Failed to save markup', err);
      toast.error('Failed to save. Please try again.');
      setSaving(false);
    }
  }, [photo, photoId, saving, note, shapeCount, projectId, onSaved, onClose]);

  if (!open || !photo) return null;

  return (
    <div className="fixed inset-0 z-[120] flex flex-col bg-slate-950" role="dialog" aria-modal="true" aria-label={title}>
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <button
          type="button"
          onClick={() => !saving && onClose()}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-white/80 transition hover:bg-white/10"
          aria-label="Cancel"
        >
          <X className="h-5 w-5" />
          <span className="hidden sm:inline">Cancel</span>
        </button>
        <h2 className="truncate text-sm font-bold text-white">{title}</h2>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-amber-500 px-4 text-sm font-bold text-slate-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
          <span>Save</span>
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-slate-900/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          {TOOLS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTool(t.key)}
              aria-pressed={tool === t.key}
              className={`inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition ${
                tool === t.key ? 'bg-amber-500 text-slate-950' : 'bg-white/10 text-white/80 hover:bg-white/20'
              }`}
            >
              <ToolGlyph tool={t.key} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="mx-1 h-7 w-px bg-white/10" />

        <div className="flex items-center gap-1.5">
          {COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              className={`h-8 w-8 rounded-full border-2 transition ${color === c ? 'border-amber-400 ring-2 ring-amber-400/40' : 'border-white/30'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div className="mx-1 h-7 w-px bg-white/10" />

        <div className="flex items-center gap-1.5">
          {SIZES.map(s => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSize(s.value)}
              aria-pressed={size === s.value}
              className={`inline-flex h-11 items-center rounded-lg px-3 text-xs font-semibold transition ${
                size === s.value ? 'bg-white text-slate-950' : 'bg-white/10 text-white/80 hover:bg-white/20'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => canvasRef.current?.undo()}
            disabled={shapeCount === 0}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white/80 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-5 w-5" />
            <span className="hidden sm:inline">Undo</span>
          </button>
          <button
            type="button"
            onClick={() => canvasRef.current?.clear()}
            disabled={shapeCount === 0}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white/80 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-5 w-5" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1 bg-slate-950 p-2">
        {imageError ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-white/60">
            Could not load this photo for markup.
          </div>
        ) : (
          <MarkupCanvas
            key={photoId}
            ref={canvasRef}
            imageUrl={imageUrl}
            tool={tool}
            color={color}
            strokeWidth={size}
            initialAnnotations={initialAnnotations}
            onContentChange={setShapeCount}
            onPointerStart={handlePointerStart}
            onError={() => setImageError(true)}
          />
        )}
      </div>

      {/* Note */}
      <div className="flex-shrink-0 border-t border-white/10 bg-slate-900/80 px-3 py-3">
        <label className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/60">
          Note for this photo
          {shapeCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
              <Check className="h-3 w-3" /> {shapeCount} mark{shapeCount === 1 ? '' : 's'}
            </span>
          )}
        </label>
        <VoiceTextarea
          ref={noteRef}
          value={note}
          onChange={event => setNote(event.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Describe the issue, or tap the mic to dictate…"
          className="w-full resize-none rounded-lg border border-white/15 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none"
        />
      </div>
    </div>
  );
}
