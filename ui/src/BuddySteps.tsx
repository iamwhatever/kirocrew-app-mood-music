/**
 * What the buddy did in a turn, in plain words, one step per row in the order
 * it happened: "Searched the web × 3", "Read a page", "Opened a page",
 * "Clicked", and the short notes it wrote on the way. Never a tool name, a
 * search word or an address: those stay in the full chat.
 */
import {
  type LucideIcon, ArrowDownUp, Eye, FileText, Globe, Hourglass, Keyboard, MessageSquare, MousePointerClick, PanelTop, Search, Sparkles, Undo2,
} from 'lucide-react'
import { t } from './i18n'
import type { Step, StepKind } from './turnState'

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

export default function BuddySteps({ steps, testId }: { steps: Step[]; testId?: string }) {
  if (!steps.length) return null
  return (
    <ol aria-label={t('steps.label')} className="mm-steps mt-1.5 flex flex-col gap-1 text-xs text-[var(--muted)]" data-testid={testId}>
      {steps.map((s, i) => {
        const Icon = ICONS[s.kind]
        const words = s.kind === 'note'
          ? s.text ?? ''
          : s.count > 1 ? t('steps.times', { step: t(`steps.${s.kind}`), count: s.count }) : t(`steps.${s.kind}`)
        return (
          <li key={i} className="mm-step flex items-start gap-1.5" data-kind={s.kind}>
            <span className="mt-[1px] shrink-0"><Icon size={12} aria-hidden="true" /></span>
            <span className={s.kind === 'note' ? 'italic text-[var(--text)] opacity-80' : ''}>{words}</span>
          </li>
        )
      })}
    </ol>
  )
}
