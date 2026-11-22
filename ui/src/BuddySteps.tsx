/**
 * What the buddy did in a turn, in plain words, one step per row in the order
 * it happened: "Searched the web × 3", "Read a page", "Opened a page",
 * "Clicked", and the short notes it wrote on the way. Never a tool name, a
 * search word or an address: those stay in the full chat.
 *
 * As in the Crew dashboard chat: while the turn runs, the newest
 * {@link LIVE_STEPS} rows show, newest last; once it is over, its steps fold
 * into one row that opens to show them all.
 */
import { useState } from 'react'
import {
  type LucideIcon, ArrowDownUp, ChevronRight, Eye, FileText, Globe, Hourglass, Keyboard, MessageSquare, MousePointerClick, PanelTop, Search, Sparkles, Undo2,
} from 'lucide-react'
import { t } from './i18n'
import type { Step, StepKind } from './turnState'

/** How many of a running turn's newest steps show. */
export const LIVE_STEPS = 5

const ICONS: Record<StepKind, LucideIcon> = {
  search: Search,
  read: FileText,
  open: Globe,
  click: MousePointerClick,
  type: Keyboard,
  look: Eye,
  scroll: ArrowDownUp,
  wait: Hourglass,
  back: Undo2,
  tab: PanelTop,
  key: Keyboard,
  browser: Globe,
  other: Sparkles,
  note: MessageSquare,
}

/** *start*: where the first row sits in the whole turn. Rows are keyed by that, so
 *  a new row rises in and the older ones keep their place as the oldest drops off. */
function StepList({ steps, start = 0, testId }: { steps: Step[]; start?: number; testId?: string }) {
  return (
    <ol aria-label={t('steps.label')} className="mm-steps mt-1.5 flex flex-col gap-1 text-xs text-[var(--muted)]" data-testid={testId}>
      {steps.map((s, i) => {
        const Icon = ICONS[s.kind]
        const words = s.kind === 'note'
          ? s.text ?? ''
          : s.count > 1 ? t('steps.times', { step: t(`steps.${s.kind}`), count: s.count }) : t(`steps.${s.kind}`)
        return (
          <li key={start + i} className="mm-step flex items-start gap-1.5" data-kind={s.kind}>
            <span className="mt-[1px] shrink-0"><Icon size={12} aria-hidden="true" /></span>
            <span className={s.kind === 'note' ? 'italic text-[var(--text)] opacity-80' : ''}>{words}</span>
          </li>
        )
      })}
    </ol>
  )
}

export default function BuddySteps({ steps, live = false, testId }: { steps: Step[]; live?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  if (live) {
    const start = Math.max(0, steps.length - LIVE_STEPS)
    return <StepList steps={steps.slice(start)} start={start} testId={testId} />
  }
  const count = steps.reduce((n, s) => n + s.count, 0)
  return (
    <div data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="mm-press mm-fold inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        data-testid="mood-steps-fold"
      >
        <ChevronRight size={12} aria-hidden="true" className="mm-chevron" data-open={open} />
        {t('steps.folded', { count })}
      </button>
      {open && <StepList steps={steps} />}
    </div>
  )
}
