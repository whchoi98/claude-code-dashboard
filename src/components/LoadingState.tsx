import { useState } from 'react'
import { useT } from '../lib/i18n'

export function LoadingState({ rows = 3 }: { rows?: number }) {
  const t = useT()
  return (
    <div role="status" aria-live="polite" className="p-4 lg:p-8">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="space-y-4">
        <div className="h-6 w-48 skeleton rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 skeleton rounded-xl" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-64 skeleton rounded-xl" />
        ))}
      </div>
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void | Promise<void> }) {
  const t = useT()
  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    try { await onRetry() }
    catch { /* The owning request keeps its error state visible. */ }
    finally { setRetrying(false) }
  }
  return (
    <div className="p-4 lg:p-8">
      <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 px-4 py-4 text-sm">
        <p className="font-semibold">{t('common.error')}</p>
        <p className="mt-1">{t('common.error_hint')}</p>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">{t('common.error_details')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
        </details>
        {onRetry && (
          <button
            type="button"
            onClick={() => { void retry() }}
            disabled={retrying}
            className="mt-3 rounded-lg border border-rose-200 bg-white px-3 py-2 font-medium hover:bg-rose-100 disabled:opacity-50"
          >
            {t(retrying ? 'common.retrying' : 'common.retry')}
          </button>
        )}
      </div>
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 bg-paper-muted/40 py-10 text-center">
      <div className="text-sm font-medium text-ink-600">{title}</div>
      {hint && <div className="text-xs text-ink-400 mt-1">{hint}</div>}
    </div>
  )
}
