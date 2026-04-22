import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { ClaudeIcon } from './ClaudeIcon'
import { useHealth } from '../lib/useHealth'
import { useI18n } from '../lib/i18n'

const NAV = [
  { to: '/',                  key: 'overview' },
  { to: '/users',             key: 'users' },
  { to: '/user-productivity', key: 'user_productivity' },
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
          <div className="leading-tight">
            <div className="text-[11px] uppercase tracking-widest text-ink-400">{t('product.tag')}</div>
            <div className="text-[15px] font-semibold text-ink-800">{t('product.name')}</div>
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
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
