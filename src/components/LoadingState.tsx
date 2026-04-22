export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="p-8 space-y-4">
      <div className="h-6 w-48 skeleton rounded" />
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 skeleton rounded-xl" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-64 skeleton rounded-xl" />
      ))}
    </div>
  )
}

export function ErrorState({ error }: { error: string }) {
  return (
    <div className="p-8">
      <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 px-4 py-3 text-sm">
        <b>Failed to load data:</b> {error}
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
