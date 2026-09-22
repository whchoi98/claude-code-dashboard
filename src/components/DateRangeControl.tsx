import { useCallback, useId, useRef, useState, useEffect } from 'react'
import clsx from 'clsx'
import { useDateRange, type DateRangeOptions, type Preset } from '../lib/useDateRange'
import { validateCustomRange } from '../lib/dateRange'
import { fmtDate } from '../lib/format'
import { useT } from '../lib/i18n'

const PRESET_BUTTONS: { key: Preset; label: string }[] = [
  { key: '1d',  label: '1d'  },
  { key: '7d',  label: '7d'  },
  { key: '14d', label: '14d' },
  { key: '30d', label: '30d' },
  { key: 'custom', label: '…' },
]

export function DateRangeControl({ defaultPreset, freshEnd }: { defaultPreset?: Preset; freshEnd?: boolean } = {}) {
  const t = useT()
  // defaultPreset only takes effect when the URL carries no ?range= param;
  // pages that want a non-7d default (e.g. Cost → '1d') pass it so the picker's
  // highlighted preset matches the page's own useDateRange(defaultPreset).
  // freshEnd must MATCH the page's own useDateRange options (each is a separate
  // hook instance) — Cost passes it so '1d' targets today, see DateRangeOptions.
  const opts: DateRangeOptions = { freshEnd }
  const { range, setPreset, setCustom, maxEnd, FIRST_AVAILABLE } = useDateRange(defaultPreset, opts)
  const [open, setOpen] = useState(false)
  const [draftStart, setDraftStart] = useState(range.startingDate)
  const [draftEnd,   setDraftEnd]   = useState(range.endingDate)
  const popoverRef = useRef<HTMLDivElement>(null)
  const startInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  const errorId = `${dialogId}-error`
  const footnoteId = `${dialogId}-footnote`
  const selectionId = `${dialogId}-selection`
  const issue = validateCustomRange(draftStart, draftEnd, maxEnd)
  const error = issue ? t(issue.key, issue.params) : null

  const closePopover = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  function togglePopover(trigger: HTMLButtonElement) {
    if (open) {
      closePopover(false)
      return
    }
    triggerRef.current = trigger
    setDraftStart(range.startingDate)
    setDraftEnd(range.endingDate)
    setOpen(true)
  }

  useEffect(() => {
    setDraftStart(range.startingDate)
    setDraftEnd(range.endingDate)
  }, [range.startingDate, range.endingDate])

  useEffect(() => {
    if (!open) return
    startInputRef.current?.focus()

    function onDocPointerDown(e: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover(false)
      }
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        e.stopPropagation()
        closePopover()
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [open, closePopover])

  return (
    <div
      className="relative min-w-0 max-w-full"
      ref={popoverRef}
      onBlur={(e) => {
        // This is a non-modal popup: keyboard users can leave it normally.
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) closePopover(false)
      }}
    >
      <div className="flex flex-wrap items-center gap-1 text-xs font-medium">
        <div className="flex items-center rounded-lg border border-ink-100 bg-white p-0.5">
          {PRESET_BUTTONS.map((p) => {
            const title = p.key === 'custom'
              ? t('range.custom')
              : p.key === '1d'
                ? t(freshEnd ? 'range.tooltip_1d_today' : 'range.tooltip_1d')
                : t('range.last_days', { days: Number.parseInt(p.key, 10) })
            return (
              <button
                key={p.key}
                type="button"
                onClick={(e) => {
                  if (p.key === 'custom') togglePopover(e.currentTarget)
                  else {
                    closePopover(false)
                    setPreset(p.key)
                  }
                }}
                aria-label={title}
                aria-pressed={range.preset === p.key}
                aria-haspopup={p.key === 'custom' ? 'dialog' : undefined}
                aria-expanded={p.key === 'custom' ? open : undefined}
                aria-controls={p.key === 'custom' && open ? dialogId : undefined}
                className={clsx(
                  'px-2.5 py-1 rounded-md transition',
                  range.preset === p.key
                    ? 'bg-claude-500 text-white shadow-sm'
                    : 'text-ink-500 hover:bg-paper-muted',
                )}
                title={title}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={(e) => togglePopover(e.currentTarget)}
          className="rounded-lg border border-ink-100 bg-white px-2.5 py-1 text-ink-600 hover:bg-paper-muted tabular-nums whitespace-nowrap"
          title={t('range.change')}
          aria-label={t('range.change')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          aria-describedby={selectionId}
        >
          <span id={selectionId}>
            {fmtDate(range.startingDate)} – {fmtDate(range.endingDate)}
            <span className="ml-1 text-ink-400">({range.days}d)</span>
          </span>
        </button>
      </div>

      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={footnoteId}
          className="absolute left-0 top-full mt-2 sm:left-auto sm:right-0 z-20 w-80 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-xl border border-ink-100 bg-white shadow-xl p-4 space-y-3"
        >
          <div id={titleId} className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">
            {t('range.custom')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="min-w-0 text-xs text-ink-500">
              <div>{t('range.start')}</div>
              <input
                ref={startInputRef}
                type="date"
                required
                value={draftStart}
                min={FIRST_AVAILABLE}
                max={maxEnd}
                aria-invalid={issue ? true : undefined}
                aria-describedby={issue ? errorId : undefined}
                onChange={(e) => setDraftStart(e.target.value)}
                className="mt-1 min-w-0 w-full border border-ink-200 rounded-md px-2 py-1 text-sm tabular-nums"
              />
            </label>
            <label className="min-w-0 text-xs text-ink-500">
              <div>{t('range.end')}</div>
              <input
                type="date"
                required
                value={draftEnd}
                min={FIRST_AVAILABLE}
                max={maxEnd}
                aria-invalid={issue ? true : undefined}
                aria-describedby={issue ? errorId : undefined}
                onChange={(e) => setDraftEnd(e.target.value)}
                className="mt-1 min-w-0 w-full border border-ink-200 rounded-md px-2 py-1 text-sm tabular-nums"
              />
            </label>
          </div>
          {error && <p id={errorId} role="alert" className="text-xs text-red-600">{error}</p>}
          <p id={footnoteId} className="text-[10px] text-ink-400 leading-snug">
            {t('range.footnote')}
          </p>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
            <button
              type="button"
              onClick={() => closePopover()}
              className="px-3 py-1 rounded-md border border-ink-200 text-ink-600 text-xs font-medium hover:bg-paper-muted"
            >
              {t('range.cancel')}
            </button>
            <button
              type="button"
              disabled={!!issue}
              onClick={() => {
                if (setCustom(draftStart, draftEnd)) closePopover()
              }}
              className="px-3 py-1 rounded-md bg-claude-500 text-white text-xs font-medium hover:bg-claude-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('range.apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
