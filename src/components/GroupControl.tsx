import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Sidebar group selector + upload affordance. URL-synced via useGroupScope, so
 * every page's useGroupScope reflects the selection without prop-drilling. The
 * upload mirrors CsvUploader (multipart POST → refetch). When no mapping exists,
 * only "All groups" shows plus an upload prompt.
 */
export function GroupControl() {
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

  return (
    <div className="rounded-lg border border-ink-100 bg-white p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-ink-600">{t('group.label')}</span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] text-ink-400 underline hover:text-ink-700"
        >
          {t('group.upload')}
        </button>
      </div>
      <select
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        className="w-full rounded-md border border-ink-100 bg-paper-muted/40 px-2 py-1 text-xs text-ink-700"
      >
        <option value="">{t('group.all')}</option>
        {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        {hasMap && <option value={UNMAPPED}>{t('group.unmapped')}</option>}
      </select>
      {!hasMap && <div className="mt-1 text-[10px] text-ink-400">{t('group.empty')}</div>}
      {open && (
        <div className="mt-2 space-y-1">
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
