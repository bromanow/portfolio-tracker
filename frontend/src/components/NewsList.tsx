import { Loader2 } from 'lucide-react'
import type { SecurityNewsItem } from '../api/client'

// Shared between the security detail card's News tab and the Dashboard's news sections,
// so a news item looks and behaves identically everywhere.
export default function NewsList({
  items, isLoading, emptyMessage = 'No news found.', compact = false, columns = 1,
}: {
  items: SecurityNewsItem[] | undefined
  isLoading: boolean
  emptyMessage?: string
  /** Compact mode: smaller thumbnails, no summary line — for tighter spaces like the Dashboard. */
  compact?: boolean
  /** Responsive column count (grid on md+, always 1 column on mobile). */
  columns?: 1 | 2 | 3
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading news…
      </div>
    )
  }
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  }
  const gridClass = columns === 3 ? 'md:grid-cols-3' : columns === 2 ? 'md:grid-cols-2' : ''
  return (
    <div className={`grid grid-cols-1 ${gridClass} gap-3`}>
      {items.map(item => (
        <a
          key={item.id}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-3 p-3 rounded-lg border border-border/60 hover:border-border hover:bg-accent/50 transition-colors"
        >
          {item.thumbnail_url && (
            <img
              src={item.thumbnail_url}
              alt=""
              className={`${compact ? 'w-14 h-14' : 'w-20 h-20'} object-cover rounded-md flex-shrink-0 bg-accent`}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground leading-snug">{item.title}</p>
            {!compact && item.summary && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1.5">
              {item.publisher}
              {item.published_at && (
                <> · {new Date(item.published_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</>
              )}
            </p>
          </div>
        </a>
      ))}
    </div>
  )
}
