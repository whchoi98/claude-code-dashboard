import { Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ClaudeIcon } from './ClaudeIcon'
import { FloatingChat } from './chat/FloatingChat'
import { useHealth } from '../lib/useHealth'
import { useI18n } from '../lib/i18n'
import { DEFAULT_ORG, useOrg } from '../lib/OrgProvider'
import { LoadingState } from './LoadingState'
import { PageErrorBoundary } from './PageErrorBoundary'
// Single source of truth for the displayed version. Bumping this in
// package.json (and adding a matching ## [x.y.z] section to CHANGELOG.md)
// is all that's needed to update the badge — the /changelog page reads
// the same package.json + CHANGELOG.md at build time.
import pkg from '../../package.json'

const APP_VERSION = pkg.version

const NAV = [
  { to: '/',                  key: 'overview',          badge: '📊' },
  { to: '/exec',              key: 'exec',              badge: 'Exec' },
  { to: '/users',             key: 'users',             badge: '👥' },
  { to: '/user-productivity', key: 'user_productivity', badge: '⚡' },
  { to: '/user-search',       key: 'user_search',       badge: '🔍' },
  { to: '/trends',            key: 'trends',            badge: '📈' },
  { to: '/claude-code',       key: 'claude_code',       badge: '💻' },
  { to: '/claude-chat',       key: 'claude_chat',       badge: '💬' },
  { to: '/cowork',            key: 'cowork',            badge: '🤝' },
  { to: '/office',            key: 'office',            badge: '📑' },
  { to: '/design',            key: 'design',            badge: '🎨' },
  { to: '/productivity',      key: 'productivity',      badge: '🎯' },
  { to: '/agentic',           key: 'agentic',           badge: '🤖' },
  { to: '/adoption',          key: 'adoption',          badge: '🌱' },
  { to: '/cost',              key: 'cost',              badge: '$' },
  { to: '/cost-live',         key: 'cost_live',         badge: '⏱' },
  { to: '/compliance',        key: 'compliance',        badge: '🔒' },
  { to: '/analyze',           key: 'analyze',           badge: 'AI' },
  { to: '/archive',           key: 'archive',           badge: '📦' },
] as const

export function Layout() {
  const health = useHealth()
  const { t, locale, setLocale } = useI18n()
  // Mobile: the sidebar becomes a slide-in drawer behind a hamburger button
  // (< lg). Closed on every navigation so a menu tap always lands on content.
  const [navOpen, setNavOpen] = useState(false)
  const [navQuery, setNavQuery] = useState('')
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia?.('(min-width: 1024px)').matches ?? true)
  const drawerRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const lastPath = useRef(location.pathname)
  // Carry ONLY the scope params across sidebar navigation (?group= and
  // ?org=), so the per-page GroupTabs selection and the org switcher survive
  // page switches. Date-range params stay per-page on purpose — each page
  // has its own default window.
  const [searchParams] = useSearchParams()
  const { org, setOrg, orgs } = useOrg()
  const groupQ = searchParams.get('group')
  const withGroup = (path: string) => {
    const q = new URLSearchParams()
    if (groupQ) q.set('group', groupQ)
    if (org !== DEFAULT_ORG) q.set('org', org)
    const qs = q.toString()
    return qs ? `${path}?${qs}` : path
  }
  const query = navQuery.trim().toLowerCase()
  const filteredNav = NAV.filter((entry) =>
    `${t(`nav.${entry.key}`)} ${t(`nav.hint.${entry.key}`)} ${entry.to}`.toLowerCase().includes(query),
  )

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const onChange = () => {
      setIsDesktop(media.matches)
      if (media.matches) setNavOpen(false)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (isDesktop) {
          searchRef.current?.focus()
          searchRef.current?.select()
        } else setNavOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDesktop])

  useEffect(() => {
    if (!navOpen || isDesktop) return
    const drawer = drawerRef.current
    const main = mainRef.current
    if (!drawer || !main) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousInert = main.inert
    const previousOverflow = main.style.overflow
    searchRef.current?.focus()
    main.inert = true
    main.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setNavOpen(false)
        setNavQuery('')
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
      )).filter((element) => !element.hidden)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      main.inert = previousInert
      main.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [navOpen, isDesktop])

  useEffect(() => {
    if (lastPath.current === location.pathname) return
    lastPath.current = location.pathname
    setNavOpen(false)
    setNavQuery('')
    if (mainRef.current) {
      mainRef.current.scrollTop = 0
      mainRef.current.focus({ preventScroll: true })
    }
  }, [location.pathname])

  useEffect(() => {
    const entry = NAV.find((item) => item.to === location.pathname)
    const title = entry ? t(`nav.${entry.key}`) : t('changelog.title')
    document.title = `${title} · ${t('product.name')}`
  }, [location.pathname, t])

  return (
    // h-screen pins the layout to the viewport so the sidebar stays put
    // while the main pane scrolls independently. Without this, scrolling
    // the page moved the whole flex container — sidebar included.
    <div className="grain h-screen flex">
      <a
        href="#main-content"
        onClick={(event) => { event.preventDefault(); mainRef.current?.focus() }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:text-ink-800 focus:shadow-lg"
      >
        {t('nav.skip')}
      </a>
      {/* Mobile drawer backdrop */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink-900/40 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        ref={drawerRef}
        id="app-nav"
        role={navOpen && !isDesktop ? 'dialog' : undefined}
        aria-modal={navOpen && !isDesktop ? true : undefined}
        aria-label={t('nav.label')}
        className={clsx(
          'w-64 shrink-0 h-full overflow-y-auto border-r border-ink-100 bg-paper-muted/95 lg:bg-paper-muted/60 backdrop-blur flex flex-col',
          // Standalone-PWA safe areas (env() = 0 in regular browsers, so
          // desktop/browser rendering is byte-identical): keep the drawer
          // clear of the status bar, home indicator, and landscape notch.
          'pr-5 pl-[calc(1.25rem+env(safe-area-inset-left))] pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))]',
          // Drawer on mobile, static column on lg+. z-auto on lg — a z-index
          // on a flex item creates a stacking context even when static, which
          // would float the desktop sidebar above the UserDetailPanel
          // backdrop. `invisible` when closed removes the offscreen drawer
          // from the tab order and the accessibility tree (transforms alone
          // don't); lg:visible keeps the desktop column untouched.
          'fixed inset-y-0 left-0 z-40 lg:z-auto transform transition-transform duration-200 lg:static lg:translate-x-0',
          navOpen ? 'translate-x-0 visible' : '-translate-x-full invisible lg:visible',
        )}
      >
        <div className="flex items-center gap-3 mb-5">
          <ClaudeIcon size={36} animate />
          <div className="leading-tight flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-ink-400">{t('product.tag')}</div>
            <div className="text-[15px] font-semibold text-ink-800 truncate">{t('product.name')}</div>
            <Link
              to={withGroup('/changelog')}
              onClick={() => setNavOpen(false)}
              title={t('nav.changelog.hint', { version: APP_VERSION })}
              className="mt-1 inline-block rounded-full bg-claude-100 text-claude-700 px-2 py-0.5 text-[10px] font-semibold tabular-nums hover:bg-claude-200 transition-colors"
            >
              v{APP_VERSION}
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label={t('nav.close_menu')}
            className="lg:hidden rounded-lg px-2 py-1 text-xl text-ink-500 hover:bg-ink-100"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <form
          role="search"
          className="relative mb-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!filteredNav[0]) return
            navigate(withGroup(filteredNav[0].to))
            setNavQuery('')
            setNavOpen(false)
          }}
        >
          <input
            ref={searchRef}
            type="search"
            value={navQuery}
            onChange={(event) => setNavQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && isDesktop) { event.preventDefault(); setNavQuery('') }
            }}
            aria-label={t('nav.search')}
            aria-keyshortcuts="Control+k Meta+k"
            aria-controls="app-nav-links"
            placeholder={t('nav.search_hint')}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 pr-8 text-xs text-ink-700 focus:border-claude-500 focus:outline-none"
          />
          {navQuery && (
            <button
              type="button"
              aria-label={t('nav.clear_search')}
              onClick={() => { setNavQuery(''); searchRef.current?.focus() }}
              className="absolute right-1 top-1 rounded px-2 py-1 text-ink-400 hover:text-ink-700"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
          <span role="status" className="sr-only">{query ? t('nav.search_results', { n: filteredNav.length }) : ''}</span>
        </form>
        {filteredNav.length === 0 && <p className="px-3 py-4 text-xs text-ink-500">{t('nav.no_results')}</p>}
        <nav id="app-nav-links" aria-label={t('nav.label')} className="flex flex-col gap-1">
          {filteredNav.map((n) => (
            <NavLink
              key={n.to}
              to={withGroup(n.to)}
              end={n.to === '/'}
              onClick={() => { setNavOpen(false); setNavQuery('') }}
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

          {/* Org switcher — hidden entirely in single-org deployments.
              Segmented control matching the language toggle below; labels
              come from GET /api/orgs (server env CCD_ORG_LABEL/CCD_ORG2_LABEL).
              Switching resets the ?group= selection (per-org maps). */}
          {orgs.length > 1 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">{t('org.label')}</div>
              <div
                className="flex items-center gap-1 rounded-lg border border-ink-100 bg-white p-0.5 text-xs font-medium"
                title={t('org.hint')}
                role="group"
                aria-label={t('org.label')}
              >
                {orgs.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setOrg(o.id)}
                    aria-pressed={org === o.id}
                    className={clsx(
                      'flex-1 min-w-0 truncate rounded-md px-2 py-1 transition',
                      org === o.id
                        ? 'bg-claude-500 text-white shadow-sm'
                        : 'text-ink-500 hover:bg-paper-muted',
                    )}
                    title={o.label}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

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

      {/* Safe-area split (review-settled): main carries ONLY the bottom
          inset. The SIDE insets live on the sticky top bar (whose background
          must paint full-bleed under the notch — side padding on main would
          stop it env() short of the display edge) and on the Outlet wrapper
          (which protects scrolled page content). Putting them on main too
          would double-count the landscape insets. */}
      <main ref={mainRef} id="main-content" tabIndex={-1} className="flex-1 min-w-0 h-full overflow-y-auto pb-[env(safe-area-inset-bottom)] focus:outline-none">
        {/* Mobile top bar — hamburger + product identity (hidden on lg+).
            pt carries the standalone-PWA status-bar inset (sticky top-0 sits
            flush under the notch otherwise); pl/pr cover the landscape notch. */}
        <div className="lg:hidden sticky top-0 z-20 flex items-center gap-3 border-b border-ink-100 bg-paper-muted/90 backdrop-blur pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]">
          <button
            ref={menuButtonRef}
            onClick={() => setNavOpen(true)}
            aria-label={t('nav.open_menu')}
            aria-expanded={navOpen}
            aria-controls="app-nav"
            className="rounded-lg border border-ink-200 bg-white p-2 text-ink-600 hover:border-claude-500"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
          <ClaudeIcon size={24} />
          <span className="text-sm font-semibold text-ink-800 truncate">{t('product.name')}</span>
          <Link
            to={withGroup('/changelog')}
            className="ml-auto rounded-full bg-claude-100 text-claude-700 px-2 py-0.5 text-[10px] font-semibold tabular-nums"
          >
            v{APP_VERSION}
          </Link>
        </div>
        {/* Side safe-area insets for page content (landscape notch/rounded
            corners) — env() = 0 everywhere except notched iPhones. */}
        <div className="pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          <PageErrorBoundary key={`${location.pathname}:${org}`}>
            <Suspense fallback={<LoadingState />}>
              <Outlet />
            </Suspense>
          </PageErrorBoundary>
        </div>
      </main>
      {/* Hidden (not unmounted — keeps the conversation) while the mobile
          drawer is open: both are z-40 fixed and the chat pill overlaps the
          drawer's footer, stealing taps. */}
      <div className={navOpen ? 'max-lg:hidden' : undefined}>
        <FloatingChat />
      </div>
    </div>
  )
}
