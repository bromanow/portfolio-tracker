import { Loader2 } from 'lucide-react'
import type { SecurityNewsItem } from '../api/client'

// Shared between the security detail card's News tab and the Dashboard's Market News
// section, so a news item looks and behaves identically everywhere.
export default function NewsList({
  items, isLoading, emptyMessage = 'No news found.', compact = false,
}: {
  items: SecurityNewsItem[] | undefined
  isLoading: boolean
  emptyMessage?: string
  /** Compact mode: smaller thumbnails, no summary line — for tighter spaces like the Dashboard. */
  compact?: boolean
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading news…
      </div>
    )
  }
  if (!items || items.length === 0) {
    return <p className="text-sm text-gray-400">{emptyMessage}</p>
  }
  return (
    <div className="space-y-3">
      {items.map(item => (
        <a
          key={item.id}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 transition-colors"
        >
          {item.thumbnail_url && (
            <img
              src={item.thumbnail_url}
              alt=""
              className={`${compact ? 'w-14 h-14' : 'w-20 h-20'} object-cover rounded-md flex-shrink-0 bg-gray-100`}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 leading-snug">{item.title}</p>
            {!compact && item.summary && (
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.summary}</p>
            )}
            <p className="text-xs text-gray-400 mt-1.5">
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
