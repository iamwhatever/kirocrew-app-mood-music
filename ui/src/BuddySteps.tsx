/**
 * What the buddy did in a turn, in plain words ("Searched the web × 3 · Read a
 * page · Opened a page · Clicked"), under its reply or under the live status.
 * Never a tool name, a search word or an address: those stay in the full record.
 */
import { t } from './i18n'
import type { Step } from './turnState'

export default function BuddySteps({ steps, testId }: { steps: Step[]; testId?: string }) {
  if (!steps.length) return null
  return (
    <ol
      aria-label={t('steps.label')}
      className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--muted)]"
      data-testid={testId}
    >
      {steps.map((s, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          <span>{s.count > 1 ? t('steps.times', { step: t(`steps.${s.kind}`), count: s.count }) : t(`steps.${s.kind}`)}</span>
        </li>
      ))}
    </ol>
  )
}
