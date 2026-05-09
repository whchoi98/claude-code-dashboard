import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { Markdown } from '../components/Markdown'
import { useI18n, useT } from '../lib/i18n'
// CHANGELOG.md is the single source of truth — Vite's `?raw` import bundles
// its content into the SPA at build time. The sidebar version badge links
// here; both are wired to the same file so updates propagate automatically.
import changelogText from '../../CHANGELOG.md?raw'
import pkg from '../../package.json'

const APP_VERSION = pkg.version

export function Changelog() {
  const t = useT()
  const { locale } = useI18n()

  // The CHANGELOG has a top-of-file language switcher and `# English` /
  // `# 한국어` H1 anchors. Keep only the active locale's section so
  // readers don't scroll past the other half. If parsing ever fails
  // (e.g., the file structure changes), fall back to the full document.
  const sections = changelogText.split(/\n# (?=English|한국어)\n/)
  let body = changelogText
  if (sections.length >= 3) {
    // sections[0] = preamble (badges + horizontal rule), [1] = English…, [2] = 한국어…
    const en = sections[1]
    const ko = sections[2]
    body = (locale === 'ko' && ko ? ko : en) ?? changelogText
  }

  return (
    <div>
      <PageHeader
        title={t('changelog.title')}
        subtitle={t('changelog.subtitle', { version: APP_VERSION })}
      />
      <div className="p-8">
        <div className="rounded-xl border border-ink-100 bg-white px-6 py-5 shadow-card max-w-4xl">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-ink-100">
            <div className="flex items-center gap-3">
              <span className="text-[11px] uppercase tracking-widest text-ink-400 font-semibold">
                {t('changelog.current_version')}
              </span>
              <span className="rounded-full bg-claude-100 text-claude-700 px-2.5 py-0.5 text-[12px] font-semibold tabular-nums">
                v{APP_VERSION}
              </span>
            </div>
            <Link
              to="/"
              className="text-[12px] text-ink-500 hover:text-claude-700 transition-colors"
            >
              ← {t('changelog.back')}
            </Link>
          </div>
          <Markdown>{body}</Markdown>
        </div>
      </div>
    </div>
  )
}
