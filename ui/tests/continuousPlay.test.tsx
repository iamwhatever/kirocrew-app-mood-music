// Continuous play edges (0.2.9): an ending heard while the buddy is busy is
// owed and woken once the turn is over; an ending no reading called `ended`
// (the source dropped at the end) still counts; telling the backend which song
// plays is tried again and said when it fails; playing on the site after a pause
// here clears that pause.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { PLAYBACK_TRIES, POLL_MS, RESUME_GRACE_MS } from '../src/MoodMusicPage'
import { endedBetween, stillEnded } from '../src/crewBrowser'
import { setStubMedia, stubMedia } from './stubs/app-sdk'

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
  api.setPlayback.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
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


async function say(words: string) {
  fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}
/** Answer the newest request with a question: a turn over with nothing to queue. */
async function answerQuestion() {
  api.getSlot.mockResolvedValue(replyTo(asks()[asks().length - 1], { question: '要中文的吗？' }))
  await flush(POLL_MS)
  await flush()
}
const media = async (m: BrowserMediaState | null) => { await act(async () => { setStubMedia(m) }); await flush() }
const NEAR_END: BrowserMediaState = { ...PLAYING, currentTime: 199, duration: 200 }
const SOURCE_GONE: BrowserMediaState = { ...PLAYING, paused: true, currentTime: 0, duration: null }

describe('an ending while the buddy is busy', () => {
  it('is owed, and wakes the buddy once that turn is over', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await say('想听点安静的')
    expect(asks()).toHaveLength(2)
    await songEnds()
    expect(asks()).toHaveLength(2)
    await answerQuestion()
    expect(asks()).toHaveLength(3)
    expect(asks()[2]).toContain('Play in Crew Browser: "Song 2" - Artist 2')
    expect(asks()[2]).toContain('just ended')
  })

  it('wakes nobody when the song is no longer over by then', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await say('想听点安静的')
    await songEnds()
    // The person played it again meanwhile.
    await media({ ...PLAYING, currentTime: 3 })
    await answerQuestion()
    expect(asks()).toHaveLength(2)
  })
})

describe('an ending no reading called ended', () => {
  it('counts when the reading near the end is followed by a lost source', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await media(NEAR_END)
    await media(SOURCE_GONE)
    expect(asks()).toHaveLength(2)
    expect(asks()[1]).toContain('Play in Crew Browser: "Song 2" - Artist 2')
  })

  it('does not count a lost source in the middle of a song', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await media(PLAYING)
    await media(SOURCE_GONE)
    expect(asks()).toHaveLength(1)
  })

  it('reads the two readings as the diagnosis saw them', () => {
    expect(endedBetween(NEAR_END, SOURCE_GONE)).toBe(true)
    expect(endedBetween(NEAR_END, { ...NEAR_END, currentTime: 0, paused: true })).toBe(true)
    // Replayed from the start and playing: not an ending.
    expect(endedBetween(NEAR_END, { ...NEAR_END, currentTime: 0, paused: false })).toBe(false)
    expect(endedBetween({ ...NEAR_END, currentTime: 197 }, SOURCE_GONE)).toBe(false)
    expect(endedBetween(null, SOURCE_GONE)).toBe(false)
    expect(endedBetween({ ...NEAR_END, duration: null }, SOURCE_GONE)).toBe(false)
    expect(stillEnded(ENDED)).toBe(true)
    expect(stillEnded(SOURCE_GONE)).toBe(true)
    expect(stillEnded(PLAYING)).toBe(false)
    expect(stillEnded(null)).toBe(false)
  })
})

describe('telling the backend which song plays', () => {
  it('tries again, and says so on the page when it keeps failing', async () => {
    api.setPlayback.mockRejectedValue(new Error('offline'))
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await flush(POLL_MS * 10)
    const calls = api.setPlayback.mock.calls.filter(c => (c[0] as { pick_id?: string }).pick_id === pick(1).id)
    expect(calls).toHaveLength(PLAYBACK_TRIES)
    expect(screen.getByText(t('browser.playback_unsaved'))).toBeInTheDocument()
  })

  it('says nothing when a second try lands', async () => {
    api.setPlayback.mockRejectedValueOnce(new Error('offline'))
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await flush(POLL_MS * 10)
    expect(api.setPlayback.mock.calls.filter(c => (c[0] as { pick_id?: string }).pick_id === pick(1).id)).toHaveLength(2)
    expect(screen.queryByText(t('browser.playback_unsaved'))).toBeNull()
  })
})

describe('playing on the site after a pause here', () => {
  it('clears the pause, so the next ending wakes the buddy again', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await media(PLAYING)
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    expect(api.setPlayback).toHaveBeenCalledWith({ paused: true })
    await flush(RESUME_GRACE_MS + 100)
    // The person presses play on YouTube itself: the tab reads playing again.
    await media({ ...PLAYING, currentTime: 60 })
    expect(api.setPlayback).toHaveBeenLastCalledWith({ paused: false })
    await songEnds()
    expect(asks()).toHaveLength(2)
  })

  it('keeps the pause while a reading may still predate it', async () => {
    await open()
    await playAndAnswer({ played: true, site: 'youtube', steps: ['x'] })
    await media(PLAYING)
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    await media({ ...PLAYING, currentTime: 43 })
    expect(api.setPlayback).not.toHaveBeenCalledWith({ paused: false })
    await songEnds()
    expect(asks()).toHaveLength(1)
  })

  it('clears a pause the backend kept from before the page opened', async () => {
    api.state.mockResolvedValue(state({}, { playback: { pick_id: pick(1).id, ended_for: '', paused: true } }))
    await open()
    await media({ ...PLAYING, currentTime: 60 })
    expect(api.setPlayback).toHaveBeenCalledWith({ paused: false })
  })
})
