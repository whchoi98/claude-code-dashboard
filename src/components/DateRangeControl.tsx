import { useRef, useState, useEffect } from 'react'
import clsx from 'clsx'
import { useDateRange, type Preset } from '../lib/useDateRange'
import { fmtDate } from '../lib/format'
import { useT } from '../lib/i18n'

const PRESET_BUTTONS: { key: Preset; label: string }[] = [
  { key: '7d',  label: '7d'  },
  { key: '14d', label: '14d' },
  { key: '30d', label: '30d' },
  { key: 'custom', label: '…' },
]

export function DateRangeControl() {
  const t = useT()
  const { range, setPreset, setCustom, maxEnd, FIRST_AVAILABLE } = useDateRange()
  const [open, setOpen] = useState(false)
  const [draftStart, setDraftStart] = useState(range.startingDate)
  const [draftEnd,   setDraftEnd]   = useState(range.endingDate)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftStart(range.startingDate)
    setDraftEnd(range.endingDate)
  }, [range.startingDate, range.endingDate])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!popoverRef.current) return
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="relative" ref={popoverRef}>
      <div className="flex items-center gap-1 text-xs font-medium">
        <div className="flex items-center rounded-lg border border-ink-100 bg-white p-0.5">
          {PRESET_BUTTONS.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                if (p.key === 'custom') setOpen(true)
                else setPreset(p.key)
              }}
              className={clsx(
                'px-2.5 py-1 rounded-md transition',
                range.preset === p.key
                  ? 'bg-claude-500 text-white shadow-sm'
                  : 'text-ink-500 hover:bg-paper-muted',
              )}
              title={p.key === 'custom' ? 'Custom range' : `Last ${p.label}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg border border-ink-100 bg-white px-2.5 py-1 text-ink-600 hover:bg-paper-muted tabular-nums"
          title="Click to change range"
        >
          {fmtDate(range.startingDate)} – {fmtDate(range.endingDate)}
          <span className="ml-1 text-ink-400">({range.days}d)</span>
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-10 z-20 w-80 rounded-xl border border-ink-100 bg-white shadow-xl p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">Custom range</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-ink-500">
              <div>Start</div>
              <input
                type="date"
                value={draftStart}
                min={FIRST_AVAILABLE}
                max={maxEnd}
                onChange={(e) => setDraftStart(e.target.value)}
                className="mt-1 w-full border border-ink-200 rounded-md px-2 py-1 text-sm tabular-nums"
              />
            </label>
            <label className="text-xs text-ink-500">
              <div>End</div>
              <input
                type="date"
                value={draftEnd}
                min={FIRST_AVAILABLE}
                max={maxEnd}
                onChange={(e) => setDraftEnd(e.target.value)}
                className="mt-1 w-full border border-ink-200 rounded-md px-2 py-1 text-sm tabular-nums"
              />
            </label>
          </div>
          <div className="flex items-center justify-between pt-1 border-t border-ink-100">
            <div className="text-[10px] text-ink-400">
              {t('status.analytics_key')}: 3d buffer · 90d max
            </div>
            <button
              onClick={() => {
                setCustom(draftStart, draftEnd)
                setOpen(false)
              }}
              className="px-3 py-1 rounded-md bg-claude-500 text-white text-xs font-medium hover:bg-claude-600"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
