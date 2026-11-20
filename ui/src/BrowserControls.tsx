/**
 * The Crew Browser player's buttons: play / pause, a progress bar and volume.
 *
 * They act on whatever the buddy's tab is playing, straight through the host's
 * media route (`crewBrowser.ts`, `POST /api/browser/media`), never through the
 * buddy, so they answer at once: the button shows the new state as soon as it
 * is pressed, and the tab's answer confirms it. A read in flight (the page's
 * poll) never blocks a press. Only a tab with no song in it sends the play
 * button to the buddy (`onAskPlay`, labelled "Find and play"), because finding
 * and opening a song is the buddy's job.
 *
 * Continuous play lives here too, with a plain note that it needs this page
 * open: the end of a song is read by this page's poll, so with the page closed
 * nothing notices it and the next song does not start.
 */
import { useEffect, useState } from 'react'
import { Pause, Play, Repeat, Search, Volume2 } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import type { BrowserMedia } from '@kirocrew/app-sdk'
import { t } from './i18n'
import { clock } from './crewBrowser'

export default function BrowserControls({ media, waiting, continuous, onAskPlay, onPause, onPlay, onReplay, onContinuous }: {
  media: BrowserMedia
  /** A turn is out to the buddy. */
  waiting: boolean
  continuous: boolean
  /** The tab has no song: ask the buddy to find and open one. */
  onAskPlay: () => void
  onPause: () => void
  onPlay: () => void
  /** The tab's song ended: play it again from the start. */
  onReplay: () => void
  onContinuous: (on: boolean) => void
}) {
  const state = media.media
  const duration = state?.duration ?? null
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const [volDraft, setVolDraft] = useState<number | null>(null)
  // What the person just pressed, shown until the tab's next answer lands.
  const [want, setWant] = useState<'play' | 'pause' | null>(null)
  // A new answer from the tab replaces whatever was pressed or dragged.
  useEffect(() => { setWant(null) }, [state])
  useEffect(() => { setVolDraft(null) }, [state?.volume])

  const ended = !!state?.ended && want !== 'play'
  const playing = want ? want === 'play' : !!state && !state.paused && !state.ended
  const status = !state
    ? (media.error === 'user_in_control' ? t('browser.status_in_control')
      : waiting ? t('browser.status_opening') : t('browser.status_idle'))
    : media.error === 'user_in_control' ? t('browser.status_in_control')
      : ended ? t('browser.status_ended')
        : playing ? t('browser.status_playing')
          : t('browser.status_paused')
  const pause = () => { setWant('pause'); onPause() }
  const play = () => {
    setWant('play')
    if (state?.ended) onReplay()
    else onPlay()
  }
  const commitSeek = () => {
    if (seekDraft !== null) void media.seek(seekDraft)
    setSeekDraft(null)
  }
  const commitVolume = () => {
    if (volDraft !== null) void media.setVolume(volDraft)
  }
  const position = seekDraft ?? state?.currentTime ?? 0

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3" data-testid="mood-browser-controls">
      <p className="text-xs text-[var(--muted)]" role="status" data-testid="mood-browser-status">{status}</p>
      <div className="flex items-center gap-2">
        {!state ? (
          <Btn primary onClick={onAskPlay} disabled={waiting} data-testid="mood-browser-play">
            <Search size={14} aria-hidden="true" />
            {t('browser.find_play')}
          </Btn>
        ) : playing ? (
          <Btn onClick={pause} aria-label={t('browser.pause')} data-testid="mood-browser-pause">
            <Pause size={14} aria-hidden="true" />
            {t('browser.pause')}
          </Btn>
        ) : (
          <Btn primary onClick={play} aria-label={t('browser.play')} data-testid="mood-browser-play">
            <Play size={14} aria-hidden="true" />
            {t('browser.play')}
          </Btn>
        )}
        <span className="w-10 text-right text-xs tabular-nums text-[var(--muted)]">{clock(state ? position : null)}</span>
        <input
          type="range"
          aria-label={t('browser.progress')}
          min={0}
          max={duration ?? 0}
          step={1}
          value={duration ? Math.min(position, duration) : 0}
          disabled={!state || !duration}
          onChange={e => setSeekDraft(Number(e.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          className="min-w-0 flex-1 accent-[var(--accent)]"
          data-testid="mood-browser-seek"
        />
        <span className="w-10 text-xs tabular-nums text-[var(--muted)]">{clock(state ? duration : null)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <Volume2 size={14} aria-hidden="true" />
          <span className="sr-only">{t('browser.volume')}</span>
          <input
            type="range"
            aria-label={t('browser.volume')}
            min={0}
            max={1}
            step={0.05}
            value={volDraft ?? state?.volume ?? 1}
            disabled={!state}
            onChange={e => setVolDraft(Number(e.target.value))}
            onPointerUp={commitVolume}
            onKeyUp={commitVolume}
            className="w-24 accent-[var(--accent)]"
            data-testid="mood-browser-volume"
          />
        </label>
        <button
          type="button"
          aria-pressed={continuous}
          onClick={() => onContinuous(!continuous)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${continuous
            ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
            : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`}
          data-testid="mood-continuous"
        >
          <Repeat size={13} aria-hidden="true" />
          {t('browser.continuous')}
        </button>
      </div>
      <p className="text-xs text-[var(--muted)]" data-testid="mood-continuous-note">{t('browser.continuous_note')}</p>
    </div>
  )
}
