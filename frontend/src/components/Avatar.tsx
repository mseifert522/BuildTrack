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

  useEffect(() => {
    setFailedSrc(null);
  }, [normalizedSrc]);

  const initials = useMemo(() => initialsFor(name), [name]);
  const canShowImage = Boolean(normalizedSrc && failedSrc !== normalizedSrc);
  const baseStyle: CSSProperties = { width: size, height: size, ...style };
  const commonClassName = `${roundedClassName} flex-shrink-0 overflow-hidden ${className}`.trim();

  if (canShowImage) {
    return (
      <img
        src={normalizedSrc}
        alt={alt || (name ? `${name} profile photo` : 'User profile photo')}
        className={`${commonClassName} object-cover bg-slate-100 ${imageClassName}`.trim()}
        style={{ objectPosition: 'center top', ...baseStyle, ...imageStyle }}
        onError={() => setFailedSrc(normalizedSrc)}
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
