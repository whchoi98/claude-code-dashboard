import clsx from 'clsx'
import type { SortDir } from '../lib/useSortable'
import { useT } from '../lib/i18n'

/**
 * Header cell for a sortable table. Click toggles the column's sort
 * direction (or activates it with `defaultDir` if it wasn't active).
 * Renders a small ▲/▼ glyph on the active column.
 */
export function SortableTh<K extends string>({
  label, k, sortKey, sortDir, onClick, align = 'right', className,
}: {
  label: string
  k: K
  sortKey: string
  sortDir: SortDir
  onClick: (k: K) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const t = useT()
  const active = sortKey === k
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={clsx(
        'text-[11px] font-semibold uppercase tracking-wider select-none whitespace-nowrap',
        active ? 'text-claude-700 bg-claude-50/40' : 'text-ink-500 hover:text-ink-700',
        align === 'left' ? 'text-left' : 'text-right',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onClick(k)}
        aria-label={t('table.sort', { column: label })}
        title={t('table.sort', { column: label })}
        className={clsx(
          'flex w-full items-center px-3 py-2 font-semibold uppercase tracking-wider focus-visible:outline focus-visible:outline-2 focus-visible:outline-claude-500 focus-visible:-outline-offset-2',
          align === 'left' ? 'justify-start' : 'justify-end',
        )}
      >
        {label}
        <span aria-hidden="true" className={clsx('ml-1 inline-block w-2 text-[10px]', active ? 'opacity-100' : 'opacity-30')}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}
