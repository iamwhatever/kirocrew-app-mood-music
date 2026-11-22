// The now-playing marker follows the song the tab really plays (0.2.12). A new
// list from the buddy while a song plays used to mark the new list's first pick
// as playing; now the song in the tab stays current, shown as from the previous
// list, no new pick is marked until it really starts, and its end moves on to
// the new list's first pick.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'
import { PAGE_KEY } from '../src/pageMemory'

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), steer: vi.fn(), cancelQueued: vi.fn(), approve: vi.fn(), stop: vi.fn(),
    setSettings: vi.fn(), setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import { resetStubMedia, setStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const KEY = 'dashboard:mood-music-buddy'

function pick(n: number): QueuedPick {
  return { id: String(n).padStart(32, 'p'), title: `Song ${n}`, artist: `Artist ${n}`, why: `why ${n}`, tags: [], source: 'youtube', video_id: 'dQw4w9WgXcQ', feedback: '' }
}
const OLD = [pick(1), pick(2), pick(3)]
const NEW = [pick(11), pick(12), pick(13)]

function state(queue: QueuedPick[], extra: Partial<MoodState> = {}): MoodState {
  return {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: [], songs: [], at: 1 }],
    queue, feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
    ...extra,
  }
}

const block = (data: unknown) => '好。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const newPicks = NEW.map(p => ({ title: p.title, artist: p.artist, source: 'youtube', video_id: p.video_id }))
const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }
const ENDED: BrowserMediaState = { ...PLAYING, ended: true, currentTime: 200 }

let history: SlotData['messages'] = []
const asks = () => api.ask.mock.calls.map(c => c[0] as string)
const lastAsk = () => asks()[asks().length - 1]

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}
async function type(words: string) {
  fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}
/** The newest request is answered with *data*, and its turn is over. */
async function answer(data: unknown, asked = lastAsk()) {
  history = [...(history ?? []), { role: 'user', content: asked }, { role: 'assistant', content: block(data) }]
  api.getSlot.mockResolvedValue({ running: false, messages: history })
  await flush(POLL_MS)
  await flush()
}
/** Song 1 asked to play from the Now Playing card, and the buddy says it plays. */
async function playSong1() {
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  await answer({ played: true, site: 'youtube', steps: ['x'] })
  await act(async () => { setStubMedia(PLAYING) })
  await flush()
}
/** The buddy is asked for a fresh list, and answers with NEW. */
async function refreshList() {
  api.setQueue.mockResolvedValue({ queue: NEW })
  api.state.mockResolvedValue(state(NEW, { playback: { pick_id: OLD[0].id, paused: false } as MoodState['playback'] }))
  await type('换一批歌')
  await answer({ mood_tags: ['安静'], picks: newPicks })
}
const card = () => screen.getByTestId('mood-now-playing')
const marked = () => screen.queryAllByTestId('mood-queue-row').filter(r => r.getAttribute('aria-current') === 'true')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetStubMedia()
  window.sessionStorage.clear()
  stubMedia.error = 'no_tab'
  history = []
  api.state.mockResolvedValue(state(OLD))
  api.openSlot.mockResolvedValue({ key: KEY })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue(KEY)
  api.steer.mockResolvedValue({ steered: true, queued: false, queueId: '' })
  api.addMoment.mockResolvedValue({ id: 'n'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 2 })
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: OLD })
  api.setSettings.mockResolvedValue({})
  api.setPlayback.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.addMemory.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a new list while a song plays', () => {
  it('keeps the song in the tab as now playing, and marks no new pick playing', async () => {
    await open()
    await playSong1()
    await refreshList()
    expect(within(card()).getByText('Song 1')).toBeInTheDocument()
    expect(within(card()).getByTestId('mood-now-old-list')).toHaveTextContent(t('page.from_old_list'))
    // It is in no queue now, so it cannot be liked here.
    expect(within(card()).queryByRole('button', { name: t('page.like') })).toBeNull()
    expect(screen.getAllByTestId('mood-queue-row').map(r => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Song 11')]),
    )
    expect(marked()).toHaveLength(0)
  })

  it('moves on to the new list’s first pick when the song ends', async () => {
    await open()
    await playSong1()
    await refreshList()
    const before = asks().length
    await act(async () => { setStubMedia(ENDED); stubMedia.onEnded?.(ENDED) })
    await flush()
    expect(api.claimEnded).toHaveBeenCalledWith(OLD[0].id)
    expect(asks()).toHaveLength(before + 1)
    expect(lastAsk()).toContain('"Song 11" - Artist 11')
    // Asked, not started: Song 11 is up, and is marked once it plays.
    await answer({ played: true, site: 'youtube', steps: ['x'] })
    await act(async () => { setStubMedia(PLAYING) })
    await flush()
    expect(within(card()).getByText('Song 11')).toBeInTheDocument()
    expect(within(card()).queryByTestId('mood-now-old-list')).toBeNull()
    expect(marked().map(r => r.textContent)).toEqual([expect.stringContaining('Song 11')])
  })

  it('shows the new list’s first pick once the old song is over', async () => {
    await open()
    await playSong1()
    await refreshList()
    await act(async () => { setStubMedia(ENDED) })
    await flush()
    expect(within(card()).getByText('Song 11')).toBeInTheDocument()
  })

  it('Skip on the old song plays the new list’s first pick', async () => {
    await open()
    await playSong1()
    await refreshList()
    fireEvent.click(within(card()).getByRole('button', { name: t('page.skip') }))
    await flush()
    expect(api.feedback).not.toHaveBeenCalled()
    expect(lastAsk()).toContain('"Song 11" - Artist 11')
  })

  it('makes the first pick current as before when nothing plays', async () => {
    await open()
    await refreshList()
    expect(within(card()).getByText('Song 11')).toBeInTheDocument()
    expect(within(card()).queryByTestId('mood-now-old-list')).toBeNull()
  })

  it('follows the song the backend started from the new list', async () => {
    await open()
    await playSong1()
    await refreshList()
    // The backend heard the ending first and woke the buddy for Song 11 (backend/playback.py next_pick).
    api.claimEnded.mockResolvedValue(false)
    const before = asks().length
    await act(async () => { setStubMedia(ENDED); stubMedia.onEnded?.(ENDED) })
    await flush()
    expect(asks()).toHaveLength(before)
    api.state.mockResolvedValue(state(NEW, { playback: { pick_id: NEW[0].id, paused: false } as MoodState['playback'] }))
    await act(async () => { setStubMedia(PLAYING) })
    await flush(POLL_MS)
    await flush()
    expect(within(card()).getByText('Song 11')).toBeInTheDocument()
    expect(within(card()).queryByTestId('mood-now-old-list')).toBeNull()
    expect(marked().map(r => r.textContent)).toEqual([expect.stringContaining('Song 11')])
  })
})

describe('words steered into a song’s turn that bring a new list', () => {
  it('keep the song that turn started as now playing', async () => {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    history = [{ role: 'user', content: lastAsk() }]
    api.getSlot.mockResolvedValue({ running: true, messages: [...history, { role: 'tool', content: '🔧 browser', meta: { input: '{"op": "navigate"}' } }] })
    await flush(POLL_MS)
    await type('换一批吉他的')
    const steered = api.steer.mock.calls[api.steer.mock.calls.length - 1][1] as string
    api.setQueue.mockResolvedValue({ queue: NEW })
    api.state.mockResolvedValue(state(NEW, { playback: { pick_id: OLD[0].id, paused: false } as MoodState['playback'] }))
    history = [...history, { role: 'user', content: steered, meta: { steer: true, steerState: 'consumed' } },
      { role: 'assistant', content: block({ played: true, site: 'youtube', steps: ['x'], mood_tags: ['吉他'], picks: newPicks }) }]
    api.getSlot.mockResolvedValue({ running: false, messages: history })
    await flush(POLL_MS)
    await flush()
    // The tab's first reading of Song 1 comes after the turn is over.
    await act(async () => { setStubMedia(PLAYING) })
    await flush()
    expect(api.setPlayback).toHaveBeenCalledWith({ pick_id: OLD[0].id })
    expect(within(card()).getByText('Song 1')).toBeInTheDocument()
    expect(within(card()).getByTestId('mood-now-old-list')).toBeInTheDocument()
    expect(marked()).toHaveLength(0)
  })
})

describe('a reload while the old list’s song plays', () => {
  it('shows that song again from the page memory, with no new pick marked', async () => {
    await open()
    await playSong1()
    await refreshList()
    const saved = JSON.parse(window.sessionStorage.getItem(PAGE_KEY) ?? '{}')
    expect(saved.held?.id).toBe(OLD[0].id)
    expect(saved.browserPick).toBe(OLD[0].id)
    cleanup()
    await open()
    expect(within(card()).getByText('Song 1')).toBeInTheDocument()
    expect(within(card()).getByTestId('mood-now-old-list')).toBeInTheDocument()
    expect(marked()).toHaveLength(0)
  })

  it('marks no new pick playing when this tab never saw the old song', async () => {
    window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({ tab: 'listen', browserPick: OLD[0].id, currentId: OLD[0].id }))
    stubMedia.error = null
    setStubMedia(PLAYING)
    api.state.mockResolvedValue(state(NEW, { playback: { pick_id: OLD[0].id, paused: false } as MoodState['playback'] }))
    await open()
    expect(marked()).toHaveLength(0)
    expect(screen.queryByTestId('mood-now-playing')).toBeNull()
  })
})
