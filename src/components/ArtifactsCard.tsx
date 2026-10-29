import { useMemo } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { ChartCard } from './ChartCard'
import { KpiCard } from './KpiCard'
import { EmptyState } from './LoadingState'
import { RangeCoverageNote, type RangeCoverage } from './RangeCoverageNote'
import { useFetch } from '../lib/api'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtPct } from '../lib/format'

// /api/analytics/artifacts/range — artifact creation per product × MIME type
// × is_shared, one fan-out day each (the endpoint has no range rollup).
// Counts are flows and SUM across days; per-row distinct users do not add,
// so this card reports artifacts, not creators.
type ArtifactRow = {
  product?: string | null; artifact_type?: string | null; is_shared?: boolean | null
  artifacts_created_count?: number | null; published_artifacts_created_count?: number | null
}
type RangeResp = { coverage?: RangeCoverage; days: { date: string; source: string; data: ArtifactRow[] }[] }

const PRODUCT_LABELS: Record<string, string> = {
  chat: 'Chat', claude_code: 'Claude Code', cowork: 'Cowork', chat_cowork_unified: 'Chat & Cowork unified',
}

export function ArtifactsCard({ startingDate, endingDate }: { startingDate: string; endingDate: string }) {
  const t = useT()
  const resp = useFetch<RangeResp>(`/api/analytics/artifacts/range?starting_date=${startingDate}&ending_date=${endingDate}`)

  const agg = useMemo(() => {
    const byProduct = new Map<string, { product: string; Created: number; Published: number; Shared: number }>()
    const byType = new Map<string, number>()
    let created = 0, published = 0, shared = 0
    for (const day of resp.data?.days ?? []) {
      for (const r of day.data ?? []) {
        const n = r.artifacts_created_count ?? 0
        const pub = r.published_artifacts_created_count ?? 0
        const key = r.product ?? 'other'
        const cur = byProduct.get(key) ?? { product: PRODUCT_LABELS[key] ?? key, Created: 0, Published: 0, Shared: 0 }
        cur.Created += n
        cur.Published += pub
        if (r.is_shared) cur.Shared += n
        byProduct.set(key, cur)
        const type = r.artifact_type ?? 'other'
        byType.set(type, (byType.get(type) ?? 0) + n)
        created += n; published += pub
        if (r.is_shared) shared += n
      }
    }
    return {
      created, published, shared,
      products: [...byProduct.values()].sort((a, b) => b.Created - a.Created),
      types: [...byType.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    }
  }, [resp.data])

  let body
  if (resp.loading) body = <div className="px-4 py-6 text-sm text-ink-400">{t('common.loading')}</div>
  else if (resp.error) body = <div className="px-4 py-2"><EmptyState title={t('artifacts.unavailable')} /></div>
  else if (agg.created === 0) body = <div className="px-4 py-2"><EmptyState title={t('artifacts.empty')} hint={t('artifacts.empty.hint')} /></div>
  else {
    body = (
      <div className="px-4 pb-4 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-3 print:grid-cols-3 gap-4">
          <KpiCard accent label={t('artifacts.kpi.created')} value={fmtCompact(agg.created)} />
          <KpiCard label={t('artifacts.kpi.shared')} value={fmtPct(agg.shared / agg.created)} hint={t('artifacts.kpi.shared.hint', { n: fmtNum(agg.shared) })} />
          <KpiCard label={t('artifacts.kpi.published')} value={fmtNum(agg.published)} hint={t('artifacts.kpi.published.hint')} />
        </div>
        <ResponsiveContainer width="100%" height={Math.max(180, agg.products.length * 44)}>
          <BarChart data={agg.products} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
            <CartesianGrid strokeDasharray="2 4" />
            <XAxis type="number" allowDecimals={false} />
            <YAxis dataKey="product" type="category" width={150} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => fmtNum(v)} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Created" name={t('artifacts.bar.created')} fill="#D97757" radius={[0, 4, 4, 0]} />
            <Bar dataKey="Shared" name={t('artifacts.bar.shared')} fill="#B5AFA0" radius={[0, 4, 4, 0]} />
            <Bar dataKey="Published" name={t('artifacts.bar.published')} fill="#1F1E1D" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{t('artifacts.types')}</div>
          <ul className="flex flex-wrap gap-2" aria-label={t('artifacts.types')}>
            {agg.types.map((x) => (
              <li key={x.type} className="rounded-full border border-ink-100 bg-paper-muted px-2.5 py-1 text-[12px] text-ink-600">
                <code className="text-[11px]">{x.type}</code> <span className="tabular-nums font-semibold text-ink-800">{fmtNum(x.n)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  return (
    <ChartCard title={t('artifacts.title')} subtitle={t('artifacts.sub')}>
      <RangeCoverageNote resp={resp.data} />
      {body}
    </ChartCard>
  )
}
