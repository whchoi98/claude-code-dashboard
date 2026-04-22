import clsx from 'clsx'

type Props = {
  title: string
  subtitle?: string
  right?: React.ReactNode
  source?: 'live' | 'mock'
  reason?: string
}

export function PageHeader({ title, subtitle, right, source, reason }: Props) {
  return (
    <div className="px-8 pt-8 pb-6 border-b border-ink-100 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-800 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 mt-1 max-w-2xl">{subtitle}</p>}
        {source && (
          <div className="mt-2 flex items-center gap-2">
            <span className={clsx(
              'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full',
              source === 'live'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-claude-50 text-claude-700 border border-claude-200',
            )}>
              <span className={clsx(
                'w-1.5 h-1.5 rounded-full',
                source === 'live' ? 'bg-emerald-500' : 'bg-claude-500',
              )} />
              {source === 'live' ? 'Live' : 'Mock'}
            </span>
            {reason && <span className="text-[11px] text-ink-400 italic truncate max-w-md">{reason}</span>}
          </div>
        )}
      </div>
      {right && <div>{right}</div>}
    </div>
  )
}
