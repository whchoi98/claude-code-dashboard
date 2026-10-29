import { useT } from '../lib/i18n'
import { fmtPct } from '../lib/format'

/**
 * Neutral note for pages whose figures fold in Chat and Cowork unified
 * (lib/unified.ts). Renders only when the window actually holds unified
 * activity: `share` = the unified part of the page's headline counter.
 * kind picks the wording — chat/cowork pages also explain why their DAU
 * stays a separate series; adoption covers the skill/connector/plugin rows.
 */
export function UnifiedNote({ share, kind }: { share: number | null; kind: 'chat' | 'cowork' | 'adoption' }) {
  const t = useT()
  if (share == null || !(share > 0)) return null
  return (
    <div role="note" className="mb-4 rounded-lg border border-ink-100 bg-paper-muted px-3 py-2 text-[11px] text-ink-600">
      {t(`unified.note.${kind}` as const, { pct: fmtPct(share) })}
    </div>
  )
}
