import {
  type PointerEvent as ReactPointerEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

// Lightweight, dependency-free photo markup surface.
// - Renders the photo INTO a <canvas> (no <img>, so the global image lightbox
//   never intercepts drawing).
// - Stores shapes in normalized 0..1 image coordinates so they scale to any
//   display size and export at full photo resolution.

export type MarkupTool = 'circle' | 'free' | 'arrow';

type Point = { x: number; y: number };

export type MarkupShape =
  | { type: 'free'; points: Point[]; color: string; width: number }
  | { type: 'circle'; start: Point; end: Point; color: string; width: number }
  | { type: 'arrow'; start: Point; end: Point; color: string; width: number };

export type MarkupCanvasHandle = {
  undo: () => void;
  clear: () => void;
  hasContent: () => boolean;
  exportComposite: () => Promise<{ blob: Blob; annotations: MarkupShape[] } | null>;
};

type MarkupCanvasProps = {
  imageUrl: string;
  tool: MarkupTool;
  color: string;
  /** Stroke width as a fraction of the image's shorter side (e.g. 0.006). */
  strokeWidth: number;
  initialAnnotations?: MarkupShape[] | null;
  onContentChange?: (count: number) => void;
  onReady?: () => void;
  onError?: () => void;
  onPointerStart?: () => void;
  className?: string;
};

const EXPORT_MAX_SIDE = 2000;

type Rect = { x: number; y: number; w: number; h: number };

function containRect(boxW: number, boxH: number, imgW: number, imgH: number): Rect {
  if (!imgW || !imgH) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkupShape,
  rect: Rect,
  minSide: number,
) {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, shape.width * minSide);

  const toPx = (p: Point) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h });

  if (shape.type === 'free') {
    if (shape.points.length === 0) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    const first = toPx(shape.points[0]);
    ctx.moveTo(first.x, first.y);
    if (shape.points.length === 1) {
      ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < shape.points.length; i += 1) {
        const p = toPx(shape.points[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  } else if (shape.type === 'circle') {
    const a = toPx(shape.start);
    const b = toPx(shape.end);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // arrow
    const a = toPx(shape.start);
    const b = toPx(shape.end);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(ctx.lineWidth * 3.2, minSide * 0.03);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

const MarkupCanvas = forwardRef<MarkupCanvasHandle, MarkupCanvasProps>(function MarkupCanvas(
  {
    imageUrl,
    tool,
    color,
    strokeWidth,
    initialAnnotations,
    onContentChange,
    onReady,
    onError,
    onPointerStart,
    className = '',
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<MarkupShape[]>(initialAnnotations ?? []);
  const shapesRef = useRef<MarkupShape[]>(initialAnnotations ?? []);
  const draftRef = useRef<MarkupShape | null>(null);
  const drawingRef = useRef(false);
  const [imgReady, setImgReady] = useState(false);

  // Keep live config in refs so pointer handlers never read stale closures.
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const widthRef = useRef(strokeWidth);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { widthRef.current = strokeWidth; }, [strokeWidth]);

  useEffect(() => { shapesRef.current = shapes; }, [shapes]);

  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const img = imgRef.current;
    if (!img) return;
    const rect = containRect(cssW, cssH, img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);

    const minSide = Math.min(rect.w, rect.h);
    for (const shape of shapesRef.current) drawShape(ctx, shape, rect, minSide);
    if (draftRef.current) drawShape(ctx, draftRef.current, rect, minSide);
  }, []);

  // Load the image (same-origin or blob: => no canvas taint).
  useEffect(() => {
    setImgReady(false);
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setImgReady(true);
      sizeCanvas();
      draw();
      onReady?.();
    };
    img.onerror = () => {
      if (cancelled) return;
      onError?.();
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
    // Only reload when the image source changes; sizeCanvas/draw are stable and
    // onReady/onError just flip stable state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Redraw on shape changes and report content count.
  useEffect(() => {
    draw();
    onContentChange?.(shapes.length);
  }, [shapes, draw, onContentChange]);

  // Responsive: resize the canvas buffer with its container.
  useEffect(() => {
    if (!imgReady) return;
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      sizeCanvas();
      draw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [imgReady, sizeCanvas, draw]);

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return null;
    const bounds = canvas.getBoundingClientRect();
    const cssW = bounds.width;
    const cssH = bounds.height;
    const rect = containRect(cssW, cssH, img.naturalWidth, img.naturalHeight);
    if (rect.w <= 0 || rect.h <= 0) return null;
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    return { x: clamp01((px - rect.x) / rect.w), y: clamp01((py - rect.y) / rect.h) };
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imgRef.current) return;
    onPointerStart?.();
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    drawingRef.current = true;
    const t = toolRef.current;
    const common = { color: colorRef.current, width: widthRef.current };
    if (t === 'free') {
      draftRef.current = { type: 'free', points: [point], ...common };
    } else if (t === 'circle') {
      draftRef.current = { type: 'circle', start: point, end: point, ...common };
    } else {
      draftRef.current = { type: 'arrow', start: point, end: point, ...common };
    }
    draw();
  }, [pointFromEvent, draw, onPointerStart]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !draftRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    const draft = draftRef.current;
    if (draft.type === 'free') {
      draft.points.push(point);
    } else {
      draft.end = point;
    }
    draw();
  }, [pointFromEvent, draw]);

  const commitDraft = useCallback(() => {
    const draft = draftRef.current;
    drawingRef.current = false;
    draftRef.current = null;
    if (!draft) return;
    // Discard trivial taps for shapes (a single tap on free leaves a dot, which is fine).
    if (draft.type !== 'free') {
      const dx = Math.abs(draft.end.x - draft.start.x);
      const dy = Math.abs(draft.end.y - draft.start.y);
      if (dx < 0.01 && dy < 0.01) {
        draw();
        return;
      }
    }
    setShapes(prev => [...prev, draft]);
  }, [draw]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    commitDraft();
  }, [commitDraft]);

  useImperativeHandle(ref, () => ({
    undo: () => setShapes(prev => prev.slice(0, -1)),
    clear: () => setShapes([]),
    hasContent: () => shapesRef.current.length > 0,
    exportComposite: async () => {
      const img = imgRef.current;
      if (!img) return null;
      const naturalW = img.naturalWidth || 1;
      const naturalH = img.naturalHeight || 1;
      const scale = Math.min(1, EXPORT_MAX_SIDE / Math.max(naturalW, naturalH));
      const outW = Math.max(1, Math.round(naturalW * scale));
      const outH = Math.max(1, Math.round(naturalH * scale));
      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const octx = out.getContext('2d');
      if (!octx) return null;
      octx.drawImage(img, 0, 0, outW, outH);
      const rect: Rect = { x: 0, y: 0, w: outW, h: outH };
      const minSide = Math.min(outW, outH);
      for (const shape of shapesRef.current) drawShape(octx, shape, rect, minSide);
      const blob = await new Promise<Blob | null>(resolve =>
        out.toBlob(b => resolve(b), 'image/jpeg', 0.9),
      );
      if (!blob) return null;
      return { blob, annotations: shapesRef.current };
    },
  }), []);

  return (
    <div ref={wrapRef} className={`relative h-full w-full ${className}`} data-no-image-lightbox="true">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
      {!imgReady && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/70">
          Loading photo…
        </div>
      )}
    </div>
  );
});

export default MarkupCanvas;
