import { Component, type ReactNode } from 'react'
import { useT } from '../lib/i18n'

function PageFailure({ onRetry }: { onRetry: () => void }) {
  const t = useT()
  return (
    <div role="alert" className="m-4 lg:m-8 rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-900">
      <h1 className="text-lg font-semibold">{t('common.page_error')}</h1>
      <p className="mt-2 text-sm">{t('common.page_error_hint')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-medium hover:bg-rose-100">
          {t('common.retry')}
        </button>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg px-3 py-2 text-sm hover:bg-rose-100">
          {t('common.reload')}
        </button>
      </div>
    </div>
  )
}

/** Isolates a failed page or lazy chunk so the rest of the dashboard is usable. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed
      ? <PageFailure onRetry={() => this.setState({ failed: false })} />
      : this.props.children
  }
}
