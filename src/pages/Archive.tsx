import { useRef, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { EmptyState } from '../components/LoadingState'
import { useT } from '../lib/i18n'
import { orgParam } from '../lib/api'
import { useOrg } from '../lib/OrgProvider'

export function Archive() {
  const t = useT()
  const { org } = useOrg()
  // The `date` partition is varchar (zero-padded YYYY-MM-DD), so plain
  // string BETWEEN compares correctly *and* lets Athena prune partitions.
  // Using `BETWEEN DATE '...' AND DATE '...'` produces a TYPE_MISMATCH
  // because Trino won't auto-cast varchar to date.
  //
  // The SQL itself decides which org's data it reads: org2 data lives in the
  // *_org2 table twins. Seed the sample query from the CURRENT org and
  // re-seed on switch — otherwise an org2 session pressing Run silently
  // renders the primary org's numbers.
  const defaultQuery = (o: string) =>
    `SELECT date, SUM(lines_of_code_added) AS loc, COUNT(DISTINCT user_email) AS developers\nFROM claude_code_analytics${o === 'org2' ? '_org2' : ''}\nWHERE date BETWEEN '2026-04-01' AND '2026-04-30'\nGROUP BY date\nORDER BY date`
  const [query, setQuery] = useState(() => defaultQuery(org))
  const [rows, setRows] = useState<null | Record<string, unknown>[]>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Render-phase derived-state reset (React-sanctioned): re-seed the sample
  // query and drop old results the moment the org changes — no stale frame.
  const lastOrgRef = useRef(org)
  if (lastOrgRef.current !== org) {
    lastOrgRef.current = org
    setQuery(defaultQuery(org))
    setRows(null)
    setError(null)
  }

  async function run() {
    setLoading(true); setError(null); setRows(null)
    try {
      // The org param lets the server bias Athena hints toward the *_org2
      // tables; the SQL itself already names the table it targets.
      const r = await fetch(orgParam('/api/archive/query', org), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || body.message || r.statusText)
      setRows(body.rows || [])
    } catch (e: any) {
      setError(String(e.message || e))
    } finally { setLoading(false) }
  }

  return (
    <div>
      <PageHeader
        title={t('archive.title')}
        subtitle={t('archive.subtitle')}
      />
      <div className="p-4 lg:p-8 print:p-8 space-y-5">
        <div className="rounded-xl border border-ink-100 bg-white shadow-card p-5">
          <label className="text-[11px] uppercase tracking-wider text-ink-500 font-medium">{t('archive.athena_sql')}</label>
          <textarea
            value={query} onChange={(e) => setQuery(e.target.value)}
            rows={6}
            className="mt-2 w-full text-sm font-mono bg-ink-800 text-paper rounded-lg px-4 py-3 focus:outline-none"
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-[11px] text-ink-400">{t('archive.hint')}</div>
            <button
              onClick={run} disabled={loading}
              className="px-4 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-paper text-sm font-medium disabled:opacity-50"
            >
              {loading ? t('archive.running') : t('archive.run')}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {rows && rows.length > 0 && (
          <ChartCard title={t('archive.results')} subtitle={t('archive.rows', { n: rows.length })}>
            <div className="overflow-auto max-h-[540px] mx-3">
              <table className="w-full text-xs">
                <thead className="bg-paper-muted/60 text-ink-500 sticky top-0">
                  <tr>
                    {Object.keys(rows[0]).map((k) => (
                      <th key={k} className="text-left px-3 py-2 font-semibold uppercase tracking-wider">{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-ink-100">
                      {Object.values(r).map((v, j) => (
                        <td key={j} className="px-3 py-1.5 tabular-nums text-ink-700">{String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ChartCard>
        )}

        {rows && rows.length === 0 && (
          <EmptyState title={t('archive.no_rows.title')} hint={t('archive.no_rows.hint')} />
        )}

        {!rows && !loading && !error && (
          <EmptyState title={t('archive.empty')} hint={t('archive.empty.hint')} />
        )}
      </div>
    </div>
  )
}
