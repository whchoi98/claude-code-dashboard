import { useCallback, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import { useFetch } from '../lib/api'

type Period = { starting_date: string; ending_date: string } | null
type UploadsResp = { count: number; items: { file: string; key: string; size_bytes: number; last_modified: string; period: Period }[] }

// Client-side preview: parse enough of the CSV to show the user what they are
// about to upload. Does not attempt to validate schema (server authoritative),
// only extracts a few signal fields so the user can catch obvious mistakes
// (wrong file, wrong period) before clicking confirm.
function previewCsv(text: string): { rows: number; users: number; period: Period; periodFromName: Period } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) return { rows: 0, users: 0, period: null, periodFromName: null }
  const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim())
  const emailIdx = header.indexOf('user_email')
  const users = new Set<string>()
  if (emailIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      const e = (cols[emailIdx] || '').replace(/^"|"$/g, '').trim()
      if (e) users.add(e)
    }
  }
  return { rows: lines.length - 1, users: users.size, period: null, periodFromName: null }
}

function periodsOverlap(a: Period, b: Period): boolean {
  if (!a || !b) return false
  return !(a.ending_date < b.starting_date || b.ending_date < a.starting_date)
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

interface Props {
  /** Called after a successful upload or delete so the parent page can refetch. */
  onChange?: () => void
  /** Compact mode: used inline (e.g. in PageHeader). Full mode includes the uploads history. */
  variant?: 'compact' | 'full'
}

export function CsvUploader({ onChange, variant = 'full' }: Props) {
  const t = useT()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ rows: number; users: number; period: Period } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const uploads = useFetch<UploadsResp>('/api/cost/uploads')

  // Period from filename — more reliable than parsing thousands of rows client-side
  // to derive the true range (the filename is the canonical source for Anthropic's
  // exported spend reports).
  const derivedPeriod: Period = useMemo(() => {
    if (!file) return null
    const m = file.name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
    return m ? { starting_date: m[1], ending_date: m[2] } : null
  }, [file])

  const overlap = useMemo(() => {
    if (!derivedPeriod || !uploads.data?.items) return false
    return uploads.data.items.some((u) => periodsOverlap(u.period, derivedPeriod))
  }, [derivedPeriod, uploads.data])

  const handlePick = useCallback(async (f: File | null) => {
    setMsg(null)
    setFile(f)
    setPreview(null)
    if (!f) return
    try {
      const text = await f.text()
      const p = previewCsv(text)
      setPreview(p)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Failed to read file.' })
    }
  }, [])

  const doUpload = useCallback(async () => {
    if (!file) return
    setBusy(true)
    setMsg(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/cost/upload', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      setMsg({ kind: 'ok', text: `${t('cost.upload.success')}: ${body.file} (${body.rows} ${t('cost.upload.rows')}, ${body.distinct_users} ${t('cost.upload.users')})` })
      setFile(null)
      setPreview(null)
      if (inputRef.current) inputRef.current.value = ''
      await uploads.refetch?.()
      onChange?.()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Upload failed.' })
    } finally {
      setBusy(false)
    }
  }, [file, t, uploads, onChange])

  const doDelete = useCallback(async (name: string) => {
    if (!window.confirm(t('cost.uploads.confirm'))) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/cost/uploads/${encodeURIComponent(name)}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      await uploads.refetch?.()
      onChange?.()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Delete failed.' })
    } finally {
      setBusy(false)
    }
  }, [t, uploads, onChange])

  const hasItems = (uploads.data?.items?.length ?? 0) > 0

  return (
    <div className="space-y-3">
      {/* Picker row */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
          className="text-xs file:mr-3 file:rounded file:border-0 file:bg-claude-500 file:px-3 file:py-1.5 file:text-white file:hover:bg-claude-600 file:cursor-pointer"
          disabled={busy}
        />
        {file && (
          <>
            <span className="text-[11px] text-ink-500">{fmtBytes(file.size)}</span>
            <button
              onClick={doUpload}
              disabled={busy}
              className="rounded-md bg-claude-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-claude-600 disabled:opacity-50"
            >
              {busy ? '…' : t('cost.upload.confirm')}
            </button>
            <button
              onClick={() => { setFile(null); setPreview(null); if (inputRef.current) inputRef.current.value = '' }}
              disabled={busy}
              className="text-xs text-ink-500 hover:text-ink-800 underline"
            >
              {t('cost.upload.cancel')}
            </button>
          </>
        )}
      </div>

      {/* Preview block */}
      {file && preview && (
        <div className="rounded-lg border border-ink-100 bg-paper-muted/50 px-3 py-2 text-[12px] text-ink-700">
          <div className="font-medium mb-1">{t('cost.upload.preview')}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span><b>{preview.rows}</b> {t('cost.upload.rows')}</span>
            <span><b>{preview.users}</b> {t('cost.upload.users')}</span>
            {derivedPeriod && (
              <span>{t('cost.upload.period')}: <b>{derivedPeriod.starting_date}</b> → <b>{derivedPeriod.ending_date}</b></span>
            )}
          </div>
          {overlap && (
            <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              ⚠ {t('cost.upload.overlap')}
            </div>
          )}
        </div>
      )}

      {/* Status message */}
      {msg && (
        <div
          className={clsx(
            'rounded-lg px-3 py-2 text-[12px]',
            msg.kind === 'ok'   && 'bg-emerald-50 border border-emerald-200 text-emerald-800',
            msg.kind === 'err'  && 'bg-red-50 border border-red-200 text-red-800',
            msg.kind === 'warn' && 'bg-amber-50 border border-amber-200 text-amber-800',
          )}
        >
          {msg.text}
        </div>
      )}

      {/* Uploads history — only in "full" mode */}
      {variant === 'full' && (
        <div className="rounded-lg border border-ink-100 bg-white">
          <div className="border-b border-ink-100 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-ink-500">
            {t('cost.uploads.title')}
          </div>
          {!hasItems && (
            <div className="px-3 py-3 text-[12px] text-ink-400">{t('cost.uploads.empty')}</div>
          )}
          {hasItems && (
            <div className="divide-y divide-ink-100">
              {uploads.data!.items.map((u, i) => (
                <div key={u.key} className="flex items-center justify-between px-3 py-2 text-[12px]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-800 truncate">{u.file}</span>
                      {i === 0 && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500 text-white">
                          {t('cost.uploads.latest')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-400 flex gap-3">
                      {u.period && <span>{u.period.starting_date} → {u.period.ending_date}</span>}
                      <span>{fmtBytes(u.size_bytes)}</span>
                      <span>{new Date(u.last_modified).toLocaleString()}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => doDelete(u.file)}
                    disabled={busy}
                    className="ml-3 shrink-0 text-[11px] text-red-600 hover:text-red-800 hover:underline disabled:opacity-50"
                  >
                    {t('cost.uploads.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
