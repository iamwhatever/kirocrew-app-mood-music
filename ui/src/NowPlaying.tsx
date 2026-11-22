/**
 * The now-playing card: the player, the song, why it fits, and like / skip.
 *
 * Songs play only in Kiro Crew's browser. The page passes the player as
 * `stage`: the Crew Browser controls, or the note that says why it cannot play
 * here yet.
 */
import type { ReactNode } from 'react'
import { Heart, SkipForward, Sparkles } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { QueuedPick } from './api'

export default function NowPlaying({ pick, busy, onLike, onSkip, onMore, stage, fromOldList = false }: {
  pick: QueuedPick
  busy: boolean
  /** Still playing from a list the buddy since replaced: it is in no queue, so it cannot be liked here. */
  fromOldList?: boolean
  onLike: () => void
  onSkip: () => void
  onMore: () => void
  /** The player: the Crew Browser controls, or why they cannot play yet. */
  stage: ReactNode
}) {
  const liked = pick.feedback === 'liked'

  return (
    <section
      aria-label={t('page.now_playing')}
      className="rounded-2xl border border-[var(--border)] p-4 shadow-sm"
      style={CARD_STYLE}
      data-testid="mood-now-playing"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        {t('page.now_playing')}
        {fromOldList && <span className="ml-2 font-normal normal-case tracking-normal" data-testid="mood-now-old-list">{t('page.from_old_list')}</span>}
      </p>
      {stage}
      <h2 className="mt-3 text-lg font-semibold leading-snug text-[var(--text)]">{pick.title}</h2>
      {pick.unverified && (
        <p className="text-xs text-[var(--muted)]" title={t('card.unverified_hint')}>{t('card.unverified')}</p>
      )}
      {pick.artist && <p className="text-sm text-[var(--muted)]">{pick.artist}</p>}
      {pick.why && (
        <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
          <span className="sr-only">{t('page.why')}: </span>
          {pick.why}
        </p>
      )}
      {pick.listen_for && (
        <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
          <span className="text-[var(--muted)]">{t('card.listen_for')}</span>
          {pick.listen_for}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!fromOldList && (
          <Btn onClick={onLike} disabled={busy} aria-pressed={liked} primary={liked}>
            <Heart size={14} aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
            {liked ? t('page.liked') : t('page.like')}
          </Btn>
        )}
        <Btn onClick={onSkip} disabled={busy}>
          <SkipForward size={14} aria-hidden="true" />
          {t('page.skip')}
        </Btn>
        <Btn onClick={onMore} disabled={busy}>
          <Sparkles size={14} aria-hidden="true" />
          {t('page.more')}
        </Btn>
      </div>
    </section>
  )
}
