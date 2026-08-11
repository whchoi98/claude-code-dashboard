import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { restoreOrgSelection } from './lib/OrgProvider'
import { setUnmasked } from './lib/format'
import './index.css'

// Must run before the Router mounts — see restoreOrgSelection docs.
restoreOrgSelection()

// Identity-aware masking (ADR-0020): resolve the caller's identity BEFORE
// mounting so maskEmail()'s behavior is fixed for the whole session — no
// re-render plumbing, zero changes at the ~19 call sites. Fail-closed: any
// error/timeout keeps masking, and the server independently re-verifies the
// same token for its own surfaces (chat, archive), so this is display-only.
async function resolveMasking(): Promise<void> {
  try {
    const res = await fetch('/api/me', { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const me = await res.json()
      setUnmasked(me?.unmask === true)
    }
  } catch { /* masked by default */ }
}

// .finally() instead of top-level await — the Vite build target predates
// TLA, and mounting must proceed (masked) even if /api/me never settles.
resolveMasking().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </I18nProvider>
    </React.StrictMode>,
  )
})
