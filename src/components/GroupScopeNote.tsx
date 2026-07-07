import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Honest hint for org-level pages that do NOT (or only partially) honor the
 * global group scope. Renders nothing when no group is selected; otherwise a
 * subtle banner noting which parts of the page ignore the selected group.
 * variant="partial" is for pages whose per-user tables/charts ARE scoped
 * while org-wide aggregates remain unscoped (e.g. Cost).
 */
export function GroupScopeNote({ variant = 'full' }: { variant?: 'full' | 'partial' }) {
  const t = useT()
  const { group } = useGroupScope()
  if (!group) return null
  const label = group === UNMAPPED ? t('group.unmapped') : group
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
      {t(variant === 'partial' ? 'group.note.partial' : 'group.note', { group: label })}
    </div>
  )
}
