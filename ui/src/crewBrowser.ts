/**
 * The "Crew Browser" player: the buddy plays songs in Kiro Crew's own browser
 * (on a Mac, the person's own Chrome, with its logins and its sound), and the
 * page's buttons reach that tab through the host's `useBrowserMedia` (App Kit
 * level 10, `POST /api/browser/media`), with no agent turn.
 *
 * The hook is read off a namespace import: an older host has no such export, and
 * a named import of a missing export would fail the whole bundle. Whichever hook
 * this host has is the one every render calls, so the hook order never changes.
 *
 * Whether the owner approved `permissions.browserSites` is read from the media
 * route itself: it answers `not_app_browser` for a session whose app holds no
 * approved site, so no extra permission is needed to find out.
 */
import * as sdk from '@kirocrew/app-sdk'
import type { BrowserMedia, BrowserMediaState } from '@kirocrew/app-sdk'

/** The level that brought `useBrowserMedia` and `permissions.browserSites`. */
export const BROWSER_SDK_LEVEL = 10
/** How often the page reads the tab while the Crew Browser player is on. */
export const MEDIA_POLL_MS = 1500
/** Where the owner approves the app's sites: the app's own page in Kiro Crew. */
export const APPROVE_PATH = '/apps/detail/mood-music'

/** Why the Crew Browser cannot play right now, or `ready`. */
export type BrowserReadiness = 'ready' | 'old_host' | 'not_approved' | 'browse_off' | 'unknown'

/** The host's hook when it has one; feature-checked, never the level alone. */
export function hostMediaHook(): typeof sdk.useBrowserMedia {
  const level = typeof sdk.APP_SDK_LEVEL === 'number' ? sdk.APP_SDK_LEVEL : 0
  return level >= BROWSER_SDK_LEVEL && typeof sdk.useBrowserMedia === 'function' ? sdk.useBrowserMedia : undefined
}

/** The level that brought `BrowserView` (the live view of the app's own slot). */
export const VIEW_SDK_LEVEL = 11

/** The host's live view when it has one; feature-checked, never the level alone. */
export function hostBrowserView(): typeof sdk.BrowserView {
  const level = typeof sdk.APP_SDK_LEVEL === 'number' ? sdk.APP_SDK_LEVEL : 0
  return level >= VIEW_SDK_LEVEL && typeof sdk.BrowserView === 'function' ? sdk.BrowserView : undefined
}

const noop = async () => undefined
const NO_MEDIA: BrowserMedia = {
  media: null, error: 'old_host', busy: false,
  play: noop, pause: noop, seek: noop, setVolume: noop, refresh: noop,
}

/** The stand-in on a host without the hook: never reads, never plays. */
function useNoBrowserMedia(): BrowserMedia {
  return NO_MEDIA
}

/**
 * The media controls of *sessionKey*'s tab. Polls only while *on* (the Crew
 * Browser player is chosen); otherwise it reads once, which is how the page
 * learns whether the sites are approved.
 */
export function useCrewBrowser(
  sessionKey: string,
  on: boolean,
  onEnded: (media: BrowserMediaState) => void,
): BrowserMedia {
  const hook = hostMediaHook() ?? useNoBrowserMedia
  return hook(sessionKey, { pollMs: on ? MEDIA_POLL_MS : 0, onEnded })
}

/** What an answer of the media route says about playing here. */
export function readiness(media: BrowserMedia): BrowserReadiness {
  if (!hostMediaHook()) return 'old_host'
  switch (media.error) {
    case 'old_host':
    case 'not_declared':
      return 'old_host'
    case 'not_app_browser':
      return 'not_approved'
    case 'policy_denied':
      return 'browse_off'
    case 'unknown_session':
    case 'browser_error':
      return media.media ? 'ready' : 'unknown'
    default:
      // `no_tab`, `no_media`, `redirect_refused` and the rest come from an approved session.
      return 'ready'
  }
}

/** How near its end a reading must be for a lost source next to count as an ending. */
export const NEAR_END_S = 2

/**
 * Whether the song ended between two readings although no reading said
 * `ended`: the last one was within {@link NEAR_END_S} of the end, and now the
 * length is gone, or the clock is back at 0 with the video stopped. YouTube
 * drops the video's source at its end screen, so `ended` may never show.
 * shortcut: a stopgap for hosts that report only `ended`; drop it once Kiro Crew
 * counts endings itself.
 */
export function endedBetween(prev: BrowserMediaState | null, now: BrowserMediaState | null): boolean {
  if (!prev || !now || prev.ended || typeof prev.duration !== 'number' || !(prev.duration > 0)) return false
  if (prev.duration - prev.currentTime > NEAR_END_S) return false
  return now.duration === null || (now.currentTime === 0 && now.paused)
}

/** Whether the tab still shows a song over: `ended`, or stopped with no length or at 0. */
export function stillEnded(media: BrowserMediaState | null): boolean {
  return !!media && (media.ended || (media.paused && (media.duration === null || media.currentTime === 0)))
}

/** m:ss, for the progress bar. */
export function clock(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
