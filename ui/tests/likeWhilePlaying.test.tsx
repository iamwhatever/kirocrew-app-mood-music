// Like and skip work on the song that plays, while the buddy works (0.2.17).
// A song plays while the buddy's turn still runs (it starts the song, then
// looks for more), and Like / Skip were greyed out for that whole turn, so the
// playing song could never be liked. Now they always work, and a like still
// goes to the taste memory.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), steer: vi.fn(), cancelQueued: vi.fn(), approve: vi.fn(), stop: vi.fn(),
    setSettings: vi.fn(), setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
    playlistNext: vi.fn(),
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

function pick(n: number, feedback: QueuedPick['feedback'] = ''): QueuedPick {
  return { id: String(n).padStart(32, 'p'), title: `Song ${n}`, artist: `Artist ${n}`, why: `why ${n}`, tags: [], source: 'youtube', video_id: 'dQw4w9WgXcQ', feedback }
}
const OLD = [pick(1), pick(2), pick(3), pick(4), pick(5)]
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
const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }

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
/** Song 1 asked to play; the tab plays it while the buddy's turn still runs. */
async function playWhileBuddyWorks() {
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  history = [{ role: 'user', content: lastAsk() }]
  api.getSlot.mockResolvedValue({ running: true, messages: [...history, { role: 'tool', content: '🔧 browser', meta: { input: '{"op": "navigate"}' } }] })
  await flush(POLL_MS)
  await act(async () => { setStubMedia(PLAYING) })
  await flush()
}
const card = () => screen.getByTestId('mood-now-playing')
const likeButton = () => within(card()).getByRole('button', { name: t('page.like') })

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
  api.feedback.mockImplementation(async (id: string, verdict: QueuedPick['feedback']) => ({ ...OLD.find(p => p.id === id)!, feedback: verdict }))
  api.setSettings.mockResolvedValue({})
  api.setPlayback.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.addMemory.mockResolvedValue({})
  api.deleteMemory.mockResolvedValue({ deleted: 'x' })
  api.claimEnded.mockResolvedValue(true)
  api.playlistNext.mockResolvedValue({ active: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the playing song while the buddy works', () => {
  it('can be liked, and the like is saved', async () => {
    await open()
    await playWhileBuddyWorks()
    expect(within(card()).getByText('Song 1')).toBeInTheDocument()
    expect(likeButton()).not.toBeDisabled()
    api.state.mockResolvedValue(state([pick(1, 'liked'), ...OLD.slice(1)]))
    fireEvent.click(likeButton())
    await flush()
    expect(api.feedback).toHaveBeenCalledWith(OLD[0].id, 'liked')
    const liked = within(card()).getByRole('button', { name: t('page.liked') })
    expect(liked).toHaveAttribute('aria-pressed', 'true')
    // The play turn is not touched by a like.
    expect(asks()).toHaveLength(1)
    expect(api.steer).not.toHaveBeenCalled()
  })

  it('shows the like at once, before the backend answers', async () => {
    await open()
    await playWhileBuddyWorks()
    api.feedback.mockReturnValue(new Promise(() => undefined))
    fireEvent.click(likeButton())
    expect(within(card()).getByRole('button', { name: t('page.liked') })).toHaveAttribute('aria-pressed', 'true')
  })

  it('can be skipped: the next song is steered into the running turn', async () => {
    await open()
    await playWhileBuddyWorks()
    const skip = within(card()).getByRole('button', { name: t('page.skip') })
    expect(skip).not.toBeDisabled()
    fireEvent.click(skip)
    await flush()
    expect(api.feedback).toHaveBeenCalledWith(OLD[0].id, 'skipped')
    expect(api.steer).toHaveBeenCalledTimes(1)
    expect(api.steer.mock.calls[0][1]).toContain('"Song 2" - Artist 2')
    expect(within(card()).getByText('Song 2')).toBeInTheDocument()
  })

  it('puts the like back when it could not be saved', async () => {
    await open()
    await playWhileBuddyWorks()
    api.feedback.mockRejectedValue(new Error('offline'))
    fireEvent.click(likeButton())
    await flush()
    expect(api.feedback).toHaveBeenCalledWith(OLD[0].id, 'liked')
    expect(likeButton()).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('the old list’s song, still playing after a new list', () => {
  /** The newest request is answered with *data*, and its turn is over. */
  async function answer(data: unknown) {
    history = [...(history ?? []), { role: 'user', content: lastAsk() }, { role: 'assistant', content: block(data) }]
    api.getSlot.mockResolvedValue({ running: false, messages: history })
    await flush(POLL_MS)
    await flush()
  }
  async function newListWhilePlaying() {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    await answer({ played: true, site: 'youtube', steps: ['x'] })
    await act(async () => { setStubMedia(PLAYING) })
    await flush()
    // A new list while Song 1 plays: Song 1 stays, from the old list.
    api.setQueue.mockResolvedValue({ queue: NEW })
    api.state.mockResolvedValue(state(NEW, { playback: { pick_id: OLD[0].id, paused: false } as MoodState['playback'] }))
    fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: '换一批歌' } })
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    await answer({ mood_tags: ['安静'], picks: NEW.map(p => ({ title: p.title, artist: p.artist, source: 'youtube', video_id: p.video_id })) })
    expect(within(card()).getByTestId('mood-now-old-list')).toBeInTheDocument()
  }

  it('can be liked: the like goes straight to the taste memory', async () => {
    await newListWhilePlaying()
    fireEvent.click(likeButton())
    await flush()
    expect(api.feedback).not.toHaveBeenCalled()
    expect(api.addMemory).toHaveBeenCalledWith({ kind: 'liked', title: 'Song 1', artist: 'Artist 1', origin: 'app' })
    expect(within(card()).getByRole('button', { name: t('page.liked') })).toHaveAttribute('aria-pressed', 'true')
  })

  it('can be unliked: the app’s like is taken out of memory again', async () => {
    await newListWhilePlaying()
    const kept = { id: 'k'.repeat(32), kind: 'liked', title: 'Song 1', artist: 'Artist 1', origin: 'app' } as unknown as MoodState['memory'][number]
    api.state.mockResolvedValue(state(NEW, { memory: [kept], playback: { pick_id: OLD[0].id, paused: false } as MoodState['playback'] }))
    fireEvent.click(likeButton())
    await flush()
    fireEvent.click(within(card()).getByRole('button', { name: t('page.liked') }))
    await flush()
    expect(api.deleteMemory).toHaveBeenCalledWith(kept.id)
    expect(likeButton()).toHaveAttribute('aria-pressed', 'false')
  })
})
