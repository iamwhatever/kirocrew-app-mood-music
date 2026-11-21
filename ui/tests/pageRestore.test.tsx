// Leaving the page and coming back (the full chat, the sidebar, browser back, a
// reload) shows the same view: the tab, what was typed, the buddy conversation,
// the cards, the queue and the song that was up, the scroll position, and a turn
// still out with its live status. Each test leaves by unmounting the page and
// comes back by mounting a fresh one, as the dashboard's router does.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t as tr } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'
import { PAGE_KEY, PAGE_MAX_BYTES } from '../src/pageMemory'

vi.mock('../src/reducedMotion', () => ({ usePrefersReducedMotion: () => false }))

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), approve: vi.fn(), stop: vi.fn(), setSettings: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import { replySource } from '../src/replyParse'

const api = mock.api
const ID = 'dQw4w9WgXcQ'
const ID2 = 'oHg5SJYRHA0'
const t = (k: string, o?: Record<string, string | number>) => tr(k.includes('.') ? k : `page.${k}`, o)
const MOMENT = { id: 'm'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 1 }
const EMPTY: MoodState = { moments: [], queue: [], feedback: [], last_source: '', memory: [], settings: { explore: 'balanced', record_open: false } }

const USER = { role: 'user', content: '[Mood Music]\nMood: Calm\n' }
const block = (data: unknown) => '听起来是安静地想。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const PICKS = {
  mood_tags: ['平静'],
  picks: [
    { title: 'First', source: 'youtube', url: `https://www.youtube.com/watch?v=${ID}`, why: 'soft' },
    { title: 'Second', source: 'youtube', url: `https://www.youtube.com/watch?v=${ID2}`, why: 'softer' },
  ],
}
const done = (data: unknown): SlotData => ({ running: false, messages: [USER, { role: 'assistant', content: block(data) }] })
const searching: SlotData = { running: true, messages: [USER, { role: 'tool', content: 'web_search', meta: { tool_name: 'web_search' } }] }

const queued = (id: string, title: string, video: string): QueuedPick =>
  ({ id: id.repeat(32), title, artist: 'A', why: 'soft', tags: [], source: 'youtube', video_id: video, feedback: '' })
const QUEUE = [queued('a', 'First', ID), queued('b', 'Second', ID2)]

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Leave the page and come back to a freshly mounted one. */
async function leaveAndReturn() {
  cleanup()
  render(<MoodMusicPage />)
  await flush()
}

/** The backend after a reply's picks were queued. */
function queuedState(slot: SlotData): MoodState {
  return { ...EMPTY, moments: [MOMENT], queue: QUEUE, last_source: replySource(slot.messages![1].content!) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  api.state.mockResolvedValue(EMPTY)
  api.addMoment.mockResolvedValue(MOMENT)
  api.openSlot.mockResolvedValue({ key: 'mood-music' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue('mood-music')
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: QUEUE })
  api.setSettings.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('coming back to the page', () => {
  it('shows the tab, typed mood, toggles, conversation, cards, queue and the song that was up', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('mood_calm') }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    const slot = done(PICKS)
    api.getSlot.mockResolvedValue(slot)
    api.state.mockResolvedValue(queuedState(slot))
    await flush(POLL_MS)
    expect(screen.getAllByTestId('mood-song-card')).toHaveLength(2)

    // Where the person was: the second song up, a new mood half typed, the
    // stay toggle on, and the Moments tab open.
    fireEvent.click(within(screen.getByTestId('mood-queue')).getByRole('button', { name: /Second/ }))
    fireEvent.change(screen.getByLabelText(t('mood_label')), { target: { value: '还想要更慢的' } })
    fireEvent.click(screen.getByRole('button', { name: t('chat.stay_only') }))
    fireEvent.click(screen.getByRole('tab', { name: t('tab_moments') }))

    await leaveAndReturn()

    expect(screen.getByRole('tab', { name: t('tab_moments') })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: t('tab_listen') }))
    expect(screen.getByLabelText(t('mood_label'))).toHaveValue('还想要更慢的')
    expect(screen.getByRole('button', { name: t('chat.stay_only') })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: t('mood_calm') })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('calm')
    expect(screen.getByText('听起来是安静地想。')).toBeInTheDocument()
    expect(screen.getAllByTestId('mood-song-card')).toHaveLength(2)
    const queue = within(screen.getByTestId('mood-queue'))
    expect(queue.getByRole('button', { name: /Second/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument()
  })

  it('shows a buddy question again, though it queued no songs', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('mood_calm') }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    api.getSlot.mockResolvedValue(done({ question: '是哪种安静？', picks: [] }))
    api.state.mockResolvedValue({ ...EMPTY, moments: [MOMENT] })
    await flush(POLL_MS)
    expect(screen.getByTestId('mood-question')).toHaveTextContent('是哪种安静？')

    await leaveAndReturn()

    expect(screen.getByTestId('mood-question')).toHaveTextContent('是哪种安静？')
  })

  it('shows a turn still running with its live status, then draws its picks', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('mood_calm') }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    api.getSlot.mockResolvedValue(searching)
    await flush(POLL_MS)
    expect(screen.getByTestId('mood-status')).toHaveTextContent(t('chat.status_searching', { count: 1 }))

    api.state.mockResolvedValue({ ...EMPTY, moments: [MOMENT] })
    await leaveAndReturn()

    // Not sent again, and not gone: the same turn, still searching.
    expect(api.ask).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mood-status')).toHaveTextContent(t('chat.status_searching', { count: 1 }))
    expect(screen.getByRole('button', { name: t('chat.stop') })).toBeInTheDocument()

    const slot = done(PICKS)
    api.getSlot.mockResolvedValue(slot)
    api.state.mockResolvedValue(queuedState(slot))
    await flush(POLL_MS)
    expect(api.setQueue).toHaveBeenCalledTimes(1)
    expect(api.setQueue.mock.calls[0][0].moment_id).toBe(MOMENT.id)
    expect(screen.queryByTestId('mood-status')).toBeNull()
    expect(screen.getAllByTestId('mood-song-card')).toHaveLength(2)
  })

  it('reads a reply that finished while the person was away', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('mood_calm') }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.send') }))
    await flush()
    api.getSlot.mockResolvedValue(searching)
    await flush(POLL_MS)
    cleanup()

    const slot = done(PICKS)
    api.getSlot.mockResolvedValue(slot)
    api.state.mockResolvedValue({ ...EMPTY, moments: [MOMENT] })
    render(<MoodMusicPage />)
    await flush()
    api.state.mockResolvedValue(queuedState(slot))
    await flush(POLL_MS)
    expect(api.setQueue).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('mood-song-card')).toHaveLength(2)
  })

  it('does not wait again on a turn whose picks were already queued', async () => {
    const slot = done(PICKS)
    const state = queuedState(slot)
    window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({
      tab: 'listen', pending: { momentId: MOMENT.id, baseline: '', memoryIds: [], text: 'Calm' },
    }))
    api.state.mockResolvedValue(state)
    api.getSlot.mockResolvedValue(slot)
    render(<MoodMusicPage />)
    await flush(POLL_MS)
    expect(screen.queryByTestId('mood-status')).toBeNull()
    expect(api.setQueue).not.toHaveBeenCalled()
    expect(JSON.parse(window.sessionStorage.getItem(PAGE_KEY)!).pending).toBeNull()
  })

  it('does not wait on a turn that went to the old listed chat, after the move to the hidden one', async () => {
    window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({
      tab: 'listen', slotKey: 'mood-music', pending: { momentId: MOMENT.id, baseline: 'old', memoryIds: [], text: 'Calm' },
    }))
    api.state.mockResolvedValue({ ...EMPTY, moments: [MOMENT] })
    api.openSlot.mockResolvedValue({ key: 'mood-music-buddy' })
    render(<MoodMusicPage />)
    await flush(POLL_MS)
    expect(api.getSlot).toHaveBeenCalledWith('mood-music-buddy')
    expect(screen.queryByTestId('mood-status')).toBeNull()
    expect(JSON.parse(window.sessionStorage.getItem(PAGE_KEY)!)).toMatchObject({ slotKey: 'mood-music-buddy', pending: null })
  })

  it('brings back the scene on screen, and reads an older saved look as its preset', async () => {
    const scene = { hues: [8, 30, 350], saturation: 'vivid', lightness: 'medium', strength: 0.8, motion: 'lively', pattern: 'particles', arc: 'turn', source: 'dj' }
    window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({ tab: 'listen', scene }))
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('dj')
    expect(screen.getByTestId('mood-backdrop').dataset.hues).toBe('8,30,350')
    expect(JSON.parse(window.sessionStorage.getItem(PAGE_KEY)!).scene).toEqual(scene)
    cleanup()
    window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({ tab: 'listen', look: 'missing', scene: { hues: ['x'] } }))
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('missing')
  })

  it('goes back to where the page was scrolled', async () => {
    render(<MoodMusicPage />)
    await flush()
    const scroller = () => screen.getByTestId('mood-music-page').querySelector('.overflow-y-auto') as HTMLElement
    scroller().scrollTop = 340
    fireEvent.scroll(scroller())

    await leaveAndReturn()

    expect(scroller().scrollTop).toBe(340)
  })

  it('gives the record and Up next their own scroll areas, reachable by keyboard, and restores the record scroll', async () => {
    const slot = done(PICKS)
    api.state.mockResolvedValue(queuedState(slot))
    api.getSlot.mockResolvedValue(slot)
    render(<MoodMusicPage />)
    await flush()
    const record = screen.getByRole('log', { name: t('chat.conversation') })
    expect(record).toHaveAttribute('tabindex', '0')
    expect(record).toHaveClass('mm-record')
    const upNext = screen.getByTestId('mood-queue')
    expect(upNext).toHaveAttribute('tabindex', '0')
    expect(upNext).toHaveAccessibleName(t('queue'))
    // The player and the box sit outside the record's scroll area, so scrolling it never moves them.
    expect(record).not.toContainElement(screen.getByTestId('mood-browser-controls'))
    expect(record).not.toContainElement(screen.getByLabelText(t('mood_label')))
    expect(screen.getByTestId('mood-scroll')).toHaveClass('mm-split')

    // A tall record, read back from the top: the person scrolled up from the bottom.
    Object.defineProperty(record, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(record, 'clientHeight', { configurable: true, value: 300 })
    record.scrollTop = 700
    fireEvent.scroll(record)
    record.scrollTop = 220
    fireEvent.scroll(record)
    await leaveAndReturn()
    expect(screen.getByTestId('mood-record').scrollTop).toBe(220)
  })

  it('keeps nothing too large, and ignores a saved view that does not read', async () => {
    window.sessionStorage.setItem(PAGE_KEY, 'x'.repeat(PAGE_MAX_BYTES + 1))
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByRole('tab', { name: t('tab_listen') })).toHaveAttribute('aria-selected', 'true')
    cleanup()
    window.sessionStorage.setItem(PAGE_KEY, '{"tab":"<script>","chip":"nope","look":"evil"}')
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByRole('tab', { name: t('tab_listen') })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('neutral')
    expect(window.sessionStorage.getItem(PAGE_KEY)!.length).toBeLessThanOrEqual(PAGE_MAX_BYTES)
  })
})
