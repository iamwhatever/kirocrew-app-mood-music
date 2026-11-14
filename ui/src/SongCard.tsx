/**
 * One pick in the buddy's reply (design §1.6): where it sits on the mood arc,
 * the song, why it is here, what to listen for, who praised it, and play /
 * like / skip / "I know it". Every pick drawn here passed the backend link
 * check; the evidence link only ever opens a new tab.
 */
import { Check, ExternalLink, Heart, Play, SkipForward } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import type { QueuedPick } from './api'
import { evidenceUrl } from './links'

const ARC_LABEL = { stay: 'card.arc_stay', turn: 'card.arc_turn', lift: 'card.arc_lift' } as const
const TIER_LABEL = { anchor: 'card.tier_anchor', explore: 'card.tier_explore', deep: 'card.tier_deep' } as const

export default function SongCard({ pick, playing, known, busy, onPlay, onLike, onSkip, onKnown }: {
  pick: QueuedPick
  playing: boolean
  known: boolean
  busy: boolean
  onPlay: () => void
  onLike: () => void
  onSkip: () => void
  onKnown: () => void
}) {
  const liked = pick.feedback === 'liked'
  const evidence = pick.evidence ? evidenceUrl(pick.evidence.url) : null
  return (
    <article
      aria-label={pick.artist ? `${pick.title} · ${pick.artist}` : pick.title}
      className={`rounded-xl border p-3 ${playing ? 'border-[var(--accent)]' : 'border-[var(--border)]'} ${pick.feedback === 'skipped' ? 'opacity-50' : ''}`}
      data-testid="mood-song-card"
    >
      <div className="flex items-baseline justify-between gap-2">
        {pick.arc && <span className="text-[11px] font-semibold text-[var(--accent)]">{t(ARC_LABEL[pick.arc])}</span>}
        {pick.unverified && (
          <span
            className="ml-auto shrink-0 rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]"
            title={t('card.unverified_hint')}
            data-testid="mood-unverified"
          >
            {t('card.unverified')}
          </span>
        )}
        {pick.tier && (
          <span className={`${pick.unverified ? '' : 'ml-auto '}shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]`}>
            {t(TIER_LABEL[pick.tier])}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-semibold text-[var(--text)]">
        {pick.title}
        {pick.artist && <span className="font-normal text-[var(--muted)]"> · {pick.artist}</span>}
      </p>
      {pick.why && <p className="mt-1 text-xs leading-relaxed text-[var(--text)]"><span className="text-[var(--muted)]">{t('card.why')}</span>{pick.why}</p>}
      {pick.listen_for && (
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--text)]"><span className="text-[var(--muted)]">{t('card.listen_for')}</span>{pick.listen_for}</p>
      )}
      {evidence && (
        <a
          href={evidence}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
        >
          {t('card.praised_by')}{pick.evidence?.label || new URL(evidence).hostname}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Btn onClick={onPlay} aria-label={t('page.play', { title: pick.title })} primary={playing}>
          <Play size={13} aria-hidden="true" />
          {t('card.play')}
        </Btn>
        <Btn onClick={onLike} disabled={busy} aria-pressed={liked} aria-label={liked ? t('page.liked') : t('page.like')}>
          <Heart size={13} aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
        </Btn>
        <Btn onClick={onSkip} disabled={busy} aria-label={t('page.skip')}>
          <SkipForward size={13} aria-hidden="true" />
        </Btn>
        <Btn onClick={onKnown} disabled={busy || known} aria-pressed={known}>
          <Check size={13} aria-hidden="true" />
          {known ? t('card.known_done') : t('card.known')}
        </Btn>
      </div>
    </article>
  )
}
