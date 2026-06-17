import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Honest hint for org-level pages that do NOT honor the global group scope.
 * Renders nothing when no group is selected; otherwise a subtle banner noting
 * the page shows org-wide data regardless of the selected group.
 */
export function GroupScopeNote() {
  const t = useT()
  const { group } = useGroupScope()
  if (!group) return null
  const label = group === UNMAPPED ? t('group.unmapped') : group
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
      {t('group.note', { group: label })}
    </div>
  )
}
