/**
 * The Crew Browser player's buttons: play / pause, a progress bar and volume.
 *
 * They act on the tab the buddy opened, straight through the host's media route
 * (`crewBrowser.ts`), never through the buddy. Only starting a song the tab is
 * not playing yet goes to the buddy (`onAskPlay`), because finding and opening
 * it is the buddy's job.
 *
 * Continuous play lives here too, with a plain note that it needs this page
 * open: the end of a song is read by this page's poll, so with the page closed
 * nothing notices it and the next song does not start.
 */
import { useEffect, useState } from 'react'
import { Pause, Play, Repeat, Volume2 } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import type { BrowserMedia } from '@kirocrew/app-sdk'
import { t } from './i18n'
import { clock } from './crewBrowser'

export default function BrowserControls({ media, inTab, waiting, continuous, onAskPlay, onPause, onPlay, onContinuous }: {
  media: BrowserMedia
  /** The tab plays this song (the buddy said it opened it). */
  inTab: boolean
  /** A turn is out to the buddy. */
  waiting: boolean
  continuous: boolean
  onAskPlay: () => void
  onPause: () => void
  onPlay: () => void
  onContinuous: (on: boolean) => void
}) {
  const state = inTab ? media.media : null
  const duration = state?.duration ?? null
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const [volDraft, setVolDraft] = useState<number | null>(null)
  // A new answer from the tab replaces whatever was being dragged once it lands.
  useEffect(() => { setVolDraft(null) }, [state?.volume])

  const playing = !!state && !state.paused && !state.ended
  const status = waiting && !inTab ? t('browser.status_opening')
    : !inTab ? t('browser.status_idle')
      : media.error === 'user_in_control' ? t('browser.status_in_control')
        : !state ? t('browser.status_no_media')
          : state.ended ? t('browser.status_ended')
            : state.paused ? t('browser.status_paused')
              : t('browser.status_playing')
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
        {playing ? (
          <Btn onClick={onPause} disabled={media.busy} aria-label={t('browser.pause')} data-testid="mood-browser-pause">
            <Pause size={14} aria-hidden="true" />
            {t('browser.pause')}
          </Btn>
        ) : (
          <Btn
            primary
            onClick={inTab && state && !state.ended ? onPlay : onAskPlay}
            disabled={media.busy || (waiting && !inTab)}
            aria-label={t('browser.play')}
            data-testid="mood-browser-play"
          >
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
