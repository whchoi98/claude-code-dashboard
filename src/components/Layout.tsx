import { Link, NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { ClaudeIcon } from './ClaudeIcon'
import { useHealth } from '../lib/useHealth'
import { useI18n } from '../lib/i18n'
// Single source of truth for the displayed version. Bumping this in
// package.json (and adding a matching ## [x.y.z] section to CHANGELOG.md)
// is all that's needed to update the badge — the /changelog page reads
// the same package.json + CHANGELOG.md at build time.
import pkg from '../../package.json'

const APP_VERSION = pkg.version

const NAV = [
  { to: '/',                  key: 'overview' },
  { to: '/exec',              key: 'exec', badge: 'Exec' },
  { to: '/users',             key: 'users' },
  { to: '/user-productivity', key: 'user_productivity' },
  { to: '/user-search',       key: 'user_search', badge: '🔍' },
  { to: '/trends',            key: 'trends' },
  { to: '/claude-code',       key: 'claude_code' },
  { to: '/productivity',      key: 'productivity' },
  { to: '/adoption',          key: 'adoption' },
  { to: '/cost',              key: 'cost', badge: '$' },
  { to: '/compliance',        key: 'compliance', badge: '🔒' },
  { to: '/analyze',           key: 'analyze', badge: 'AI' },
  { to: '/archive',           key: 'archive' },
] as const

export function Layout() {
  const health = useHealth()
  const { t, locale, setLocale } = useI18n()

  return (
    <div className="grain min-h-full flex">
      <aside className="w-64 shrink-0 border-r border-ink-100 bg-paper-muted/60 backdrop-blur px-5 py-6 flex flex-col">
        <div className="flex items-center gap-3 mb-8">
          <ClaudeIcon size={36} animate />
          <div className="leading-tight flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-ink-400">{t('product.tag')}</div>
            <div className="text-[15px] font-semibold text-ink-800 truncate">{t('product.name')}</div>
            <Link
              to="/changelog"
              title={t('nav.changelog.hint', { version: APP_VERSION })}
              className="mt-1 inline-block rounded-full bg-claude-100 text-claude-700 px-2 py-0.5 text-[10px] font-semibold tabular-nums hover:bg-claude-200 transition-colors"
            >
              v{APP_VERSION}
            </Link>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-claude-500 text-white shadow-sm'
                    : 'text-ink-600 hover:bg-ink-100 hover:text-ink-800',
                )
              }
            >
              <span className="flex flex-col">
                <span className="font-medium">{t(`nav.${n.key}` as any)}</span>
                <span className="text-[11px] opacity-70 group-hover:opacity-100">
                  {t(`nav.hint.${n.key}` as any)}
                </span>
              </span>
              {'badge' in n && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/20 text-current">
                  {n.badge as string}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-3 pt-6">
          {/* Sign out — full-page navigation to the /signout Lambda@Edge
              handler which clears cookies + redirects to Cognito /logout.
              Uses <a href> (not NavLink) so React Router doesn't intercept
              and try to match /signout against the SPA route table. */}
          <a
            href="/signout"
            className="group flex items-center justify-between rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm text-ink-600 transition-colors hover:border-claude-500 hover:bg-claude-500 hover:text-white"
          >
            <span className="flex flex-col">
              <span className="font-medium">{t('nav.logout')}</span>
              <span className="text-[11px] opacity-70 group-hover:opacity-100">{t('nav.hint.logout')}</span>
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-60 group-hover:opacity-100"
            >
              <path d="M12 3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" />
              <path d="M8 10h9" />
              <path d="M14 7l3 3-3 3" />
            </svg>
          </a>

          {/* Language toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-ink-100 bg-white p-0.5 text-xs font-medium">
            {(['en', 'ko'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={clsx(
                  'flex-1 rounded-md py-1 transition',
                  locale === l
                    ? 'bg-claude-500 text-white shadow-sm'
                    : 'text-ink-500 hover:bg-paper-muted',
                )}
              >
                {l === 'en' ? 'English' : '한국어'}
              </button>
            ))}
          </div>

          {/* Key status */}
          <div className="text-[11px] text-ink-400 leading-relaxed">
            <div className="mb-1 flex items-center gap-1.5">
              <span className={clsx(
                'inline-block w-1.5 h-1.5 rounded-full',
                health?.analyticsKey === 'analytics' ? 'bg-emerald-500' : 'bg-ink-300',
              )} />
              <span>{t('status.analytics_key')}: <b className="text-ink-600">{health?.analyticsKey ?? '…'}</b></span>
            </div>
            <div className="mb-1 flex items-center gap-1.5">
              <span className={clsx(
                'inline-block w-1.5 h-1.5 rounded-full',
                health?.adminKey === 'admin' ? 'bg-emerald-500' : 'bg-ink-300',
              )} />
              <span>{t('status.admin_key')}: <b className="text-ink-600">{health?.adminKey ?? 'none'}</b></span>
            </div>
            {health?.dataConstraints?.firstAvailableDate && (
              <div className="text-ink-400">
                data {'>'}= {health.dataConstraints.firstAvailableDate} · {health.dataConstraints.bufferDays}d buffer
              </div>
            )}
            {/* AWS run-rate — static estimate based on the current
                architecture (Fargate ARM64 + ALB + WAF + CloudFront +
                Lambda@Edge + collector + S3 + Athena + Bedrock light use).
                Hover for the per-component breakdown. */}
            <div
              className="mt-2 pt-2 border-t border-ink-100 text-ink-400"
              title={t('status.aws_cost.hint')}
            >
              {t('status.aws_cost.label')}: <b className="text-ink-600 tabular-nums">≈ $65/mo</b>
              <span className="text-ink-300"> · ap-northeast-2</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
