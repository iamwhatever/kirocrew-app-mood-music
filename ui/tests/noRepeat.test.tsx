// Follow-up songs repeated ones just heard (0.2.20). The owner's report: "有的时候
// 后续推荐的音乐会和刚刚听过的有重复". The check dropped a known song only as an
// explore pick, and a song still in the queue, or played from an earlier list,
// not at all. Now the backend's check drops any song played or queued lately
// (`dropped.recent`), and a refill left with too few new songs asks the buddy
// once for more in their place.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { stubMedia } from './stubs/app-sdk'

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
    played: [{ title: '晴天', artist: '周杰伦' }],
  }
}

const block = (data: unknown) => '好。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const replyTo = (asked: string, data: unknown): SlotData => ({
  running: false,
  messages: [{ role: 'user', content: asked }, { role: 'assistant', content: block(data) }],
})

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

async function say(words: string) {
  fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}

/** Songs the stand-in check drops: played lately (晴天) or still in the queue. */
const RECENT = ['晴天', 'Song 1', 'Song 2']
const song = (title: string) => ({ title, artist: 'A', source: 'bilibili' })

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
  // The backend's check, as a stand-in: a song played or queued lately is dropped.
  api.verifyPicks.mockImplementation(async (picks: { title: string }[], asked?: string) => {
    const kept = picks.filter(p => !RECENT.includes(p.title) || (asked ?? '').includes(p.title))
    return { picks: kept, dropped: kept.length < picks.length ? { recent: picks.length - kept.length } : {} }
  })
  api.setQueue.mockImplementation(async (body: { append?: boolean; picks: { title: string }[] }) => {
    if (body.append) return { queue: body.picks.map((p, i) => ({ ...pick(50 + i), ...p })) }
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


describe('a refill of songs heard lately', () => {
  beforeEach(() => { api.state.mockResolvedValue(state(OLD.slice(0, 2), 7)) })

  it('names the songs played lately in the request', async () => {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(asks()[0]).toContain('nearly empty')
    expect(asks()[0]).toContain('Played lately, do not pick again: "晴天" - 周杰伦')
  })

  it('asks once for songs in place of the repeats, and adds what is new', async () => {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    await answer({ played: true, site: 'youtube', steps: ['x'], picks: [song('晴天'), song('Song 2'), song('Only New')] })
    const appended = () => api.setQueue.mock.calls.map(c => c[0] as { append?: boolean; based_on?: number; picks: { title: string }[] })
      .filter(b => b.append)
    expect(appended().map(b => b.picks.map(p => p.title))).toEqual([['Only New']])
    expect(asks()).toHaveLength(2)
    expect(asks()[1].startsWith('[Mood Music]\nMore songs: 3 in place of songs played lately')).toBe(true)
    expect(asks()[1]).toContain('Played lately, do not pick again: "晴天" - 周杰伦')
    // Its answer still holds a repeat: dropped too, the rest added, and nobody is asked again.
    await answer({ mood_tags: ['平静'], picks: [song('Second New'), song('晴天')] })
    expect(appended().map(b => b.picks.map(p => p.title))).toEqual([['Only New'], ['Second New']])
    expect(appended()[1].based_on).toBe(7)
    await flush(POLL_MS * 3)
    expect(asks()).toHaveLength(2)
  })

  it('asks nobody again when enough new songs are left', async () => {
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    await answer({ played: true, site: 'youtube', steps: ['x'], picks: [song('晴天'), song('New A'), song('New B')] })
    await flush(POLL_MS * 3)
    expect(asks()).toHaveLength(1)
  })
})

describe('a new list the person asked for', () => {
  it('drops songs heard lately, says so, and lets through a song they named', async () => {
    await open()
    await say('再放一次晴天，再来点别的')
    await answer({ mood_tags: ['平静'], picks: [song('晴天'), song('Song 1'), song('Fresh')] })
    expect(api.verifyPicks.mock.calls[0][1]).toBe('再放一次晴天，再来点别的')
    const list = api.setQueue.mock.calls.map(c => c[0] as { picks: { title: string }[] })[0]
    expect(list.picks.map(p => p.title)).toEqual(['晴天', 'Fresh'])
    expect(screen.getByText(t('page.dropped_recent', { count: 1 }))).toBeTruthy()
  })

  it('says all were heard lately when nothing new is left', async () => {
    await open()
    await say('安静一点')
    await answer({ mood_tags: ['平静'], picks: [song('晴天'), song('Song 1')] })
    expect(api.setQueue).not.toHaveBeenCalled()
    expect(screen.getByText(t('chat.all_recent', { count: 2 }))).toBeTruthy()
  })
})
