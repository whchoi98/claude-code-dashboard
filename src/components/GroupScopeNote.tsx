import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Honest hint for org-level pages about how the global group scope applies.
 * Renders nothing when no group is selected; otherwise a subtle banner.
 * variant="full" (default) — page ignores the scope entirely (amber warning).
 * variant="partial" — per-user tables/charts ARE scoped, org aggregates are
 * not (amber warning; e.g. Cost in CSV mode).
 * variant="scoped" — the page's org-level numbers are genuinely filtered to
 * the group via the upstream rbac_group_ids[] filter (neutral info tone;
 * still worth a banner because attribution is any-membership, so group
 * scopes can sum above the org total, and the Cost-by-Group card stays
 * org-wide for comparison).
 */
export function GroupScopeNote({ variant = 'full' }: { variant?: 'full' | 'partial' | 'scoped' }) {
  const t = useT()
  const { group } = useGroupScope()
  if (!group) return null
  const label = group === UNMAPPED ? t('group.unmapped') : group
  if (variant === 'scoped') {
    return (
      <div className="mb-4 rounded-lg border border-ink-100 bg-paper-muted px-3 py-2 text-[11px] text-ink-600">
        {t('group.note.scoped', { group: label })}
      </div>
    )
  }
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
      {t(variant === 'partial' ? 'group.note.partial' : 'group.note', { group: label })}
    </div>
  )
}
