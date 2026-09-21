import { useEffect, useMemo, useState, type CSSProperties } from 'react';

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  alt?: string;
  size?: number;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
  roundedClassName?: string;
  style?: CSSProperties;
  imageStyle?: CSSProperties;
  fallbackStyle?: CSSProperties;
}

// The signed-in user's avatar renders from the cached user in localStorage, so on a
// fresh page load it can be requested before the first API response issues the
// /uploads login cookie (__Host-bt_files) and 401. An /uploads image that fails is
// retried ONCE after a short delay, cache-busted, before falling back to initials.
// A src whose retry also failed is not retried again for the rest of the page load.
const RETRY_DELAY_MS = 2000;
const failedAfterRetry = new Set<string>();

const initialsFor = (name?: string | null) => {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return '?';
  return parts
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase();
};

export default function Avatar({
  src,
  name,
  alt,
  size = 36,
  className = '',
  imageClassName = '',
  fallbackClassName = '',
  roundedClassName = 'rounded-xl',
  style,
  imageStyle,
  fallbackStyle,
}: AvatarProps) {
  const normalizedSrc = String(src || '').trim();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // url is null while the retry delay runs (initials show meanwhile).
  const [retry, setRetry] = useState<{ src: string; url: string | null } | null>(null);

  useEffect(() => {
    setFailedSrc(null);
    setRetry(null);
  }, [normalizedSrc]);

  useEffect(() => {
    if (!retry || retry.url !== null) return;
    const timer = window.setTimeout(() => {
      const separator = retry.src.includes('?') ? '&' : '?';
      setRetry({ src: retry.src, url: `${retry.src}${separator}_r=${Date.now().toString(36)}` });
    }, RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [retry]);

  const initials = useMemo(() => initialsFor(name), [name]);
  const activeRetry = retry?.src === normalizedSrc ? retry : null;
  const imageSrc = activeRetry ? activeRetry.url : normalizedSrc;
  const canShowImage = Boolean(imageSrc && failedSrc !== normalizedSrc);

  const handleImageError = () => {
    if (!activeRetry && normalizedSrc.startsWith('/uploads/') && !failedAfterRetry.has(normalizedSrc)) {
      setRetry({ src: normalizedSrc, url: null });
      return;
    }
    if (activeRetry) failedAfterRetry.add(normalizedSrc);
    setFailedSrc(normalizedSrc);
  };
  const baseStyle: CSSProperties = { width: size, height: size, ...style };
  const commonClassName = `${roundedClassName} flex-shrink-0 overflow-hidden ${className}`.trim();

  if (canShowImage) {
    return (
      <img
        src={imageSrc || undefined}
        alt={alt || (name ? `${name} profile photo` : 'User profile photo')}
        className={`${commonClassName} object-cover bg-slate-100 ${imageClassName}`.trim()}
        style={{ objectPosition: 'center top', ...baseStyle, ...imageStyle }}
        onError={handleImageError}
      />
    );
  }

  return (
    <div
      className={`${commonClassName} flex items-center justify-center text-white font-black ${fallbackClassName}`.trim()}
      style={{
        ...baseStyle,
        fontSize: Math.max(11, Math.round(size * 0.36)),
        background: 'linear-gradient(135deg, #D99D26, #C4891F)',
        ...fallbackStyle,
      }}
      aria-label={alt || (name ? `${name} profile initials` : 'User profile initials')}
    >
      {initials}
    </div>
  );
}
