import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { EmptyState } from '../components/LoadingState'

export function Archive() {
  const [query, setQuery] = useState(
    "SELECT date, SUM(lines_of_code_added) AS loc, COUNT(DISTINCT user_email) AS developers\nFROM claude_code_analytics\nWHERE date BETWEEN DATE '2026-01-01' AND DATE '2026-04-01'\nGROUP BY date\nORDER BY date",
  )
  const [rows, setRows] = useState<null | Record<string, unknown>[]>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function run() {
    setLoading(true); setError(null); setRows(null)
    try {
      const r = await fetch('/api/archive/query', {
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
        title="Archive"
        subtitle="Historical analytics beyond the 90-day API window. Backed by S3 + Glue + Athena."
      />
      <div className="p-8 space-y-5">
        <div className="rounded-xl border border-ink-100 bg-white shadow-card p-5">
          <label className="text-[11px] uppercase tracking-wider text-ink-500 font-medium">Athena SQL</label>
          <textarea
            value={query} onChange={(e) => setQuery(e.target.value)}
            rows={6}
            className="mt-2 w-full text-sm font-mono bg-ink-800 text-paper rounded-lg px-4 py-3 focus:outline-none"
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-[11px] text-ink-400">
              Collector writes daily snapshots to <code className="text-claude-600">s3://$BUCKET/analytics/date=YYYY-MM-DD/</code>.
              Glue Data Catalog exposes the <code className="text-claude-600">claude_code_analytics</code> table.
            </div>
            <button
              onClick={run} disabled={loading}
              className="px-4 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-paper text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Running…' : 'Run query'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {rows && rows.length > 0 && (
          <ChartCard title="Results" subtitle={`${rows.length} rows`}>
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
          <EmptyState title="Query returned no rows" hint="Check the date range or partition values." />
        )}

        {!rows && !loading && !error && (
          <EmptyState
            title="Run an Athena query to see archived data"
            hint="The collector Lambda writes one JSON-partitioned file per day. Schema mirrors the Analytics API responses."
          />
        )}
      </div>
    </div>
  )
}
