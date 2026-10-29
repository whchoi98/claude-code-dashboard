import { ChartCard } from './ChartCard'
import { EmptyState } from './LoadingState'
import { SortableTh } from './SortableTh'
import { useFetch } from '../lib/api'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtDate } from '../lib/format'

// /api/plugins/catalog — the organization's plugin catalog from the Plugins
// API (beta): install policy, version currency, content-scan status. The
// usage join is by name (the analytics rows carry plugin_name, the catalog
// its slug `name` and `display_name`), so a catalog entry shows its window
// invocations when the names match and '—' otherwise.
type CatalogPlugin = {
  id: string | null; name: string | null; display_name: string | null
  owner: 'organization' | 'user'; marketplace: string | null
  installation: string | null; installation_inherited: boolean
  pinned: boolean; update_available: boolean
  reach: string | null; scan: string | null; updated_at: string | null
}
type CatalogResp = { source: string; reason?: string; plugins: CatalogPlugin[]; marketplaces: { id: string | null; name: string | null; source: string | null }[] }
type Row = CatalogPlugin & { label: string; invocations: number | null }
type K = 'label' | 'owner' | 'marketplace' | 'installation' | 'version' | 'scan' | 'invocations' | 'updated'

const INSTALL_KEYS = ['required', 'auto_install', 'available', 'not_available'] as const

export function PluginCatalogCard({ invocationsByName }: { invocationsByName: Map<string, number> }) {
  const t = useT()
  const resp = useFetch<CatalogResp>('/api/plugins/catalog')
  const lookup = (p: CatalogPlugin) => {
    for (const k of [p.name, p.display_name]) {
      const v = k ? invocationsByName.get(k.toLowerCase()) : undefined
      if (v != null) return v
    }
    return null
  }
  const rows: Row[] = (resp.data?.plugins ?? []).map((p) => ({ ...p, label: p.display_name || p.name || p.id || '—', invocations: lookup(p) }))
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<Row, K>(
    rows,
    {
      label: (r) => r.label, owner: (r) => r.owner, marketplace: (r) => r.marketplace,
      installation: (r) => r.installation, version: (r) => (r.update_available ? 1 : 0),
      scan: (r) => r.scan, invocations: (r) => r.invocations, updated: (r) => r.updated_at,
    },
    { initialKey: 'label', initialDir: 'asc' },
  )
  const installLabel = (v: string | null) =>
    v && (INSTALL_KEYS as readonly string[]).includes(v) ? t(`catalog.install.${v}` as 'catalog.install.available') : (v ?? '—')

  let body
  if (resp.loading) body = <div className="px-4 py-6 text-sm text-ink-400">{t('common.loading')}</div>
  else if (resp.error || resp.data?.source === 'upstream_error') {
    body = <div className="px-4 py-2"><EmptyState title={t('catalog.unavailable')} hint={t('catalog.unavailable.hint')} /></div>
  } else if (rows.length === 0) {
    body = <div className="px-4 py-2"><EmptyState title={t('catalog.empty')} /></div>
  } else {
    const th = (label: string, k: K, align: 'left' | 'right' = 'left') =>
      <SortableTh label={label} k={k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={align} />
    body = (
      <div className="px-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-ink-500">
              {th(t('catalog.col.plugin'), 'label')}
              {th(t('catalog.col.owner'), 'owner')}
              {th(t('catalog.col.marketplace'), 'marketplace')}
              {th(t('catalog.col.install'), 'installation')}
              {th(t('catalog.col.version'), 'version')}
              {th(t('catalog.col.scan'), 'scan')}
              {th(t('catalog.col.invocations'), 'invocations', 'right')}
              {th(t('catalog.col.updated'), 'updated', 'right')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id ?? r.label} className="border-b border-ink-50">
                <td className="py-2 text-ink-700">{r.label}</td>
                <td className="py-2 text-ink-600">{t(r.owner === 'user' ? 'catalog.owner.user' : 'catalog.owner.organization')}</td>
                <td className="py-2 text-ink-600">{r.marketplace ?? '—'}</td>
                <td className="py-2 text-ink-600">
                  {installLabel(r.installation)}
                  {r.installation_inherited && <span className="ml-1 text-[11px] text-ink-400">{t('catalog.install.inherited')}</span>}
                </td>
                <td className="py-2">
                  {r.update_available
                    ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">{t(r.pinned ? 'catalog.version.pinned_behind' : 'catalog.version.behind')}</span>
                    : <span className="text-[11px] text-ink-500">{t(r.pinned ? 'catalog.version.pinned' : 'catalog.version.current')}</span>}
                </td>
                <td className="py-2 text-ink-600">{r.scan ?? '—'}</td>
                <td className="py-2 text-right tabular-nums">{r.invocations == null ? '—' : fmtNum(r.invocations)}</td>
                <td className="py-2 text-right tabular-nums text-ink-500">{r.updated_at ? fmtDate(r.updated_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <ChartCard title={t('catalog.title')} subtitle={t('catalog.sub')}>
      {body}
    </ChartCard>
  )
}
