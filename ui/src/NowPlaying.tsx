/**
 * The now-playing card: the player, the song, why it fits, and like / skip.
 *
 * A YouTube pick plays in a sandboxed iframe on the privacy-enhanced embed host
 * (the origin `app.json` declares in `ui.frameSources`), its URL built from the
 * checked video id. A bilibili pick is a link that opens a new tab in the
 * person's own browser, re-checked before it is drawn. With the Crew Browser
 * player the page passes its own controls as `stage`, drawn in their place.
 */
import type { ReactNode } from 'react'
import { ExternalLink, Heart, SkipForward, Sparkles } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { QueuedPick } from './api'
import { bilibiliUrl, validVideoId, youtubeEmbedUrl } from './links'

export default function NowPlaying({ pick, autoplay, busy, onLike, onSkip, onMore, stage }: {
  pick: QueuedPick
  autoplay: boolean
  busy: boolean
  onLike: () => void
  onSkip: () => void
  onMore: () => void
  /** Drawn instead of the embed or the link (the Crew Browser controls). */
  stage?: ReactNode
}) {
  const embed = !stage && pick.source === 'youtube' ? youtubeEmbedUrl(pick.video_id, autoplay) : null
  const link = !stage && pick.source === 'bilibili' ? bilibiliUrl(pick.url) : null
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
      </p>
      {stage}
      {embed && (
        <div className="mt-3 w-full overflow-hidden rounded-xl bg-[var(--bg-elevated)]" style={{ aspectRatio: '16 / 9' }}>
          <iframe
            key={embed}
            src={embed}
            title={t('page.player_title', { title: pick.title })}
            className="h-full w-full border-0"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            data-testid="mood-youtube-frame"
          />
        </div>
      )}
      {embed && (
        <p className="mt-1.5 text-xs text-[var(--muted)]" data-testid="mood-youtube-note">
          {t('page.youtube_blank')}{' '}
          <a
            href={`https://www.youtube.com/watch?v=${validVideoId(pick.video_id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {t('page.open_youtube')}
          </a>
        </p>
      )}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          style={{ aspectRatio: '3 / 1' }}
          className="mt-3 flex w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--border)] text-[var(--accent)] no-underline hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          data-testid="mood-bilibili-link"
        >
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <ExternalLink size={15} aria-hidden="true" />
            {t('page.open_bilibili')}
          </span>
          <span className="text-xs text-[var(--muted)]">{t('page.bilibili_note')}</span>
        </a>
      )}
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
        <Btn onClick={onLike} disabled={busy} aria-pressed={liked} primary={liked}>
          <Heart size={14} aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
          {liked ? t('page.liked') : t('page.like')}
        </Btn>
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
