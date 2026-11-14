import clsx from 'clsx'
import { ChartCard } from './ChartCard'
import { KpiCard } from './KpiCard'
import { EmptyState } from './LoadingState'
import { useFetch } from '../lib/api'
import { useT } from '../lib/i18n'
import { fmtNum } from '../lib/format'

// /api/compliance/security-posture — the current result of every control on
// the claude.ai "Security posture" page (Security Center), per linked
// organization. Read-only: results change when an admin changes a setting or
// attests on that page. The server never sends who attested or any comment.
type Rating = 'failed' | 'not_attested' | 'passed' | 'descriptive'
type Counts = Record<Rating, number>
type Control = {
  id: string | null
  name: string | null
  rating: string
  status: string
  accepted_risk: boolean
  current_value: string | null
  desired_state: string | null
  attestation: { state: string | null; attested_at: string | null } | null
}
type Section = { section: string; counts: Counts; controls: Control[] }
type OrgPosture = {
  uuid: string | null
  name: string | null
  available: boolean
  reason?: string
  evaluated_at?: string | null
  total?: number
  rated?: number
  counts?: Counts & { accepted_risk: number }
  sections?: Section[]
}
type PostureResp = { source: string; reason?: string; stale?: boolean; truncated?: boolean; orgs: OrgPosture[] }

const KNOWN_RATINGS: Rating[] = ['failed', 'not_attested', 'passed', 'descriptive']
const KNOWN_SECTIONS = [
  'identity_access', 'data_privacy', 'capabilities', 'connectors_integrations', 'chats_desktop_mdm',
  'cowork_admin_console', 'cowork_desktop_mdm', 'claude_code_admin_console', 'claude_code_managed_settings',
  'healthy_adoption', 'other',
]
const RATING_STYLE: Record<Rating, string> = {
  failed: 'border-rose-200 bg-rose-50 text-rose-700',
  not_attested: 'border-amber-200 bg-amber-50 text-amber-800',
  passed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  descriptive: 'border-ink-100 bg-paper-muted text-ink-500',
}
const titleCase = (id: string) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const utcMinute = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function SecurityPostureCard() {
  const t = useT()
  const resp = useFetch<PostureResp>('/api/compliance/security-posture')
  const orgs = resp.data?.orgs ?? []

  let body
  if (resp.loading) body = <div className="px-4 py-6 text-sm text-ink-400">{t('common.loading')}</div>
  else if (resp.error || resp.data?.source === 'upstream_error' || orgs.length === 0) {
    body = <div className="px-4 py-2"><EmptyState title={t('posture.unavailable')} hint={t('posture.unavailable.hint')} /></div>
  } else {
    body = (
      <div className="px-4 pb-4 space-y-6">
        {resp.data?.stale && (
          <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{t('posture.stale')}</p>
        )}
        {orgs.map((o) => <OrgPostureSection key={o.uuid ?? o.name ?? ''} org={o} showName={orgs.length > 1} />)}
      </div>
    )
  }
  return (
    <ChartCard title={t('posture.title')} subtitle={t('posture.sub')}>
      {body}
    </ChartCard>
  )
}

function OrgPostureSection({ org, showName }: { org: OrgPosture; showName: boolean }) {
  const t = useT()
  const sections = org.sections ?? []
  const c = org.counts
  if (!org.available || !c) {
    return (
      <section aria-label={org.name ?? undefined}>
        {showName && <h3 className="mb-2 text-sm font-semibold text-ink-700">{org.name}</h3>}
        <EmptyState title={t('posture.org_unavailable')} hint={t('posture.org_unavailable.hint')} />
      </section>
    )
  }
  const sectionLabel = (id: string) => (KNOWN_SECTIONS.includes(id) ? t(`posture.section.${id}` as 'posture.section.other') : titleCase(id))
  // Failed and not-attested controls, section by section, worst first.
  const attention = sections
    .map((s) => ({ ...s, controls: s.controls.filter((x) => x.rating === 'failed' || x.rating === 'not_attested') }))
    .filter((s) => s.controls.length > 0)
  return (
    <section aria-label={org.name ?? undefined}>
      {showName && <h3 className="mb-2 text-sm font-semibold text-ink-700">{org.name}</h3>}
      <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
        <KpiCard accent label={t('posture.kpi.failed')} value={fmtNum(c.failed)} hint={t('posture.kpi.failed.hint', { rated: fmtNum(org.rated ?? 0) })} />
        <KpiCard label={t('posture.kpi.not_attested')} value={fmtNum(c.not_attested)} hint={t('posture.kpi.not_attested.hint')} />
        <KpiCard label={t('posture.kpi.passed')} value={fmtNum(c.passed)}
          hint={c.accepted_risk > 0 ? t('posture.kpi.passed.hint_risk', { n: fmtNum(c.accepted_risk) }) : t('posture.kpi.passed.hint')} />
        <KpiCard label={t('posture.kpi.descriptive')} value={fmtNum(c.descriptive)} hint={t('posture.kpi.descriptive.hint')} />
      </div>
      {org.evaluated_at && <p className="mt-2 text-[11px] text-ink-500">{t('posture.evaluated', { time: utcMinute(org.evaluated_at) })}</p>}

      <div className="mt-4">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{t('posture.attention')}</div>
        {attention.length === 0
          ? <p className="text-xs text-ink-500">{t('posture.attention.none')}</p>
          : <ControlTable sections={attention} sectionLabel={sectionLabel} caption={t('posture.attention')} />}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-medium text-ink-600">{t('posture.all', { n: fmtNum(org.total ?? 0) })}</summary>
        <div className="mt-2">
          <ControlTable sections={sections} sectionLabel={sectionLabel} caption={t('posture.all', { n: fmtNum(org.total ?? 0) })} />
        </div>
      </details>
    </section>
  )
}

function ControlTable({ sections, sectionLabel, caption }: { sections: Section[]; sectionLabel: (id: string) => string; caption: string }) {
  const t = useT()
  const ratingLabel = (r: string) => (KNOWN_RATINGS.includes(r as Rating) ? t(`posture.rating.${r}` as 'posture.rating.failed') : titleCase(r))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-ink-100 text-left text-ink-500">
            <th scope="col" className="py-2 pr-3 font-semibold">{t('posture.col.control')}</th>
            <th scope="col" className="py-2 pr-3 font-semibold">{t('posture.col.result')}</th>
            <th scope="col" className="py-2 pr-3 font-semibold">{t('posture.col.current')}</th>
            <th scope="col" className="py-2 font-semibold">{t('posture.col.recommended')}</th>
          </tr>
        </thead>
        {sections.map((s) => (
          <tbody key={s.section}>
            <tr className="bg-paper-muted">
              <th scope="colgroup" colSpan={4} className="px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                {sectionLabel(s.section)} <span className="font-normal normal-case tracking-normal text-ink-400">({fmtNum(s.controls.length)})</span>
              </th>
            </tr>
            {s.controls.map((x, i) => (
              <tr key={x.id ?? i} className="border-b border-ink-50 align-top">
                <td className="py-2 pr-3 text-ink-700 min-w-[12rem]">{x.name ?? x.id ?? '—'}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className={clsx('inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium', RATING_STYLE[x.rating as Rating] ?? RATING_STYLE.descriptive)}>
                    {ratingLabel(x.rating)}
                  </span>
                  {x.accepted_risk && <span className="ml-1.5 text-[11px] text-amber-700">{t('posture.accepted_risk')}</span>}
                </td>
                <td className="py-2 pr-3 max-w-[16rem] break-words text-ink-600">{x.current_value ?? <span className="text-ink-300">—</span>}</td>
                <td className="py-2 max-w-[24rem] break-words text-ink-600">{x.desired_state ?? <span className="text-ink-300">—</span>}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}
