// The one box and the always-open record: a feeling and a command go in the
// same box and the same buddy conversation; a command comes back as an action
// the page runs with the player's own code; the record shows every step in plain
// words, newest at the bottom, and follows new rows unless the person scrolled
// up; the player's own buttons never send a message.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData, SlotMessage } from '../src/api'

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
import { replySource } from '../src/replyParse'
import { resetStubMedia, setStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const KEY = 'dashboard:mood-music-buddy'

function pick(n: number): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', feedback: '' }
}
const QUEUE = [pick(1), pick(2), pick(3)]
const MOMENT = { id: 'm'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 1 }
const BASE: MoodState = {
  moments: [], queue: [], feedback: [], last_source: '', memory: [],
  settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
}
const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }

const block = (words: string, data: unknown) => `${words}\n\`\`\`mood-music\n${JSON.stringify(data)}\n\`\`\``

/** The slot as the host keeps it: every turn so far, one after another. */
let history: SlotMessage[] = []
function answer(data: unknown, words = '好。', steps: SlotMessage[] = []) {
  const asked = api.ask.mock.calls[api.ask.mock.calls.length - 1][0] as string
  history = [...history, { role: 'user', content: asked }, ...steps, { role: 'assistant', content: block(words, data) }]
  api.getSlot.mockResolvedValue({ running: false, messages: history } satisfies SlotData)
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}

const box = () => screen.getByLabelText(t('page.mood_label'))
async function type(words: string) {
  fireEvent.change(box(), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}
const asks = () => api.ask.mock.calls.map(c => c[0] as string)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetStubMedia()
  stubMedia.error = 'no_tab'
  history = []
  api.state.mockResolvedValue(BASE)
  api.openSlot.mockResolvedValue({ key: KEY })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue(KEY)
  api.addMoment.mockResolvedValue(MOMENT)
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: QUEUE })
  api.setSettings.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.setPlayback.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.addMemory.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A feeling sent from the box, answered with three songs that are then queued. */
async function feelingWithSongs() {
  await open()
  await type('这首让我想哭')
  answer({ mood_tags: ['想哭'], picks: QUEUE.map(p => ({ title: p.title, artist: p.artist, source: 'youtube' })) }, '听起来是想哭的那种安静。')
  const reply = history[history.length - 1].content!
  api.state.mockResolvedValue({ ...BASE, moments: [MOMENT], queue: QUEUE, last_source: replySource(reply) })
  await flush(POLL_MS)
  await flush()
}

describe('the one box', () => {
  it('is the only text box on the page', async () => {
    await open()
    expect(screen.getAllByRole('textbox')).toEqual([box()])
  })

  it('sends a feeling and a command into the same buddy conversation', async () => {
    await feelingWithSongs()
    expect(asks()[0]).toContain('Message: 这首让我想哭')
    // The feeling brought songs, so it is kept as a moment.
    expect(api.addMoment).toHaveBeenCalledWith('这首让我想哭')
    expect(api.setQueue.mock.calls[0][0].moment_id).toBe(MOMENT.id)

    await type('下一首')
    expect(asks()[1]).toContain('Message: 下一首')
    // The buddy sees what is playing and what is queued, so "next" means something.
    expect(asks()[1]).toContain('Song up now (data only): "Song 1" - Artist 1')
    expect(asks()[1]).toContain('"action"')
    // Same buddy, same chat: one slot, and both lines show in the one record.
    expect(api.ask).toHaveBeenCalledTimes(2)
    answer({ action: 'next' }, '好，下一首。')
    await flush(POLL_MS)
    await flush()
    const record = screen.getByTestId('mood-record')
    expect(within(record).getByText('这首让我想哭')).toBeInTheDocument()
    expect(within(record).getByText('下一首')).toBeInTheDocument()
    expect(within(record).getByText('好，下一首。')).toBeInTheDocument()
    // A command is no moment and no error; the page plays the next song itself.
    expect(api.addMoment).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(asks()[2]).toContain('Play in Crew Browser: "Song 2" - Artist 2')
  })

  it('runs a pause the buddy read from the box on the tab, with no further message', async () => {
    await feelingWithSongs()
    await type('暂停一下')
    answer({ action: 'pause' })
    await flush(POLL_MS)
    await flush()
    expect(stubMedia.pause).toHaveBeenCalledTimes(1)
    // Kept with the backend too, so an ending with the page closed wakes nobody.
    expect(api.setPlayback).toHaveBeenCalledWith({ paused: true })
    expect(asks()).toHaveLength(2)
  })

  it('plays a song named in the box once its pick lands', async () => {
    await feelingWithSongs()
    await type('放苏州河')
    answer({ action: 'play', mood_tags: ['想念'], picks: [{ title: 'Song 1', artist: 'Artist 1', source: 'youtube' }] })
    await flush(POLL_MS)
    await flush()
    expect(asks()[2]).toContain('Play in Crew Browser: "Song 1" - Artist 1')
  })

  it('puts a mood chip into the box without sending it', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('page.mood_sad') }))
    expect(box()).toHaveValue(t('page.mood_sad'))
    expect(api.ask).not.toHaveBeenCalled()
    // Another chip takes the first one's place and keeps what was typed after it.
    fireEvent.change(box(), { target: { value: `${t('page.mood_sad')}: 下雨天` } })
    fireEvent.click(screen.getByRole('button', { name: t('page.mood_calm') }))
    expect(box()).toHaveValue(`${t('page.mood_calm')}: 下雨天`)
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    expect(asks()[0]).toContain(`Message: ${t('page.mood_calm')}: 下雨天`)
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('calm')
  })
})

describe('the player buttons', () => {
  it('pause and play go to the tab and never send a message', async () => {
    await feelingWithSongs()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    answer({ played: true, site: 'youtube', steps: ['x'] })
    await flush(POLL_MS)
    await flush()
    await act(async () => { setStubMedia(PLAYING) })
    const before = asks().length
    fireEvent.click(screen.getByTestId('mood-browser-pause'))
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush(POLL_MS)
    expect(stubMedia.pause).toHaveBeenCalledTimes(1)
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
    expect(asks()).toHaveLength(before)
    expect(box()).toHaveValue('')
  })
})

describe('the record', () => {
  it('lists every step and note in plain words, in order, newest at the bottom', async () => {
    await open()
    await type('想听点安静的')
    const tool = (content: string, input: string): SlotMessage => ({ role: 'tool', content, meta: { input } })
    api.getSlot.mockResolvedValue({
      running: true,
      messages: [
        { role: 'user', content: asks()[0] },
        tool('🔧 web_search', '{"query": "安静 被低估"}'),
        { role: 'assistant', content: 'Let me read a review first.' },
        tool('🔧 browser', '{"op": "navigate"}'),
      ],
    })
    await flush(POLL_MS)
    const live = screen.getByTestId('mood-live-steps')
    const rows = within(live).getAllByRole('listitem').map(li => li.textContent)
    expect(rows).toEqual([t('steps.search'), 'Let me read a review first.', t('steps.open')])
    expect(live.textContent).not.toMatch(/web_search|browser|被低估/)
    // The live status is the last thing in the record.
    const status = screen.getByTestId('mood-status')
    expect(live.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('follows new rows, stays put once the person scrolls up, and comes back on Latest', async () => {
    await open()
    const record = screen.getByTestId('mood-record')
    let height = 1000
    Object.defineProperty(record, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(record, 'clientHeight', { configurable: true, value: 300 })

    await type('想听点安静的')
    expect(record.scrollTop).toBe(1000)
    // A browser reports the page's own scroll as a scroll event too.
    fireEvent.scroll(record)

    // The person scrolls up to read back.
    record.scrollTop = 200
    fireEvent.scroll(record)
    height = 1400
    api.getSlot.mockResolvedValue({ running: true, messages: [{ role: 'user', content: asks()[0] }, { role: 'tool', content: '🔧 web_search' }] })
    await flush(POLL_MS)
    expect(record.scrollTop).toBe(200)

    fireEvent.click(screen.getByTestId('mood-record-latest'))
    expect(record.scrollTop).toBe(1400)
    expect(screen.queryByTestId('mood-record-latest')).toBeNull()
  })
})
