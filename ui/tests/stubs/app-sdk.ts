/**
 * A light stand-in for the host's `@kirocrew/app-sdk`, at App Kit level 1.
 *
 * Only the names the bundle uses, with the host's documented behaviour where a
 * test depends on it. The `stub*` / `resetStubSdk` exports are test controls; no
 * host module has them. A test that needs an older host replaces this module
 * with `vi.mock`.
 */

import { vi } from 'vitest'
import { createElement, useEffect, useReducer, type KeyboardEvent } from 'react'
import type { AppApi, BrowserMedia, BrowserMediaState, ChatLaunchOptions, NumberOptions } from '@kirocrew/app-sdk'

let locale = 'en'

/** The host's active language for the next lookups. */
export function stubLocale(next: string): void {
  locale = next
}

export const stubOpenChat = vi.fn<(opts?: ChatLaunchOptions) => void>()

export function resetStubSdk(): void {
  locale = 'en'
  stubOpenChat.mockReset()
}

export function activeLocale(): string {
  return locale
}

export function useLanguageGeneration(): number {
  return 0
}

export function fmtDateTime(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function fmtNumber(value: number, options?: NumberOptions): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, options).format(value)
}

export function fmtCurrency(value: number, currency = 'USD', options?: NumberOptions): string {
  if (!Number.isFinite(value)) return '—'
  return fmtNumber(value, { style: 'currency', currency, ...options })
}

export const APP_SDK_LEVEL = 10

export const stubNavigate = vi.fn<(path: string) => void>()

export function useNavigate(): (path: string) => void {
  return stubNavigate
}

type MediaFn = (value?: number) => Promise<void>

/** What the stub `useBrowserMedia` answers, and what the page handed it. */
export const stubMedia: {
  media: BrowserMediaState | null
  error: string | null
  play: ReturnType<typeof vi.fn<MediaFn>>
  pause: ReturnType<typeof vi.fn<MediaFn>>
  seek: ReturnType<typeof vi.fn<MediaFn>>
  setVolume: ReturnType<typeof vi.fn<MediaFn>>
  refresh: ReturnType<typeof vi.fn<MediaFn>>
  onEnded?: (media: BrowserMediaState) => void
  sessionKey?: string
  pollMs?: number
} = {
  media: null,
  error: null,
  play: vi.fn<MediaFn>(async () => undefined),
  pause: vi.fn<MediaFn>(async () => undefined),
  seek: vi.fn<MediaFn>(async () => undefined),
  setVolume: vi.fn<MediaFn>(async () => undefined),
  refresh: vi.fn<MediaFn>(async () => undefined),
}

export function resetStubMedia(): void {
  stubNavigate.mockReset()
  stubMedia.media = null
  stubMedia.error = null
  for (const k of ['play', 'pause', 'seek', 'setVolume', 'refresh'] as const) {
    stubMedia[k] = vi.fn<MediaFn>(async () => undefined)
  }
  stubMedia.onEnded = undefined
  stubMedia.sessionKey = undefined
  stubMedia.pollMs = undefined
}

const mediaListeners = new Set<() => void>()

/** Change what the tab reports, and repaint every page using the hook (a poll's answer). */
export function setStubMedia(media: BrowserMediaState | null): void {
  stubMedia.media = media
  for (const listener of mediaListeners) listener()
}

/** The host's level-10 hook, answering from `stubMedia`. A test of an older host mocks this module. */
export function useBrowserMedia(
  sessionKey: string,
  options: { pollMs?: number; onEnded?: (media: BrowserMediaState) => void } = {},
): BrowserMedia {
  const [, repaint] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    mediaListeners.add(repaint)
    return () => { mediaListeners.delete(repaint) }
  }, [])
  stubMedia.onEnded = options.onEnded
  stubMedia.sessionKey = sessionKey
  stubMedia.pollMs = options.pollMs
  return {
    media: stubMedia.media,
    error: stubMedia.error,
    busy: false,
    play: () => stubMedia.play(),
    pause: () => stubMedia.pause(),
    seek: (s: number) => stubMedia.seek(s),
    setVolume: (v: number) => stubMedia.setVolume(v),
    refresh: () => stubMedia.refresh(),
  }
}

/** Stands in for the host's native transcript: names the slot it was given. */
export function ChatEmbed({ slotKey }: { slotKey: string }) {
  return createElement('div', { 'data-testid': 'chat-embed', 'data-slot': slotKey })
}

/** Stands in for the host's live browser view: names the slot it was given. */
export function BrowserView({ slot, 'aria-label': label }: { slot: string; 'aria-label': string }) {
  return createElement('div', { 'data-testid': 'host-browser-view', 'data-slot': slot, 'aria-label': label })
}

const unstubbed = () => Promise.reject(new Error('stub app-sdk: no API in this test'))

export function useAppApi(): AppApi {
  return { request: unstubbed, get: unstubbed, post: unstubbed, put: unstubbed, del: unstubbed }
}

export function useChatLauncher(): { openChat: (opts?: ChatLaunchOptions) => void } {
  return { openChat: stubOpenChat }
}

export function useImeGuard() {
  return {
    bindEnter: ({ onEnter }: { onEnter?: () => void; onEscape?: () => void }) => ({
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter?.()
        }
      },
    }),
  }
}
