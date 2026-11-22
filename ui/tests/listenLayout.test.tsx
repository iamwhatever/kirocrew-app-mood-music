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
    expect(SPLIT_CSS).toMatch(/@container mm-page \(min-width: 860px\)[\s\S]*grid-template-columns: minmax\(320px, 5fr\) minmax\(0, 7fr\)/)
    // A wide right column puts the player and the queue side by side.
    expect(SPLIT_CSS).toMatch(/@container \(min-width: 720px\) \{\s*\.mm-deck \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/)
  })

  it('is one column on a narrow page', () => {
    // Outside the container queries every grid is a single column.
    expect(SPLIT_CSS).toMatch(/^\.mm-listen \{[^}]*grid-template-columns: minmax\(0, 1fr\);/m)
    expect(SPLIT_CSS).toMatch(/^\.mm-deck \{[^}]*grid-template-columns: minmax\(0, 1fr\);/m)
  })
})

/** SPLIT_CSS cut into its top-level rules and each at-rule block's rules. */
function blocks(css: string): { at: string; rules: Map<string, string> }[] {
  const out: { at: string; rules: Map<string, string> }[] = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const parse = (body: string, at: string) => {
    const rules = new Map<string, string>()
    let i = 0
    while (i < body.length) {
      const open = body.indexOf('{', i)
      if (open < 0) break
      const head = body.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (depth && j < body.length) { if (body[j] === '{') depth++; else if (body[j] === '}') depth--; j++ }
      const inner = body.slice(open + 1, j - 1)
      if (head.startsWith('@')) parse(inner, head)
      else for (const sel of head.split(',')) rules.set(sel.trim(), (rules.get(sel.trim()) ?? '') + inner)
      i = j
    }
    out.push({ at, rules })
  }
  parse(clean, '')
  return out
}
const block = (at: string) => blocks(SPLIT_CSS).find(b => b.at === at)!
const scrolls = (decl = '') => /overflow(-y)?: (auto|scroll)/.test(decl)
const WIDE = '@container mm-page (min-width: 860px)'

describe('One scroll on the right', () => {
  it('wide: the right column holds still and the queue is its only scroll', async () => {
    await open()
    const right = screen.getByTestId('mood-player-column')
    expect(right).toHaveClass('mm-player')
    expect(screen.getByTestId('mood-queue')).toHaveClass('mm-queue-list')
    const wide = block(WIDE).rules
    expect(wide.get('.mm-player')).toMatch(/overflow: hidden/)
    // The wide layout adds one scroll, the queue (the left record scrolls from the base rule).
    const scrollers = [...wide].filter(([, d]) => scrolls(d)).map(([s]) => s)
    expect(scrollers).toEqual(['.mm-queue-list'])
    // It takes the height that is left, and its rows never stretch the column.
    expect(wide.get('.mm-queue-list')).toMatch(/flex: 1 1 0;[^]*min-height: 10rem;[^]*contain: size/)
    expect(wide.get('.mm-deck')).toMatch(/flex: 1 1 0/)
    // The column's height is the page's, not its content's.
    expect(wide.get('.mm-split > .mm-listen')).toMatch(/grid-template-rows: minmax\(0, 1fr\)/)
  })

  it('narrow: the page scrolls and the queue has no scroll of its own', () => {
    const base = block('').rules
    expect(scrolls(base.get('.mm-queue-list'))).toBe(false)
    expect(base.get('.mm-queue-list')).not.toMatch(/max-height/)
    expect(scrolls(base.get('.mm-player'))).toBe(false)
  })

  it('a column too short scrolls as one, and then the queue does not scroll', () => {
    const short = blocks(SPLIT_CSS).filter(b => b.at.startsWith('@container mm-cols (max-height:'))
    expect(short.map(b => b.at)).toEqual(['@container mm-cols (max-height: 48rem)', '@container mm-cols (max-height: 42rem)'])
    for (const { rules } of short) {
      const [player] = [...rules].filter(([s, d]) => s.includes('.mm-player') && !s.includes(' ') && scrolls(d))
      expect(player).toBeTruthy()
      // The same block, under the same class, lets the queue show every row.
      const scope = player[0] === '.mm-player' ? '' : '.mm-player-view '
      expect(rules.get(`${scope}.mm-queue-list`)).toMatch(/overflow: visible;[^]*contain: none/)
      expect(rules.get(`${scope}.mm-deck`)).toMatch(/flex: none/)
    }
  })

  it('marks the column while the live view is open, so hiding it lowers the bar', async () => {
    const { default: BrowserView } = await import('../src/BrowserView')
    const { rerender } = render(<BrowserView open onToggle={() => undefined} operating={false} live={<div />} />)
    expect(screen.getByTestId('mood-browser-view')).toHaveClass('mm-view', 'mm-view-open')
    rerender(<BrowserView open={false} onToggle={() => undefined} operating={false} live={<div />} />)
    expect(screen.getByTestId('mood-browser-view')).toHaveClass('mm-view')
    expect(screen.getByTestId('mood-browser-view')).not.toHaveClass('mm-view-open')
    // The live view gives way before the queue does, down to a floor.
    expect(block(WIDE).rules.get('.mm-view-open')).toMatch(/min-height: 9rem/)
    expect(block(WIDE).rules.get('.mm-view .mm-view-body')).toMatch(/flex: 0 1 clamp\(14rem, 42vh, 30rem\)/)
  })
})

describe('Queue', () => {

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
