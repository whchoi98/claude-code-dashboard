import clsx from 'clsx'
import type { SortDir } from '../lib/useSortable'

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
  const active = sortKey === k
  return (
    <th
      onClick={() => onClick(k)}
      className={clsx(
        'px-3 py-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap',
        active ? 'text-claude-700 bg-claude-50/40' : 'text-ink-500 hover:text-ink-700',
        align === 'left' ? 'text-left' : 'text-right',
        className,
      )}
      title={`Sort by ${label}`}
    >
      {label}
      <span className={clsx('ml-1 inline-block w-2 text-[10px]', active ? 'opacity-100' : 'opacity-30')}>
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  )
}
