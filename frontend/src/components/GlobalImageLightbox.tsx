import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';

type LightboxImage = {
  src: string;
  alt: string;
};

const SKIP_SRC_PATTERN = /buildtrack-logo|logo-mark|truth-icon|nud-company-logo/i;

function shouldOpenImage(img: HTMLImageElement) {
  const src = img.currentSrc || img.src || '';
  if (!src || SKIP_SRC_PATTERN.test(src)) return false;
  if (img.closest('[data-no-image-lightbox="true"]')) return false;
  if (img.closest('button,a,label,[role="button"]') && !img.closest('[data-global-image-lightbox="true"]')) return false;
  const naturalWidth = img.naturalWidth || 0;
  const naturalHeight = img.naturalHeight || 0;
  return naturalWidth >= 80 || naturalHeight >= 80 || /^blob:|^data:image\//i.test(src);
}

export default function GlobalImageLightbox() {
  const [image, setImage] = useState<LightboxImage | null>(null);
  const location = useLocation();

  // Close the enlarged-photo overlay whenever the route changes, so navigating
  // away (e.g. "Back to Dashboard") is never hidden behind a stale lightbox.
  useEffect(() => {
    setImage(null);
  }, [location.pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const img = target.closest('img');
      if (!(img instanceof HTMLImageElement) || !shouldOpenImage(img)) return;
      event.preventDefault();
      event.stopPropagation();
      setImage({
        src: img.currentSrc || img.src,
        alt: img.alt || 'BuildTrack photo',
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImage(null);
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/90 p-4"
      onClick={() => setImage(null)}
      role="dialog"
      aria-modal="true"
      aria-label="Enlarged photo"
    >
      <img
        src={image.src}
        alt={image.alt}
        className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
        onClick={event => event.stopPropagation()}
      />
      <button
        type="button"
        onClick={() => setImage(null)}
        className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25"
        aria-label="Close enlarged photo"
      >
        <X className="h-6 w-6" />
      </button>
    </div>
  );
}
