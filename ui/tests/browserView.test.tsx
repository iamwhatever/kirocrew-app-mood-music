// The buddy's live browser box in the player column: shown only where songs can
// play in Kiro Crew's browser, collapsible (the page remembers it), says "using
// the browser" while the buddy's turn is in the browser tool, and tells an older
// host to update instead of showing an empty box.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick } from '../src/api'
import BrowserView from '../src/BrowserView'

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
import { stubMedia } from './stubs/app-sdk'

const api = mock.api
const pick = (n: number): QueuedPick => ({
  id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', video_id: 'dQw4w9WgXcQ', feedback: '',
})
const state = (over: Partial<MoodState['settings']> = {}): MoodState => ({
  moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: [], songs: [], at: 1 }],
  queue: [pick(1), pick(2)], feedback: [], last_source: 'r0', memory: [],
  settings: { explore: 'balanced', record_open: false, continuous: false, ...over },
})

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}
const statusText = () => screen.getByTestId('mood-browser-view-status').textContent

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
  api.markUsed.mockResolvedValue({ marked: 0 })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BrowserView', () => {
  it('shows the host picture when it has one, and folds it away', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<BrowserView open onToggle={onToggle} operating={false} live={<div data-testid="host-live" />} />)
    expect(screen.getByTestId('host-live')).toBeTruthy()
    expect(screen.queryByTestId('mood-browser-view-old-host')).toBeNull()
    fireEvent.click(screen.getByTestId('mood-browser-view-toggle'))
    expect(onToggle).toHaveBeenCalledWith(false)
    rerender(<BrowserView open={false} onToggle={onToggle} operating={false} live={<div data-testid="host-live" />} />)
    expect(screen.queryByTestId('host-live')).toBeNull()
    expect(screen.getByTestId('mood-browser-view-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('says to update Kiro Crew when the host has no picture', () => {
    render(<BrowserView open onToggle={() => undefined} operating={false} live={null} />)
    expect(screen.getByTestId('mood-browser-view-old-host').textContent).toBe(t('view.old_host'))
  })

  it('says the buddy is using the browser only while it is', () => {
    const { rerender } = render(<BrowserView open onToggle={() => undefined} operating={false} live={null} />)
    expect(statusText()).toBe(t('view.idle'))
    rerender(<BrowserView open onToggle={() => undefined} operating live={null} />)
    expect(statusText()).toBe(t('view.operating'))
  })
})

describe('the page', () => {
  it('opens the box by default and remembers when the person folds it', async () => {
    await open()
    expect(screen.getByTestId('mood-browser-view-body')).toBeTruthy()
    fireEvent.click(screen.getByTestId('mood-browser-view-toggle'))
    await flush()
    expect(api.setSettings).toHaveBeenCalledWith({ view_open: false })
    expect(screen.queryByTestId('mood-browser-view-body')).toBeNull()
  })

  it('keeps the box folded when the person left it folded', async () => {
    api.state.mockResolvedValue(state({ view_open: false }))
    await open()
    expect(screen.getByTestId('mood-browser-view')).toBeTruthy()
    expect(screen.queryByTestId('mood-browser-view-body')).toBeNull()
  })

  it("shows the host's live view of the buddy's own slot on a level-11 host", async () => {
    host.level = 11
    await open()
    const view = screen.getByTestId('host-browser-view')
    expect(view.getAttribute('data-slot')).toBe('dashboard:mood-music-buddy')
    expect(screen.queryByTestId('mood-browser-view-old-host')).toBeNull()
  })

  it('asks the host to keep the tab showing after the turn ends, and keeps the box open', async () => {
    host.level = 11
    // A played song is marked heard and its steps kept.
    api.addMemory.mockResolvedValue({})
    api.setPlaySteps.mockResolvedValue({})
    await open()
    expect(screen.getByTestId('host-browser-view').getAttribute('data-stay-live')).toBe('true')
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    const asked = api.ask.mock.calls[0][0] as string
    api.getSlot.mockResolvedValue({
      running: false,
      messages: [{ role: 'user', content: asked }, { role: 'assistant', content: '放上了。\n```mood-music\n{"played": true, "site": "youtube", "steps": ["x"]}\n```' }],
    })
    await flush(POLL_MS)
    await flush()
    // The turn is over and the song plays: the page still shows the view, asking it to stay live.
    expect(screen.getByTestId('mood-browser-view-body')).toBeTruthy()
    expect(screen.getByTestId('host-browser-view').getAttribute('data-stay-live')).toBe('true')
  })

  it('says to update Kiro Crew on a level-10 host, with no live view', async () => {
    await open()
    expect(screen.queryByTestId('host-browser-view')).toBeNull()
    expect(screen.getByTestId('mood-browser-view-old-host')).toBeTruthy()
  })

  it.each(['old_host', 'hidden_refused'])('says plainly when the backend cannot open the hidden chat (%s)', async code => {
    api.ask.mockRejectedValue(new Error(code))
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    await flush()
    expect(screen.getByText(t(`page.error_${code}`))).toBeTruthy()
  })

  it('has no box where songs cannot play in the browser', async () => {
    host.level = 9
    await open()
    expect(screen.queryByTestId('mood-browser-view')).toBeNull()
  })

  it('says "using the browser" while the buddy turn is in the browser tool', async () => {
    await open()
    expect(statusText()).toBe(t('view.idle'))
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    const asked = api.ask.mock.calls[api.ask.mock.calls.length - 1][0] as string
    api.getSlot.mockResolvedValue({
      running: true,
      messages: [{ role: 'user', content: asked }, { role: 'tool', content: '🔧 browser', meta: { tool_name: 'browser' } }],
    })
    await flush(POLL_MS)
    await flush()
    expect(statusText()).toBe(t('view.operating'))
    api.getSlot.mockResolvedValue({
      running: true,
      messages: [{ role: 'user', content: asked }, { role: 'tool', content: '🔧 web_search', meta: { tool_name: 'web_search' } }],
    })
    await flush(POLL_MS)
    await flush()
    expect(statusText()).toBe(t('view.idle'))
  })
})
