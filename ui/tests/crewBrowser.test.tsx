// The Crew Browser player against a mocked `../src/api` and the stub SDK's
// `useBrowserMedia` (`stubs/app-sdk.ts`): a play goes to the buddy and its steps are
// kept per site, the page's buttons reach the tab directly, a song's end wakes the
// buddy once (never after a pause or with continuous play off), a low queue asks
// for more, a failed play forgets the steps, and an older host, unapproved sites or
// a policy say so in the player's place, with the play button gone.
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
    settings: { explore: 'balanced', record_open: false, continuous: true, ...over },
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
  api.addMemory.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Crew Browser player', () => {
  it('is the only player: no choice, no embed, no link', async () => {
    await open()
    expect(screen.queryByTestId('mood-player-choice')).toBeNull()
    expect(screen.getByTestId('mood-browser-controls')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.queryByTestId('mood-bilibili-link')).toBeNull()
  })

  it('reads the tab of the buddy chat once, and polls it from the first play request on', async () => {
    await open()
    expect(stubMedia.sessionKey).toBe('dashboard:mood-music-buddy')
    expect(stubMedia.pollMs).toBe(0)
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    // Polled while the buddy opens it, so the song is seen even if its reply is not read.
    expect(stubMedia.pollMs).toBeGreaterThan(0)
    const asked = api.ask.mock.calls[0][0] as string
    api.getSlot.mockResolvedValue(replyTo(asked, { played: true, site: 'youtube', steps: ['x'] }))
    await flush(POLL_MS)
    await flush()
    expect(stubMedia.pollMs).toBeGreaterThan(0)
  })

  it('play and pause go to the tab at once, never to the buddy, and a read in flight does not block them', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await act(async () => { setStubMedia(PLAYING) })
    const before = api.ask.mock.calls.length
    stubMedia.busy = true
    await act(async () => { setStubMedia({ ...PLAYING }) })
    const pause = screen.getByTestId('mood-browser-pause')
    expect(pause).not.toBeDisabled()
    fireEvent.click(pause)
    expect(stubMedia.pause).toHaveBeenCalledTimes(1)
    // The button shows the new state before the tab answers.
    expect(screen.getByTestId('mood-browser-status')).toHaveTextContent(t('browser.status_paused'))
    const play = screen.getByTestId('mood-browser-play')
    expect(play).not.toBeDisabled()
    fireEvent.click(play)
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mood-browser-status')).toHaveTextContent(t('browser.status_playing'))
    await flush(POLL_MS)
    expect(api.ask.mock.calls.length).toBe(before)
  })

  it('reaches the song in the tab even when the buddy’s reply could not be read', async () => {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    const asked = api.ask.mock.calls[0][0] as string
    // The tab plays while the turn runs; the reply has no block the page can read.
    await act(async () => { setStubMedia(PLAYING) })
    api.getSlot.mockResolvedValue({ running: false, messages: [{ role: 'user', content: asked }, { role: 'assistant', content: 'Playing now.' }] })
    await flush(POLL_MS)
    await flush()
    expect(api.forgetPlaySteps).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    expect(stubMedia.pause).toHaveBeenCalledTimes(1)
    expect(asks()).toHaveLength(1)
  })

  it('plays an ended song again from the start in the tab, without the buddy', async () => {
    api.state.mockResolvedValue(state({ continuous: false }))
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await songEnds()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(stubMedia.seek).toHaveBeenCalledWith(0)
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
    expect(asks()).toHaveLength(1)
  })

  it('sends only "Find and play" to the buddy, when the tab has no song', async () => {
    await open()
    const find = screen.getByTestId('mood-browser-play')
    expect(find).toHaveTextContent(t('browser.find_play'))
    fireEvent.click(find)
    await flush()
    expect(asks()).toHaveLength(1)
    expect(stubMedia.play).not.toHaveBeenCalled()
  })

  it('opens the buddy chat on a first visit, so it can tell whether songs can play', async () => {
    api.state.mockResolvedValue(state({}, { last_source: '', moments: [], queue: [] }))
    await open()
    expect(api.openSlot).toHaveBeenCalled()
    expect(stubMedia.sessionKey).toBe('dashboard:mood-music-buddy')
  })

  it('marks a song the buddy started as heard', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    expect(api.addMemory).toHaveBeenCalledWith({ kind: 'known', title: 'Song 1', artist: 'Artist 1', origin: 'app' })
  })

  it('plays a pick with no link by searching its site', async () => {
    api.state.mockResolvedValue(state({}, { queue: [pick(1, { video_id: undefined })] }))
    await open()
    const asked = await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    expect(asked).toContain('Play in Crew Browser: "Song 1" - Artist 1')
    expect(asked).not.toContain('Checked link')
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

  it('says to approve the sites, with a button, and offers no play', async () => {
    stubMedia.error = 'not_app_browser'
    await open()
    const banner = screen.getByTestId('mood-browser-unready')
    expect(banner).toHaveTextContent(t('browser.unready_not_approved'))
    fireEvent.click(within(banner).getByRole('button', { name: t('browser.approve') }))
    expect(stubNavigate).toHaveBeenCalledWith('/apps/detail/mood-music')
    expect(screen.queryByTestId('mood-browser-controls')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(within(screen.getByTestId('mood-queue')).getByText('Song 3'))
    await flush()
    expect(api.ask).not.toHaveBeenCalled()
  })

  it('says to update Kiro Crew on a host too old for it, and offers no play', async () => {
    host.level = 9
    await open()
    const banner = screen.getByTestId('mood-browser-unready')
    expect(banner).toHaveTextContent(t('browser.unready_title'))
    expect(banner).toHaveTextContent(t('browser.unready_old_host'))
    expect(t('browser.unready_old_host')).toContain('#38333')
    expect(within(banner).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('mood-browser-controls')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(within(screen.getByTestId('mood-queue')).getByText('Song 3'))
    await flush()
    expect(api.ask).not.toHaveBeenCalled()
  })

  it('says so when a policy turns the browser off', async () => {
    stubMedia.error = 'policy_denied'
    await open()
    expect(screen.getByTestId('mood-browser-unready')).toHaveTextContent(t('browser.unready_browse_off'))
    expect(screen.queryByTestId('mood-browser-controls')).toBeNull()
  })

  it('shows the note before any song, so nobody waits on a mood first', async () => {
    host.level = 9
    api.state.mockResolvedValue(state({}, { queue: [] }))
    await open()
    expect(screen.getByTestId('mood-browser-unready')).toHaveTextContent(t('browser.unready_old_host'))
  })

  it('has continuous play on when the backend sends no choice, and keeps a turn-off', async () => {
    api.state.mockResolvedValue({ ...state(), settings: { explore: 'balanced', record_open: false } })
    await open()
    const toggle = screen.getByTestId('mood-continuous')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await songEnds()
    expect(asks()).toHaveLength(2)
    fireEvent.click(toggle)
    expect(api.setSettings).toHaveBeenCalledWith({ continuous: false })
    expect(screen.getByTestId('mood-continuous')).toHaveAttribute('aria-pressed', 'false')
  })

  it('says on the page that continuous play stops with the page closed', async () => {
    await open()
    expect(screen.getByTestId('mood-continuous-note')).toHaveTextContent(t('browser.continuous_note'))
  })
})
