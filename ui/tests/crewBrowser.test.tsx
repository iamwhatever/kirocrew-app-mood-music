// The Crew Browser player against a mocked `../src/api` and the stub SDK's
// `useBrowserMedia` (`stubs/app-sdk.ts`): a play goes to the buddy and its steps are
// kept per site, the page's buttons reach the tab directly, a song's end wakes the
// buddy once (never after a pause or with continuous play off), a low queue asks
// for more, a failed play forgets the steps, and an older host or unapproved sites
// fall back to the embed with a note and an approve button.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'

// The host level, read live through a getter so one file covers old and new hosts.
const host = vi.hoisted(() => ({ level: 10 }))
vi.mock('@kirocrew/app-sdk', async orig => {
  const real = await orig<typeof import('./stubs/app-sdk')>()
  return {
    ...real,
    get APP_SDK_LEVEL() { return host.level },
  }
})

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), approve: vi.fn(), stop: vi.fn(), setSettings: vi.fn(),
    setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import { setStubMedia, stubMedia, stubNavigate } from './stubs/app-sdk'

const api = mock.api
const ID = 'dQw4w9WgXcQ'

function pick(n: number, over: Partial<QueuedPick> = {}): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', video_id: ID, feedback: '', ...over }
}

const QUEUE = [pick(1), pick(2, { source: 'bilibili', video_id: undefined, url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), pick(3), pick(4)]

function state(over: Partial<MoodState['settings']> = {}, extra: Partial<MoodState> = {}): MoodState {
  return {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: ['平静', '温柔'], songs: [], at: 1 }],
    queue: QUEUE, feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, player: 'browser', continuous: true, ...over },
    ...extra,
  }
}

const block = (data: unknown) => '好，放上了。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const replyTo = (asked: string, data: unknown): SlotData => ({
  running: false,
  messages: [{ role: 'user', content: asked }, { role: 'assistant', content: block(data) }],
})

const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }
const ENDED: BrowserMediaState = { ...PLAYING, ended: true, currentTime: 200 }

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Render with the tab ready (no tab yet: an approved session), and wait for the slot. */
async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}

/** Press play on the Crew Browser controls and answer the buddy's turn. */
async function playAndAnswer(data: unknown) {
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  const asked = api.ask.mock.calls[api.ask.mock.calls.length - 1][0] as string
  api.getSlot.mockResolvedValue(replyTo(asked, data))
  await flush(POLL_MS)
  await flush()
  return asked
}

const asks = () => api.ask.mock.calls.map(c => c[0] as string)

/** The song in the tab ended, as the host's hook reports it (once per ending). */
async function songEnds() {
  await act(async () => { setStubMedia(ENDED); stubMedia.onEnded?.(ENDED) })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  host.level = 10
  stubMedia.error = 'no_tab'
  api.state.mockResolvedValue(state())
  api.openSlot.mockResolvedValue({ key: 'dashboard:mood-music-buddy' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue('dashboard:mood-music-buddy')
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: [] })
  api.setSettings.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.markUsed.mockResolvedValue({ marked: 0 })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Crew Browser player', () => {
  it('is a player choice next to auto, YouTube and bilibili', async () => {
    api.state.mockResolvedValue(state({ player: 'auto' }))
    await open()
    const choice = screen.getByTestId('mood-player-choice')
    fireEvent.click(within(choice).getByRole('tab', { name: t('chat.player_browser') }))
    expect(api.setSettings).toHaveBeenCalledWith({ player: 'browser' })
  })

  it('polls the tab of the buddy chat while it is the player', async () => {
    await open()
    expect(stubMedia.sessionKey).toBe('dashboard:mood-music-buddy')
    expect(stubMedia.pollMs).toBeGreaterThan(0)
  })

  it('asks the buddy to play with the saved steps, and keeps the steps that worked', async () => {
    api.state.mockResolvedValue(state({}, { play_steps: { youtube: { steps: ['open the results page', 'click the first video'], updated_at: 1 } } }))
    await open()
    const asked = await playAndAnswer({ played: true, site: 'youtube', steps: ['open the results page for the song', 'click the matching video'] })
    expect(asked).toContain('Play in Crew Browser: "Song 1" - Artist 1')
    expect(asked).toContain('Site: youtube')
    expect(asked).toContain('1. open the results page\n2. click the first video')
    expect(asked).toContain(`https://www.youtube.com/watch?v=${ID}`)
    expect(asked).not.toContain('nearly empty')
    expect(api.setPlaySteps).toHaveBeenCalledWith('youtube', ['open the results page for the song', 'click the matching video'])
    expect(api.forgetPlaySteps).not.toHaveBeenCalled()
  })

  it('pause, seek and volume go to the tab, not the buddy', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await act(async () => { setStubMedia(PLAYING) })
    expect(screen.getByTestId('mood-browser-status')).toHaveTextContent(t('browser.status_playing'))
    const before = api.ask.mock.calls.length
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    expect(stubMedia.pause).toHaveBeenCalledTimes(1)
    const seek = screen.getByTestId('mood-browser-seek')
    fireEvent.change(seek, { target: { value: '120' } })
    fireEvent.pointerUp(seek)
    expect(stubMedia.seek).toHaveBeenCalledWith(120)
    const volume = screen.getByTestId('mood-browser-volume')
    fireEvent.change(volume, { target: { value: '0.3' } })
    fireEvent.keyUp(volume)
    expect(stubMedia.setVolume).toHaveBeenCalledWith(0.3)
    expect(api.ask.mock.calls.length).toBe(before)
  })

  it('wakes the buddy once when a song ends, for the next song', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await songEnds()
    expect(asks()).toHaveLength(2)
    expect(asks()[1]).toContain('Play in Crew Browser: "Song 2" - Artist 2')
    expect(asks()[1]).toContain('just ended')
    expect(asks()[1]).toContain('Site: bilibili')
    // The same ending reported again (a remount, a second poll) wakes nobody, even
    // once the turn it woke is over and the tab still shows that song ended.
    api.getSlot.mockResolvedValue(replyTo(asks()[1], { played: false, site: 'bilibili', reason: 'busy' }))
    await flush(POLL_MS)
    await flush()
    await songEnds()
    await act(async () => { stubMedia.onEnded?.(ENDED) })
    await flush(POLL_MS)
    expect(asks()).toHaveLength(2)
  })

  it('a page opened again does not wake the buddy for an ending it already woke it for', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await songEnds()
    expect(asks()).toHaveLength(2)
    api.getSlot.mockResolvedValue(replyTo(asks()[1], { played: false, site: 'bilibili', reason: 'busy' }))
    await flush(POLL_MS)
    await flush()
    cleanup()
    // The host's hook reports an ending once more on mount; the saved view says it was handled.
    await open()
    await songEnds()
    expect(asks()).toHaveLength(2)
  })

  it('does not wake the buddy after the person pressed pause', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await act(async () => { setStubMedia(PLAYING) })
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    await songEnds()
    expect(asks()).toHaveLength(1)
  })

  it('does not wake the buddy with continuous play off', async () => {
    api.state.mockResolvedValue(state({ continuous: false }))
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await songEnds()
    expect(asks()).toHaveLength(1)
    fireEvent.click(screen.getByTestId('mood-continuous'))
    expect(api.setSettings).toHaveBeenCalledWith({ continuous: true })
  })

  it('turning continuous play off stops the next wake', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    fireEvent.click(screen.getByTestId('mood-continuous'))
    expect(api.setSettings).toHaveBeenCalledWith({ continuous: false })
    await flush()
    await songEnds()
    expect(asks()).toHaveLength(1)
  })

  it('asks for more songs when the queue is nearly empty, and adds them after it', async () => {
    api.state.mockResolvedValue(state({}, { queue: [QUEUE[0], QUEUE[1]] }))
    await open()
    const first = await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    // Only one song is left after the first: the play request already asks for more.
    expect(first).toContain('nearly empty')
    expect(first).toContain('Mood so far: 平静; 温柔')
    expect(first).toContain('Explore level: balanced (1 anchor, 4 explore, 0 deep)')
    expect(first).toContain('Already in the queue, do not pick again: "Song 1" - Artist 1; "Song 2" - Artist 2')
    expect(first).toContain('"picks"')
    expect(api.setQueue).not.toHaveBeenCalled()

    await songEnds()
    const second = asks()[1]
    expect(second).toContain('nearly empty')
    api.getSlot.mockResolvedValue(replyTo(second, {
      played: true, site: 'bilibili', steps: ['open the search page'], mood_tags: ['平静'],
      picks: [{ title: 'Fresh', artist: 'New', source: 'youtube', url: `https://youtu.be/${ID}`, tier: 'explore', evidence: { url: 'https://example.com/r', label: 'A review' } }],
    }))
    await flush(POLL_MS)
    await flush()
    expect(api.verifyPicks).toHaveBeenCalledTimes(1)
    expect(api.setQueue).toHaveBeenCalledWith(expect.objectContaining({ append: true, picks: [expect.objectContaining({ title: 'Fresh' })] }))
    expect(api.setPlaySteps).toHaveBeenLastCalledWith('bilibili', ['open the search page'])
  })

  it('forgets the steps of a play that failed, so the next play finds the way again', async () => {
    api.state.mockResolvedValue(state({}, { play_steps: { youtube: { steps: ['old way'], updated_at: 1 } } }))
    await open()
    // What the backend answers once the failed steps are forgotten.
    api.state.mockResolvedValue(state())
    await playAndAnswer({ played: false, site: 'youtube', reason: 'the search box moved' })
    expect(api.forgetPlaySteps).toHaveBeenCalledWith('youtube')
    expect(api.setPlaySteps).not.toHaveBeenCalled()
    expect(screen.getByText(t('browser.not_played', { reason: 'the search box moved' }))).toBeInTheDocument()

    api.getSlot.mockResolvedValue({ running: false, messages: [] })
    await flush()
    const relearn = await playAndAnswer({ played: true, site: 'youtube', steps: ['new way'] })
    expect(relearn).toContain('No saved steps for youtube yet')
    expect(api.setPlaySteps).toHaveBeenCalledWith('youtube', ['new way'])
  })

  it('falls back to the embed with an approve button when the sites are not approved', async () => {
    stubMedia.error = 'not_app_browser'
    await open()
    const banner = screen.getByTestId('mood-browser-fallback')
    expect(banner).toHaveTextContent(t('browser.fallback_not_approved'))
    fireEvent.click(within(banner).getByRole('button', { name: t('browser.approve') }))
    expect(stubNavigate).toHaveBeenCalledWith('/apps/detail/mood-music')
    expect(screen.queryByTestId('mood-browser-controls')).toBeNull()
    expect(screen.getByTestId('mood-youtube-frame')).toBeInTheDocument()
  })

  it('falls back to the embed with a note on a Kiro Crew too old for it', async () => {
    host.level = 9
    await open()
    const banner = screen.getByTestId('mood-browser-fallback')
    expect(banner).toHaveTextContent(t('browser.fallback_old_host'))
    expect(within(banner).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('mood-browser-controls')).toBeNull()
    expect(screen.getByTestId('mood-youtube-frame')).toBeInTheDocument()
    // Pressing a song plays it in the page, as before: the buddy is not asked.
    fireEvent.click(within(screen.getByTestId('mood-queue')).getByText('Song 3'))
    await flush()
    expect(api.ask).not.toHaveBeenCalled()
  })

  it('says on the page that continuous play stops with the page closed', async () => {
    await open()
    expect(screen.getByTestId('mood-continuous-note')).toHaveTextContent(t('browser.continuous_note'))
  })
})
