/** The Moments tab: each mood the person shared, newest first, with its songs. */
import { Music } from 'lucide-react'
import { EmptyState } from '@kirocrew/app-sdk/ui'
import { fmtDateTime } from '@kirocrew/app-sdk'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { Moment } from './api'

export default function MomentsTab({ moments }: { moments: Moment[] }) {
  if (moments.length === 0) {
    return (
      <EmptyState
        icon={<Music size={28} />}
        title={t('page.moments_empty_title')}
        subtitle={t('page.moments_empty_body')}
      />
    )
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="mood-moments">
      {moments.map(m => (
        <li key={m.id} className="rounded-xl border border-[var(--border)] p-3" style={CARD_STYLE}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--text)]">{m.mood}</p>
            <time className="shrink-0 text-xs text-[var(--muted)]" dateTime={new Date(m.at * 1000).toISOString()}>
              {fmtDateTime(m.at * 1000)}
            </time>
          </div>
          {m.note && <p className="mt-1 text-sm text-[var(--text)]">{m.note}</p>}
          {m.tags.length > 0 && (
            <p className="mt-1 text-xs text-[var(--muted)]">{m.tags.join(' · ')}</p>
          )}
          {m.songs.length > 0 && (
            <ol className="mt-2 list-decimal pl-5 text-xs text-[var(--muted)]">
              {m.songs.map((s, i) => (
                <li key={i}>{s.artist ? `${s.title} — ${s.artist}` : s.title}</li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ul>
  )
}
