import clsx from 'clsx'
import { ClaudeIcon } from './ClaudeIcon'

type Props = {
  label: string
  value: React.ReactNode
  hint?: string
  trend?: { pct: number; label?: string }
  accent?: boolean
}

export function KpiCard({ label, value, hint, trend, accent }: Props) {
  const up = trend ? trend.pct >= 0 : null
  return (
    <div className={clsx(
      'relative rounded-xl border bg-white px-5 py-4 shadow-card overflow-hidden',
      accent ? 'border-claude-200' : 'border-ink-100',
    )}>
      {accent && (
        <div className="absolute -right-2 -top-2 opacity-[0.08]">
          <ClaudeIcon size={90} />
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{label}</div>
      <div className="mt-1.5 text-[26px] font-semibold text-ink-800 tabular-nums leading-none">{value}</div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {trend && (
          <span className={clsx(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium',
            up ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700',
          )}>
            {up ? '↑' : '↓'} {Math.abs(trend.pct).toFixed(1)}%
          </span>
        )}
        {hint && <span className="text-ink-400">{hint}</span>}
      </div>
    </div>
  )
}
