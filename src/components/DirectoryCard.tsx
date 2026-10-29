import { ChartCard } from './ChartCard'
import { KpiCard } from './KpiCard'
import { EmptyState } from './LoadingState'
import { useFetch } from '../lib/api'
import { useT } from '../lib/i18n'
import { fmtNum, fmtPct, maskEmail } from '../lib/format'

// /api/compliance/directory — per linked organization: current members by
// built-in role, and how many saved custom instructions (claude.ai
// "Instructions for Claude" / Cowork "Global instructions"). The server sends
// instruction TEXT only to a verified unmasked administrator (ADR-0020).
type PrefMember = { email: string | null; conversation_preferences: string | null; cowork_global_instructions: string | null }
type OrgDirectory = {
  uuid: string | null
  name: string | null
  members: number | null
  roles: Record<string, number> | null
  preferences: { listed: number; conversation_set: number; cowork_set: number; any_set: number; members?: PrefMember[] } | null
  errors: { users?: number; preferences?: number }
}
type DirectoryResp = { source: string; reason?: string; unmasked: boolean; truncated?: boolean; orgs: OrgDirectory[] }

// Display order of the documented built-in levels; anything else sorts after.
const ROLE_ORDER = ['primary_owner', 'owner', 'admin', 'membership_admin', 'billing', 'developer', 'claude_code_user', 'user', 'managed']

export function DirectoryCard() {
  const t = useT()
  const resp = useFetch<DirectoryResp>('/api/compliance/directory')
  const orgs = resp.data?.orgs ?? []

  let body
  if (resp.loading) body = <div className="px-4 py-6 text-sm text-ink-400">{t('common.loading')}</div>
  else if (resp.error || resp.data?.source === 'upstream_error' || orgs.length === 0) {
    body = <div className="px-4 py-2"><EmptyState title={t('directory.unavailable')} hint={t('directory.unavailable.hint')} /></div>
  } else {
    body = (
      <div className="px-4 pb-4 space-y-6">
        {orgs.map((o) => <OrgDirectorySection key={o.uuid ?? o.name ?? ''} org={o} unmasked={resp.data?.unmasked === true} showName={orgs.length > 1} />)}
      </div>
    )
  }
  return (
    <ChartCard title={t('directory.title')} subtitle={t('directory.sub')}>
      {body}
    </ChartCard>
  )
}

function OrgDirectorySection({ org, unmasked, showName }: { org: OrgDirectory; unmasked: boolean; showName: boolean }) {
  const t = useT()
  const p = org.preferences
  const share = (n: number) => (p && p.listed > 0 ? n / p.listed : null)
  const roles = Object.entries(org.roles ?? {}).sort(([a], [b]) => {
    const ia = ROLE_ORDER.indexOf(a), ib = ROLE_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  const roleLabel = (r: string) => (ROLE_ORDER.includes(r) ? t(`directory.role.${r}` as 'directory.role.user') : r)
  return (
    <section aria-label={org.name ?? undefined}>
      {showName && <h3 className="mb-2 text-sm font-semibold text-ink-700">{org.name}</h3>}
      <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
        <KpiCard label={t('directory.kpi.members')} value={org.members == null ? '—' : fmtNum(org.members)}
          hint={org.errors.users ? t('directory.part_unavailable', { status: org.errors.users }) : t('directory.kpi.members.hint')} />
        <KpiCard label={t('directory.kpi.conversation')} value={p ? fmtPct(share(p.conversation_set)) : '—'}
          hint={p ? t('directory.kpi.of_members', { n: fmtNum(p.conversation_set), total: fmtNum(p.listed) }) : t('directory.part_unavailable', { status: org.errors.preferences ?? 0 })} />
        <KpiCard label={t('directory.kpi.cowork')} value={p ? fmtPct(share(p.cowork_set)) : '—'}
          hint={p ? t('directory.kpi.of_members', { n: fmtNum(p.cowork_set), total: fmtNum(p.listed) }) : t('directory.part_unavailable', { status: org.errors.preferences ?? 0 })} />
        <KpiCard label={t('directory.kpi.any')} value={p ? fmtNum(p.any_set) : '—'} hint={t('directory.kpi.any.hint')} />
      </div>

      {roles.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{t('directory.roles')}</div>
          <ul className="flex flex-wrap gap-2" aria-label={t('directory.roles')}>
            {roles.map(([r, n]) => (
              <li key={r} className="rounded-full border border-ink-100 bg-paper-muted px-2.5 py-1 text-[12px] text-ink-600">
                {roleLabel(r)} <span className="tabular-nums font-semibold text-ink-800">{fmtNum(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p && (unmasked && p.members ? (
        <InstructionTable rows={p.members} />
      ) : (
        <p className="mt-4 text-[11px] text-ink-500">{t('directory.text_admin_only')}</p>
      ))}
    </section>
  )
}

function InstructionTable({ rows }: { rows: PrefMember[] }) {
  const t = useT()
  if (rows.length === 0) return <p className="mt-4 text-[11px] text-ink-500">{t('directory.none_set')}</p>
  const cell = (text: string | null) => text
    ? (
      <details>
        <summary className="cursor-pointer text-ink-700 line-clamp-1 break-all">{text.slice(0, 80)}{text.length > 80 ? '…' : ''}</summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-ink-600">{text}</p>
      </details>
    )
    : <span className="text-ink-300">—</span>
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-ink-100 text-left text-ink-500">
            <th scope="col" className="py-2 pr-3 font-semibold">{t('directory.col.member')}</th>
            <th scope="col" className="py-2 pr-3 font-semibold">{t('directory.col.conversation')}</th>
            <th scope="col" className="py-2 font-semibold">{t('directory.col.cowork')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.email ?? i} className="border-b border-ink-50 align-top">
              <td className="py-2 pr-3 text-ink-700 whitespace-nowrap">{r.email ? maskEmail(r.email) : '—'}</td>
              <td className="py-2 pr-3 max-w-[28rem]">{cell(r.conversation_preferences)}</td>
              <td className="py-2 max-w-[28rem]">{cell(r.cowork_global_instructions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
