import { useEffect, useState } from 'react';
import { authedObjectUrl } from '../lib/authFiles';

// An <img> for a file behind /api (needs the Bearer token, so it is fetched as a blob).
export default function AuthedImage({ url, mime, alt, className, onClick }: {
  url: string;
  mime?: string | null;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let made: string | null = null;
    setSrc(null);
    setFailed(false);
    authedObjectUrl(url, mime)
      .then(objectUrl => {
        made = objectUrl;
        if (active) setSrc(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, mime]);

  if (failed) return null;
  if (!src) return <div className={`${className || ''} animate-pulse`} style={{ background: 'rgba(148, 163, 184, 0.15)' }} aria-label="Loading image" />;
  return <img src={src} alt={alt} className={className} onClick={onClick} data-no-image-lightbox="true" />;
}
