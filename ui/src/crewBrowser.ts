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

/** m:ss, for the progress bar. */
export function clock(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
