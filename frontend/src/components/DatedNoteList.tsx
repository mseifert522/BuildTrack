import { Fragment, type Key, type ReactNode } from 'react';
import { formatEasternDate } from '../lib/time';

type DatedItem = { id?: string; created_at?: string | null };

/** Keep the caller's ordering and actions, with shared day and entry boundaries. */
export default function DatedNoteList<T extends DatedItem>({
  items,
  children,
  getTimestamp = item => item.created_at,
  getKey = (item, index) => item.id || index,
  className = '',
}: {
  items: readonly T[];
  children: (item: T, index: number) => ReactNode;
  getTimestamp?: (item: T) => string | null | undefined;
  getKey?: (item: T, index: number) => Key;
  className?: string;
}) {
  const days = items.map(item => {
    const date = formatEasternDate(getTimestamp(item), {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    return date === '-' ? 'Date unavailable' : date;
  });

  return (
    <div className={`bt-note-feed ${className}`}>
      {items.map((item, index) => (
        <Fragment key={getKey(item, index)}>
          {(index === 0 || days[index] !== days[index - 1]) && (
            <h3 className="bt-note-day" title="New York time">
              <span>{days[index]}</span>
            </h3>
          )}
          <div className="bt-note-entry" data-note-day={days[index]}>
            {children(item, index)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
