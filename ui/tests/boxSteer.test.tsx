// The box while the buddy works (0.2.10): words sent during a turn are steered
// into it and marked as cut in; words the turn did not take are never queued:
// taken back with a plain note and left in the box, or, the turn having just
// ended, sent as a normal message. The reply is read like any box message.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData, SlotMessage } from '../src/api'

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
import { replySource } from '../src/replyParse'
import { conversation, steerRequeued } from '../src/turnState'
import { resetStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const KEY = 'mood-music-dj'

function pick(n: number): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', feedback: '' }
}
const QUEUE = [pick(1), pick(2), pick(3)]
const MOMENT = { id: 'm'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 1 }
const MEMORY = [{ id: 'n'.repeat(32), kind: 'note' as const, origin: 'user' as const, pinned: false, stale: false, created_at: 1, last_used_at: 1, text: '喜欢民谣' }]
const BASE: MoodState = {
  moments: [], queue: [], feedback: [], last_source: '', memory: MEMORY,
  settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
}
const SCENE = { hues: [20, 40], saturation: 'medium', lightness: 'medium', strength: 0.5, motion: 'slow', pattern: 'waves', arc: 'stay' }

const block = (words: string, data: unknown) => `${words}\n\`\`\`mood-music\n${JSON.stringify(data)}\n\`\`\``
const steerRow = (content: string, steerState = 'consumed'): SlotMessage => ({ role: 'user', content, meta: { steer: true, steerState } })

let history: SlotMessage[] = []
const lastAsk = () => api.ask.mock.calls[api.ask.mock.calls.length - 1][0] as string
const lastSteer = () => api.steer.mock.calls[api.steer.mock.calls.length - 1][1] as string
const slot = (running: boolean, rows: SlotMessage[] = []) =>
  api.getSlot.mockResolvedValue({ running, messages: [...history, ...rows] } satisfies SlotData)

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const box = () => screen.getByLabelText(t('page.mood_label')) as HTMLInputElement
const sendButton = () => screen.getByRole('button', { name: t('chat.send') })
async function type(words: string) {
  fireEvent.change(box(), { target: { value: words } })
  fireEvent.click(sendButton())
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
  api.cancelQueued.mockResolvedValue(true)
  api.addMoment.mockResolvedValue(MOMENT)
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: QUEUE })
  api.setSettings.mockResolvedValue({})
  api.setPlayback.mockResolvedValue({})
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.addMemory.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.claimEnded.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A feeling sent; its turn is running with one step. */
async function busyWithFeeling() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
  await type('想听点安静的')
  history = [{ role: 'user', content: lastAsk() }]
  slot(true, [{ role: 'tool', content: '🔧 web_search' }])
  await flush(POLL_MS)
  expect(screen.getByTestId('mood-status')).toBeInTheDocument()
}

const picks = [{ title: 'Song 1', artist: 'Artist 1', source: 'youtube' }, { title: 'Song 2', artist: 'Artist 2', source: 'youtube' }]

describe('the box while the buddy works', () => {
  it('stays usable, and its words are steered into the running turn', async () => {
    await busyWithFeeling()
    expect(box()).not.toBeDisabled()
    fireEvent.change(box(), { target: { value: '要有吉他的' } })
    expect(sendButton()).not.toBeDisabled()
    // Stop is still there beside it.
    expect(screen.getByRole('button', { name: t('chat.stop') })).toBeInTheDocument()
    fireEvent.click(sendButton())
    await flush()
    expect(api.steer).toHaveBeenCalledTimes(1)
    expect(api.steer.mock.calls[0][0]).toBe(KEY)
    expect(lastSteer()).toContain('Message: 要有吉他的')
    // No second turn, nothing queued, the box is cleared.
    expect(api.ask).toHaveBeenCalledTimes(1)
    expect(api.cancelQueued).not.toHaveBeenCalled()
    expect(box().value).toBe('')
    // Shown at once with the cut-in mark, and again once the slot has the row.
    expect(screen.getByTestId('mood-steered')).toHaveTextContent(t('chat.steered'))
    slot(true, [{ role: 'tool', content: '🔧 web_search' }, steerRow(lastSteer())])
    await flush(POLL_MS)
    const marked = screen.getAllByTestId('mood-steered')
    expect(marked).toHaveLength(1)
    expect(marked[0].parentElement).toHaveTextContent('要有吉他的')
  })

  it('reads the reply of a steered turn like a box message: scene, picks, moment and memory', async () => {
    await busyWithFeeling()
    await type('要有吉他的')
    const steered = lastSteer()
    const reply = block('好，换成吉他的。', { mood_tags: ['安静'], scene: SCENE, picks })
    history = [...history, { role: 'tool', content: '🔧 web_search' }, steerRow(steered), { role: 'assistant', content: reply }]
    api.state.mockResolvedValue({ ...BASE, moments: [MOMENT], queue: QUEUE, last_source: replySource(reply) })
    slot(false)
    await flush(POLL_MS)
    await flush()
    expect(api.verifyPicks).toHaveBeenCalledTimes(1)
    // The queue is replaced, as for any box message, and kept as a moment in the steered words.
    expect(api.setQueue).toHaveBeenCalledWith(expect.objectContaining({ moment_id: MOMENT.id, mood_tags: ['安静'] }))
    expect(api.setQueue.mock.calls[0][0].append).toBeUndefined()
    expect(api.addMoment).toHaveBeenCalledWith('要有吉他的')
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('dj')
    // The buddy's cards are drawn under its reply.
    expect(screen.getByTestId('mood-cards')).toBeInTheDocument()
    // The memory the steered words carried is marked used once a pick is liked.
    api.feedback.mockResolvedValue({ ...QUEUE[0], feedback: 'liked' })
    fireEvent.click(screen.getAllByRole('button', { name: t('page.like') })[0])
    await flush()
    expect(api.markUsed).toHaveBeenCalledWith([MEMORY[0].id])
  })

  it('takes back words the gateway queued behind a turn still running, says so, and keeps them in the box', async () => {
    await busyWithFeeling()
    api.steer.mockResolvedValue({ steered: false, queued: true, queueId: 'q1' })
    await type('要有吉他的')
    expect(api.cancelQueued).toHaveBeenCalledWith(KEY, 'q1')
    expect(screen.getByTestId('mood-notice')).toHaveTextContent(t('chat.steer_missed'))
    expect(box().value).toBe('要有吉他的')
    expect(screen.queryByTestId('mood-steered')).toBeNull()
    expect(api.ask).toHaveBeenCalledTimes(1)
  })

  it('keeps the words and says so when the steer call fails', async () => {
    await busyWithFeeling()
    api.steer.mockRejectedValue(new Error('API 500'))
    await type('要有吉他的')
    expect(screen.getByTestId('mood-notice')).toHaveTextContent(t('chat.steer_missed'))
    expect(box().value).toBe('要有吉他的')
  })

  it('sends the words as a normal message when the turn had just ended, and waits on that turn', async () => {
    await busyWithFeeling()
    api.steer.mockResolvedValue({ steered: false, queued: true, queueId: 'q1' })
    // The turn is over by the time the page looks: the queued words run next, as their own turn.
    const first = block('先听这些。', { mood_tags: ['安静'], picks })
    history = [...history, { role: 'assistant', content: first }]
    slot(false)
    await type('要有吉他的')
    expect(api.cancelQueued).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mood-notice')).toBeNull()
    expect(box().value).toBe('')
    await flush(POLL_MS)
    await flush()
    // The first turn's reply is read; then its own turn runs and answers.
    expect(api.setQueue).toHaveBeenCalledTimes(1)
    const second = block('吉他的来了。', { mood_tags: ['吉他'], picks: [picks[1]] })
    history = [...history, { role: 'user', content: lastSteer() }, { role: 'assistant', content: second }]
    slot(false)
    await flush(POLL_MS)
    await flush()
    expect(api.setQueue).toHaveBeenCalledTimes(2)
    expect(api.setQueue.mock.calls[1][0]).toEqual(expect.objectContaining({ mood_tags: ['吉他'], source: replySource(second) }))
    expect(api.addMoment).toHaveBeenLastCalledWith('要有吉他的')
  })

  it('counts words it could not take back as sent: they already ran', async () => {
    await busyWithFeeling()
    api.steer.mockResolvedValue({ steered: false, queued: true, queueId: 'q1' })
    api.cancelQueued.mockResolvedValue(false)
    await type('要有吉他的')
    expect(api.cancelQueued).toHaveBeenCalledWith(KEY, 'q1')
    expect(screen.queryByTestId('mood-notice')).toBeNull()
    expect(box().value).toBe('')
  })

  it("answers the buddy's open question during a song's turn, into that turn", async () => {
    render(<MoodMusicPage />)
    await flush()
    await flush()
    await type('想听点安静的')
    const asked = block('先放这些。你更想听中文还是英文？', { mood_tags: ['安静'], picks, question: '你更想听中文还是英文？' })
    history = [{ role: 'user', content: lastAsk() }, { role: 'assistant', content: asked }]
    api.state.mockResolvedValue({ ...BASE, moments: [MOMENT], queue: QUEUE, last_source: replySource(asked) })
    slot(false)
    await flush(POLL_MS)
    await flush()
    expect(screen.getByTestId('mood-question')).toBeInTheDocument()
    // Song 1 is asked to play: that turn runs, and the question stays open.
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    history = [...history, { role: 'user', content: lastAsk() }]
    slot(true, [{ role: 'tool', content: '🔧 browser', meta: { input: '{"op": "navigate"}' } }])
    await flush(POLL_MS)
    expect(screen.getByTestId('mood-question')).toBeInTheDocument()
    await type('中文')
    expect(lastSteer()).toContain('Answer to your question: 中文')
    expect(api.ask).toHaveBeenCalledTimes(2)
    // Answered: the question closes.
    expect(screen.queryByTestId('mood-question')).toBeNull()
  })
})

describe('words steered into a song’s turn', () => {
  async function playing() {
    render(<MoodMusicPage />)
    await flush()
    await flush()
    await type('想听点安静的')
    const first = block('先放这些。', { mood_tags: ['安静'], picks })
    history = [{ role: 'user', content: lastAsk() }, { role: 'assistant', content: first }]
    api.state.mockResolvedValue({ ...BASE, moments: [MOMENT], queue: QUEUE, last_source: replySource(first) })
    slot(false)
    await flush(POLL_MS)
    await flush()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    history = [...history, { role: 'user', content: lastAsk() }]
    slot(true, [{ role: 'tool', content: '🔧 browser', meta: { input: '{"op": "navigate"}' } }])
    await flush(POLL_MS)
    await type('要有吉他的')
  }

  it('keep the play’s result, then read the reply like a box message', async () => {
    await playing()
    const reply = block('放上了，也找了吉他的。', { played: true, site: 'youtube', steps: ['x'], mood_tags: ['吉他'], picks })
    history = [...history, steerRow(lastSteer()), { role: 'assistant', content: reply }]
    slot(false)
    await flush(POLL_MS)
    await flush()
    expect(api.setPlayback).toHaveBeenCalledWith({ pick_id: pick(1).id })
    expect(api.setQueue).toHaveBeenLastCalledWith(expect.objectContaining({ mood_tags: ['吉他'], source: replySource(reply) }))
    expect(api.setQueue.mock.calls[api.setQueue.mock.calls.length - 1][0].append).toBeUndefined()
    expect(api.addMoment).toHaveBeenLastCalledWith('要有吉他的')
  })

  it('that the turn ended without reading run as their own turn, which the page waits on next', async () => {
    await playing()
    const played = block('放上了。', { played: true, site: 'youtube', steps: ['x'] })
    history = [...history, steerRow(lastSteer(), 'requeued'), { role: 'assistant', content: played }]
    slot(false)
    await flush(POLL_MS)
    await flush()
    // The turn's own reply is the play: recorded, and no moment for words it never read.
    expect(api.setPlayback).toHaveBeenCalledWith({ pick_id: pick(1).id })
    const moments = api.addMoment.mock.calls.length
    const reply = block('吉他的来了。', { mood_tags: ['吉他'], picks })
    history = [...history, { role: 'user', content: lastSteer() }, { role: 'assistant', content: reply }]
    slot(false)
    await flush(POLL_MS)
    await flush()
    expect(api.setQueue).toHaveBeenLastCalledWith(expect.objectContaining({ mood_tags: ['吉他'] }))
    expect(api.addMoment).toHaveBeenCalledTimes(moments + 1)
    expect(api.addMoment).toHaveBeenLastCalledWith('要有吉他的')
  })
})

describe('steered rows in the slot', () => {
  const ask = '[Mood Music]\nMessage: 想听点安静的'
  const steer = '[Mood Music]\nMessage: 要有吉他的'

  it('are the person’s words with the cut-in mark, inside the same turn', () => {
    const lines = conversation({
      running: false,
      messages: [
        { role: 'user', content: ask },
        { role: 'tool', content: '🔧 web_search' },
        { role: 'assistant', content: '我先找找。' },
        steerRow(steer, 'written'),
        { role: 'tool', content: '🔧 web_search' },
        { role: 'assistant', content: block('好。', { picks: [] }) },
      ],
    })
    expect(lines.map(l => [l.who, l.text, !!l.steered])).toEqual([
      ['you', '想听点安静的', false],
      ['you', '要有吉他的', true],
      ['buddy', '好。', false],
    ])
    // The note before the steer stays one of the turn's steps.
    expect(lines[2].steps?.some(s => s.kind === 'note' && s.text === '我先找找。')).toBe(true)
  })

  it('hide a superseded row, and show a requeued one without the mark', () => {
    const superseded = conversation({ messages: [{ role: 'user', content: ask }, steerRow(steer, 'superseded'), { role: 'user', content: steer }] })
    expect(superseded.map(l => [l.text, !!l.steered])).toEqual([['想听点安静的', false], ['要有吉他的', false]])
    const requeued = conversation({ running: true, messages: [{ role: 'user', content: ask }, steerRow(steer, 'requeued')] })
    expect(requeued.map(l => !!l.steered)).toEqual([false, false])
  })

  it('tell when the turn ended without reading the words', () => {
    expect(steerRequeued({ messages: [steerRow(steer, 'consumed')] }, '要有吉他的')).toBe(false)
    expect(steerRequeued({ messages: [steerRow(steer, 'requeued')] }, '要有吉他的')).toBe(true)
    expect(steerRequeued({ messages: [steerRow(steer, 'superseded')] }, '要有吉他的')).toBe(true)
    expect(steerRequeued({ messages: [steerRow(steer, 'requeued')] }, '别的')).toBe(false)
  })
})
