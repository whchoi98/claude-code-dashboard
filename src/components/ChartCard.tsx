import clsx from 'clsx'

export function ChartCard({
  title, subtitle, children, className, right,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  className?: string
  right?: React.ReactNode
}) {
  return (
    <div className={clsx('rounded-xl border border-ink-100 bg-white shadow-card', className)}>
      <div className="px-5 pt-4 pb-2 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
          {subtitle && <p className="text-xs text-ink-500 mt-0.5">{subtitle}</p>}
        </div>
        {right && <div>{right}</div>}
      </div>
      <div className="px-2 pb-4">{children}</div>
    </div>
  )
}
