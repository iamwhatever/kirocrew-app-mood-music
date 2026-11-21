// The Listen tab's layout: the page's whole width, chat on the left, and on the
// right the buddy's browser on top with the player and the queue under it. jsdom
// does not run container queries, so the structure is read from the DOM and the
// column rules from the page's own style text.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MoodState, QueuedPick } from '../src/api'

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

import MoodMusicPage, { SPLIT_CSS } from '../src/MoodMusicPage'
import { stubMedia } from './stubs/app-sdk'

const api = mock.api

function pick(n: number): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: `why ${n}`, tags: [], source: 'youtube', feedback: '' }
}

const STATE: MoodState = {
  moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: [], songs: [], at: 1 }],
  queue: [pick(1), pick(2), pick(3)], feedback: [], last_source: 'r0', memory: [],
  settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
}

async function open() {
  render(<MoodMusicPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  api.setPlayback.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
  stubMedia.error = 'no_tab'
  api.state.mockResolvedValue(STATE)
  api.openSlot.mockResolvedValue({ key: 'dashboard:mood-music-buddy' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.setSettings.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Listen layout', () => {
  it('is not held to a narrow middle column', async () => {
    await open()
    const listen = screen.getByTestId('mood-listen')
    expect(listen.className).not.toMatch(/max-w-/)
    // Only a very wide screen stops it growing.
    expect(SPLIT_CSS).toMatch(/\.mm-listen \{[^}]*max-width: 1760px/)
  })

  it('puts the chat left and the browser, player and queue right on a wide page', async () => {
    await open()
    const listen = screen.getByTestId('mood-listen')
    const [left, right] = Array.from(listen.children)
    expect(left).toBe(screen.getByTestId('mood-chat-column'))
    expect(right).toBe(screen.getByTestId('mood-player-column'))
    // The browser view on top, then the deck with the player and the queue.
    const view = within(right as HTMLElement).getByTestId('mood-browser-view')
    const deck = within(right as HTMLElement).getByTestId('mood-deck')
    expect(view.compareDocumentPosition(deck) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(deck).getByTestId('mood-now-playing')).toBeInTheDocument()
    expect(within(deck).getByTestId('mood-queue')).toBeInTheDocument()
    expect(SPLIT_CSS).toMatch(/@container \(min-width: 860px\)[\s\S]*grid-template-columns: minmax\(320px, 5fr\) minmax\(0, 7fr\)/)
    // A wide right column puts the player and the queue side by side.
    expect(SPLIT_CSS).toMatch(/@container \(min-width: 720px\) \{\s*\.mm-deck \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/)
  })

  it('is one column on a narrow page', () => {
    // Outside the container queries every grid is a single column.
    expect(SPLIT_CSS).toMatch(/^\.mm-listen \{[^}]*grid-template-columns: minmax\(0, 1fr\);/m)
    expect(SPLIT_CSS).toMatch(/^\.mm-deck \{[^}]*grid-template-columns: minmax\(0, 1fr\);/m)
  })
})

describe('Queue', () => {
  it('has real height with its own scroll', async () => {
    await open()
    expect(screen.getByTestId('mood-queue')).toHaveClass('mm-queue-list')
    expect(SPLIT_CSS).toMatch(/\.mm-queue-list \{[^}]*min-height: 12rem;[^}]*max-height: 32rem;[^}]*overflow-y: auto/)
  })

  it('shows title, artist and why on every row, and marks the current song', async () => {
    await open()
    const rows = screen.getAllByTestId('mood-queue-row')
    expect(rows).toHaveLength(3)
    rows.forEach((row, i) => {
      expect(row).toHaveTextContent(`Song ${i + 1}`)
      expect(row).toHaveTextContent(`Artist ${i + 1}`)
      expect(within(row).getByTestId('mood-queue-why')).toHaveTextContent(`why ${i + 1}`)
    })
    // Nothing is cut to one line: the title and why wrap, up to two lines.
    expect(within(rows[1]).getByText('Song 2').className).not.toMatch(/truncate/)
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(within(rows[0]).getByTestId('mood-queue-now')).toBeInTheDocument()
    expect(rows[1]).not.toHaveAttribute('aria-current')
    expect(within(rows[1]).queryByTestId('mood-queue-now')).toBeNull()
    expect(screen.getByTestId('mood-queue-count')).toHaveTextContent('3')
  })

  it('shows a queue of one song too', async () => {
    api.state.mockResolvedValue({ ...STATE, queue: [pick(1)] })
    await open()
    expect(screen.getAllByTestId('mood-queue-row')).toHaveLength(1)
  })
})

describe('Live view size', () => {
  it('caps the live view so the player and queue stay in view', async () => {
    const { default: BrowserView } = await import('../src/BrowserView')
    render(<BrowserView open onToggle={() => undefined} operating={false} live={<div />} />)
    expect(screen.getByTestId('mood-browser-view-body')).toHaveClass('mm-view-body')
    expect(SPLIT_CSS).toMatch(/\.mm-view-body \{[^}]*height: clamp\(14rem, 42vh, 30rem\)/)
  })
})
