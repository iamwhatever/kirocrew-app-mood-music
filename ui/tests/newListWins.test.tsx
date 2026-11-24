// The newest list the person asked for wins (0.2.19). The owner's report: a
// message that switched the list, then continuous play went on with the old
// list, and the new songs were pushed back out by the old list's refill.
//
// Two writers raced. (1) The person's turn ends: the page reads the new list
// and checks its links, several seconds, before it replaces the queue. A song
// ending in that window was claimed at once, on the OLD queue, so the old list's
// next song played. (2) That play's refill, asked on the old list, was then
// added after the new list. Now an ending in that window waits for the new list,
// and a refill names the list it was asked on (`based_on`), which the backend
// drops once the queue was replaced.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'

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

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import { setStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const ID = 'dQw4w9WgXcQ'

function pick(n: number): QueuedPick {
  return { id: String(n % 10).repeat(31) + String(Math.floor(n / 10)), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', video_id: ID, feedback: '' }
}

const OLD = [pick(1), pick(2), pick(3), pick(4)]
const NEW = [pick(11), pick(12), pick(13)]

function state(queue: QueuedPick[], gen: number): MoodState {
  return {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: ['平静'], songs: [], at: 1 }],
    queue, queue_gen: gen, feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, continuous: true },
  }
}

const block = (data: unknown) => '好。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const replyTo = (asked: string, data: unknown): SlotData => ({
  running: false,
  messages: [{ role: 'user', content: asked }, { role: 'assistant', content: block(data) }],
})

const ENDED: BrowserMediaState = { kind: 'video', paused: false, ended: true, currentTime: 200, duration: 200, volume: 0.8, muted: false }

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const asks = () => api.ask.mock.calls.map(c => c[0] as string)

async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}

async function answer(data: unknown) {
  api.getSlot.mockResolvedValue(replyTo(asks()[asks().length - 1], data))
  await flush(POLL_MS)
  await flush()
}

async function playFirst() {
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  await answer({ played: true, site: 'youtube', steps: ['x'] })
}

async function say(words: string) {
  fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}

async function songEnds() {
  await act(async () => { setStubMedia(ENDED); stubMedia.onEnded?.(ENDED) })
  await flush()
}

const NEW_LIST = { mood_tags: ['爵士'], picks: NEW.map(p => ({ title: p.title, artist: p.artist, source: 'youtube', video_id: ID })) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  host.level = 10
  stubMedia.error = 'no_tab'
  api.setPlayback.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
  api.state.mockResolvedValue(state(OLD, 3))
  api.openSlot.mockResolvedValue({ key: 'dashboard:mood-music-buddy' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue('dashboard:mood-music-buddy')
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  // A new list replaces the queue (and bumps queue_gen); a refill is answered as the backend does.
  api.setQueue.mockImplementation(async (body: { append?: boolean }) => {
    if (body.append) return { queue: [] }
    api.state.mockResolvedValue(state(NEW, 4))
    return { queue: NEW }
  })
  api.addMoment.mockResolvedValue({ id: 'n'.repeat(32) })
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

describe('a song ending while the new list is being checked', () => {
  it('waits for the new list, then plays its first song', async () => {
    await open()
    await playFirst()
    await say('换成爵士')
    expect(asks()).toHaveLength(2)
    // The page checks the new picks' links: hold that open.
    let release: () => void = () => undefined
    api.verifyPicks.mockImplementationOnce((picks: unknown[]) => new Promise(resolve => {
      release = () => resolve({ picks, dropped: {} })
    }))
    await answer(NEW_LIST)
    // The turn is over, the queue is still the old list, and Song 1 ends now.
    await songEnds()
    expect(asks()).toHaveLength(2)
    expect(api.claimEnded).not.toHaveBeenCalled()
    await act(async () => { release() })
    await flush()
    await flush()
    expect(api.claimEnded).toHaveBeenCalledTimes(1)
    expect(asks()).toHaveLength(3)
    expect(asks()[2]).toContain('Play in Crew Browser: "Song 11" - Artist 11')
    expect(asks().some(a => a.includes('Play in Crew Browser: "Song 2"'))).toBe(false)
  })
})

describe('a refill asked on a list', () => {
  it('names that list, so a newer one wins', async () => {
    api.state.mockResolvedValue(state(OLD.slice(0, 2), 7))
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(asks()[0]).toContain('nearly empty')
    await answer({ played: true, site: 'youtube', steps: ['x'], picks: [{ title: 'More', artist: 'A', source: 'youtube', video_id: ID }] })
    const refill = api.setQueue.mock.calls.map(c => c[0] as { append?: boolean; based_on?: number }).find(b => b.append)
    expect(refill?.based_on).toBe(7)
  })
})
