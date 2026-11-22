// The buddy chat window (0.2.9): a song picked while the buddy works is steered
// into its running turn; a running turn shows its newest steps and a finished one
// folds them into one row; the Latest button marks a reply that landed while the
// person read back.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData, SlotMessage } from '../src/api'

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), steer: vi.fn(), approve: vi.fn(), stop: vi.fn(), setSettings: vi.fn(),
    setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import { LIVE_STEPS } from '../src/BuddySteps'
import { SWITCH_LINE } from '../src/request.prompt'
import { replySource } from '../src/replyParse'
import { resetStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const KEY = 'mood-music-dj'

function pick(n: number): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', feedback: '' }
}
const QUEUE = [pick(1), pick(2), pick(3), pick(4)]
const MOMENT = { id: 'm'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 1 }
const BASE: MoodState = {
  moments: [], queue: [], feedback: [], last_source: '', memory: [],
  settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
}

const block = (words: string, data: unknown) => `${words}\n\`\`\`mood-music\n${JSON.stringify(data)}\n\`\`\``

let history: SlotMessage[] = []
const lastAsk = () => api.ask.mock.calls[api.ask.mock.calls.length - 1][0] as string
/** The turn the page sent, still running, with *rows* so far. */
function working(rows: SlotMessage[] = []) {
  api.getSlot.mockResolvedValue({ running: true, messages: [...history, { role: 'user', content: lastAsk() }, ...rows] } satisfies SlotData)
}
/** A finished turn: *asked* (the page's last send by default), *rows*, then the reply. */
function answer(data: unknown, words = '好。', rows: SlotMessage[] = [], asked = lastAsk()) {
  history = [...history, { role: 'user', content: asked }, ...rows, { role: 'assistant', content: block(words, data) }]
  api.getSlot.mockResolvedValue({ running: false, messages: history } satisfies SlotData)
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function type(words: string) {
  fireEvent.change(screen.getByLabelText(t('page.mood_label')), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
  await flush()
}

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
  api.steer.mockResolvedValue({ steered: true, queued: false, queueId: '' })
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

/** A feeling answered with four songs, then Song 1 asked to play: that turn is running. */
async function playingFirst() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
  await type('想听点安静的')
  answer({ mood_tags: ['安静'], picks: QUEUE.map(p => ({ title: p.title, artist: p.artist, source: 'youtube' })) })
  api.state.mockResolvedValue({ ...BASE, moments: [MOMENT], queue: QUEUE, last_source: replySource(history[history.length - 1].content!) })
  await flush(POLL_MS)
  await flush()
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  expect(lastAsk()).toContain('Play in Crew Browser: "Song 1"')
  working([{ role: 'tool', content: '🔧 browser', meta: { input: '{"op": "navigate"}' } }])
  await flush(POLL_MS)
}
const row = (n: number) => screen.getAllByTestId('mood-queue-row')[n - 1]

describe('a song picked while the buddy works', () => {
  it('is steered into the running turn, and the turn becomes that song’s play', async () => {
    await playingFirst()
    const asked = api.ask.mock.calls.length
    fireEvent.click(row(3))
    await flush()
    expect(api.steer).toHaveBeenCalledTimes(1)
    const [key, message] = api.steer.mock.calls[0] as [string, string]
    expect(key).toBe(KEY)
    expect(message).toContain('Play in Crew Browser: "Song 3" - Artist 3')
    expect(message).toContain(SWITCH_LINE)
    // No new turn: the song goes into the one already running.
    expect(api.ask).toHaveBeenCalledTimes(asked)
    // The buddy answers for Song 3 in that turn; the page records Song 3 playing.
    answer({ played: true, site: 'youtube', steps: ['x'] }, '换好了。', [], message)
    await flush(POLL_MS)
    await flush()
    expect(api.setPlayback).toHaveBeenCalledWith({ pick_id: pick(3).id })
    expect(api.setPlayback).not.toHaveBeenCalledWith({ pick_id: pick(1).id })
  })

  it('waits on the queued turn when the gateway queued it instead', async () => {
    await playingFirst()
    api.steer.mockResolvedValue({ steered: false, queued: true, queueId: '' })
    fireEvent.click(row(2))
    await flush()
    const message = api.steer.mock.calls[0][1] as string
    // Song 1's turn ends first, then the queued Song 2 turn runs and answers.
    answer({ played: true, site: 'youtube', steps: ['x'] }, '放好了。')
    await flush(POLL_MS)
    await flush()
    expect(api.setPlayback).toHaveBeenLastCalledWith({ pick_id: pick(1).id })
    answer({ played: true, site: 'youtube', steps: ['x'] }, '换好了。', [], message)
    await flush(POLL_MS)
    await flush()
    expect(api.setPlayback).toHaveBeenLastCalledWith({ pick_id: pick(2).id })
    expect(api.ask).toHaveBeenCalledTimes(2)
  })

  it('starts a turn as before when the buddy is idle', async () => {
    await playingFirst()
    answer({ played: true, site: 'youtube', steps: ['x'] })
    await flush(POLL_MS)
    await flush()
    fireEvent.click(row(2))
    await flush()
    expect(api.steer).not.toHaveBeenCalled()
    expect(lastAsk()).toContain('Play in Crew Browser: "Song 2"')
  })
})

describe('the buddy’s steps', () => {
  const KINDS = ['navigate', 'click', 'type', 'snapshot', 'scroll', 'back', 'press_key'] as const
  const tools = KINDS.map(op => ({ role: 'tool', content: '🔧 browser', meta: { input: JSON.stringify({ op }) } }))
  const words = ['open', 'click', 'type', 'look', 'scroll', 'back', 'key'].map(k => t(`steps.${k}`))

  it('show the newest five while the turn runs, newest last, then fold into one row', async () => {
    render(<MoodMusicPage />)
    await flush()
    await type('想听点安静的')
    working(tools)
    await flush(POLL_MS)
    const live = screen.getByTestId('mood-live-steps')
    expect(within(live).getAllByRole('listitem').map(li => li.textContent)).toEqual(words.slice(-LIVE_STEPS))
    expect(LIVE_STEPS).toBe(5)
    expect(live.textContent).not.toMatch(/browser|navigate|press_key/)

    answer({ question: '要中文的吗？' }, '想问一下。', tools)
    await flush(POLL_MS)
    await flush()
    expect(screen.queryByTestId('mood-live-steps')).toBeNull()
    const done = screen.getByTestId('mood-steps')
    const fold = within(done).getByRole('button', { name: t('steps.folded', { count: KINDS.length }) })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(within(done).queryByRole('listitem')).toBeNull()
    fireEvent.click(fold)
    expect(within(done).getAllByRole('listitem').map(li => li.textContent)).toEqual(words)
    fireEvent.click(fold)
    expect(within(done).queryByRole('listitem')).toBeNull()
  })
})

describe('the Latest button', () => {
  async function scrolledUp() {
    render(<MoodMusicPage />)
    await flush()
    const record = screen.getByTestId('mood-record')
    let height = 1000
    Object.defineProperty(record, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(record, 'clientHeight', { configurable: true, value: 300 })
    await type('想听点安静的')
    // A browser reports the record's own follow-down as a scroll event too.
    fireEvent.scroll(record)
    return { record, grow: (h: number) => { height = h } }
  }

  it('marks a reply that lands while the person reads back, and goes to it on a click', async () => {
    const { record, grow } = await scrolledUp()
    working()
    await flush(POLL_MS)
    record.scrollTop = 200
    fireEvent.scroll(record)
    expect(screen.getByTestId('mood-record-latest')).toHaveTextContent(t('chat.latest'))
    expect(screen.queryByTestId('mood-record-unseen')).toBeNull()

    grow(1600)
    answer({ question: '要中文的吗？' }, '想问一下。')
    await flush(POLL_MS)
    await flush()
    const button = screen.getByTestId('mood-record-latest')
    expect(button).toHaveTextContent(t('chat.new_message'))
    expect(screen.getByTestId('mood-record-unseen')).toBeInTheDocument()
    expect(record.scrollTop).toBe(200)

    fireEvent.click(button)
    expect(record.scrollTop).toBe(1600)
    expect(screen.queryByTestId('mood-record-latest')).toBeNull()
  })

  it('stays hidden and follows new rows while the person is at the bottom', async () => {
    const { record, grow } = await scrolledUp()
    grow(1500)
    answer({ question: '要中文的吗？' }, '想问一下。')
    await flush(POLL_MS)
    await flush()
    expect(record.scrollTop).toBe(1500)
    expect(screen.queryByTestId('mood-record-latest')).toBeNull()
  })
})
