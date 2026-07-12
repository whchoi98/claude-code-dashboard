import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Per-page group scope tabs. Replaces the former sidebar GroupControl: a pill
 * row (All · groups · Unmapped) rendered under each page's PageHeader, plus the
 * email→group CSV upload affordance migrated from GroupControl. URL-synced via
 * useGroupScope (?group=); sidebar NavLinks re-append the group param
 * (Layout.tsx withGroup), which is what carries the selection across pages.
 */
export function GroupTabs() {
  const t = useT()
  const { group, setGroup, groups, hasMap, refetch } = useGroupScope()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const doUpload = useCallback(async (file: File) => {
    setBusy(true); setMsg(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/groups/upload', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      setMsg({ kind: 'ok', text: `${t('group.upload.success')}: ${body.groups.length} ${t('group.upload.groups')} · ${body.rows} ${t('group.upload.rows')}` })
      if (inputRef.current) inputRef.current.value = ''
      await refetch?.()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Upload failed.' })
    } finally {
      setBusy(false)
    }
  }, [t, refetch])

  const tabs: { value: string; label: string }[] = [
    { value: '', label: t('group.all') },
    ...groups.map((g) => ({ value: g, label: g })),
    ...(hasMap ? [{ value: UNMAPPED, label: t('group.unmapped') }] : []),
  ]

  return (
    <div className="px-4 lg:px-8 pt-4 pb-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-ink-600">{t('group.label')}</span>
        {tabs.map((tab) => (
          <button
            key={tab.value || 'all'}
            onClick={() => setGroup(tab.value)}
            className={clsx(
              'rounded-full border px-3 py-1 text-xs font-medium transition',
              group === tab.value
                ? 'border-claude-500 bg-claude-500 text-white shadow-sm'
                : 'border-ink-100 bg-white text-ink-500 hover:bg-paper-muted',
            )}
          >
            {tab.label}
          </button>
        ))}
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto text-[11px] text-ink-400 underline hover:text-ink-700"
        >
          {t('group.upload')}
        </button>
      </div>
      {!hasMap && <div className="mt-1 text-[10px] text-ink-400">{t('group.empty')}</div>}
      {open && (
        <div className="mt-2 space-y-1 rounded-lg border border-ink-100 bg-white p-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f) }}
            className="text-[10px] file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-claude-500 file:px-2 file:py-1 file:text-white"
          />
          <div className="text-[10px] text-ink-400">{t('group.upload.hint')}</div>
          {msg && (
            <div className={clsx('text-[10px]', msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-600')}>
              {msg.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
