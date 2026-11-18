// The Mood Music page end to end against a mocked `../src/api`: a mood goes out
// with the memory summary, the buddy's turn is read off the slot (status line,
// approvals, errors), its picks are verified, queued, drawn as cards and played.
// The poll sleeps on setInterval(POLL_MS), so the file runs on fake timers driven
// inside `act`, and interactions use `fireEvent` to keep each step on that clock.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t as tr } from '../src/i18n'
import type { MemoryItem, MoodState, QueuedPick, SlotData } from '../src/api'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../src/reducedMotion', () => ({ usePrefersReducedMotion: () => motion.reduced }))

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

import MoodMusicPage, { OFFLINE_MS, POLL_MS, STUCK_MS } from '../src/MoodMusicPage'
import { replySource } from '../src/replyParse'
import { FADE_MS } from '../src/MoodBackdrop'
import { presetScene } from '../src/moods'
import { resetStubSdk, stubOpenChat } from './stubs/app-sdk'

const api = mock.api
const ID = 'dQw4w9WgXcQ'
const t = (k: string, o?: Record<string, string | number>) => tr(k.includes('.') ? k : `page.${k}`, o)

const EMPTY: MoodState = { moments: [], queue: [], feedback: [], last_source: '', memory: [], settings: { explore: 'balanced', record_open: false } }
const LIKED: MemoryItem = { id: 'q'.repeat(32), kind: 'liked', origin: 'app', pinned: false, stale: false, created_at: 1, last_used_at: 1, title: 'Old Love', artist: 'B' }

function queued(over: Partial<QueuedPick>): QueuedPick {
  return { id: 'p'.repeat(32), title: 'Song', artist: 'A', why: 'it is soft', tags: [], source: 'youtube', video_id: ID, feedback: '', ...over }
}

const USER = { role: 'user', content: '[Mood Music]\nMood: x\n' }
const block = (data: unknown) => '听起来是安静地想。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const reply = (data: unknown): SlotData => ({ running: false, messages: [USER, { role: 'assistant', content: block(data) }] })
const running = (...rows: object[]): SlotData => ({ running: true, messages: [USER, ...rows] })

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function start(mood = 'mood_calm') {
  render(<MoodMusicPage />)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: t(mood) }))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.reduced = false
  resetStubSdk()
  vi.clearAllMocks()
  api.state.mockResolvedValue({ ...EMPTY, memory: [LIKED] })
  api.addMoment.mockResolvedValue({ id: 'm'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 1 })
  api.openSlot.mockResolvedValue({ key: 'mood-music' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue('mood-music')
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.approve.mockResolvedValue({})
  api.stop.mockResolvedValue({})
  api.addMemory.mockResolvedValue({})
  api.markUsed.mockResolvedValue({ marked: 1 })
  api.setSettings.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MoodMusicPage', () => {
  it('cannot send an empty mood', async () => {
    render(<MoodMusicPage />)
    await flush()
    const send = screen.getByRole('button', { name: t('chat.send') })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByLabelText(t('mood_label')), { target: { value: '   ' } })
    expect(send).toBeDisabled()
  })

  it('sends a mood with the memory summary, verifies the picks, then shows them as cards and plays', async () => {
    await start('mood_missing')
    expect(screen.getByTestId('mood-backdrop').dataset.look).toBe('missing')
    expect(api.addMoment).toHaveBeenCalledWith(t('mood_missing'))
    const sent = api.ask.mock.calls[0][0]
    expect(sent).toContain(`Mood: ${t('mood_missing')}`)
    expect(sent).toContain('Liked: "Old Love" - B')
    expect(sent).toContain('Explore level: balanced (1 anchor, 4 explore, 0 deep)')

    const data = {
      mood_tags: ['想念'],
      picks: [
        { title: 'First', source: 'youtube', url: `https://www.youtube.com/watch?v=${ID}`, tier: 'explore', arc: 'stay', why: 'quiet missing', listen_for: 'the breath in verse two', evidence: { url: 'https://example.com/r', label: 'A review' } },
        { title: 'Fake', source: 'youtube', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' },
        { title: 'Bad', source: 'bilibili', url: 'https://bilibili.com.evil.com/x' },
      ],
      follow_ups: ['再安静一点'],
    }
    const slot = reply(data)
    // The backend drops the made-up one (its title does not match the video).
    api.verifyPicks.mockImplementation(async (picks: { title: string }[]) => ({ picks: picks.filter(p => p.title !== 'Fake'), dropped: { title_mismatch: 1 } }))
    const picks = [queued({ id: 'a'.repeat(32), title: 'First', tier: 'explore', arc: 'stay', why: 'quiet missing', listen_for: 'the breath in verse two', evidence: { url: 'https://example.com/r', label: 'A review' } })]
    api.setQueue.mockResolvedValue({ queue: picks })
    api.state.mockResolvedValue({ ...EMPTY, queue: picks, last_source: replySource(slot.messages![1].content!) })
    api.getSlot.mockResolvedValue(slot)
    await flush(POLL_MS)

    expect(api.verifyPicks.mock.calls[0][0].map((p: { title: string }) => p.title)).toEqual(['First', 'Fake'])
    expect(api.setQueue.mock.calls[0][0].picks.map((p: { title: string }) => p.title)).toEqual(['First'])
    expect(screen.getByText(t('dropped', { count: 2 }))).toBeInTheDocument()

    const card = screen.getByTestId('mood-song-card')
    expect(card).toHaveTextContent(t('card.arc_stay'))
    expect(card).toHaveTextContent(t('card.tier_explore'))
    expect(card).toHaveTextContent('the breath in verse two')
    const praise = within(card).getByRole('link')
    expect(praise.getAttribute('href')).toBe('https://example.com/r')
    expect(praise.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByText('听起来是安静地想。')).toBeInTheDocument()
    expect(screen.queryByText(/mood-music/)).toBeNull()

    // The only player is Kiro Crew's browser: its controls, never an embed.
    expect(within(screen.getByTestId('mood-now-playing')).getByTestId('mood-browser-controls')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()

    fireEvent.click(within(screen.getByTestId('mood-follow-ups')).getByRole('button', { name: '再安静一点' }))
    await flush()
    expect(api.ask.mock.calls[1][0]).toContain('Follow-up: 再安静一点')
    expect(api.addMoment).toHaveBeenCalledTimes(1)
  })

  it('says what the buddy is doing without naming a tool', async () => {
    await start()
    const status = () => screen.getByTestId('mood-status').textContent
    api.getSlot.mockResolvedValue(running())
    await flush(POLL_MS)
    expect(status()).toBe(t('chat.status_thinking'))
    api.getSlot.mockResolvedValue(running({ role: 'tool', content: 'web_search "苏州河 被低估"', meta: { tool_name: 'web_search' } }))
    await flush(POLL_MS)
    expect(status()).toBe(t('chat.status_searching', { count: 1 }))
    api.getSlot.mockResolvedValue(running(
      { role: 'tool', content: 'web_search', meta: { tool_name: 'web_search' } },
      { role: 'tool', content: 'web_fetch https://example.com/review', meta: { tool_name: 'web_fetch' } },
    ))
    await flush(POLL_MS)
    expect(status()).toBe(t('chat.status_reading', { count: 1 }))
    api.getSlot.mockResolvedValue(running({ role: 'tool', content: 'web_fetch', meta: { tool_name: 'web_fetch' } }, { role: 'streaming', content: '听起来' }))
    await flush(POLL_MS)
    expect(status()).toBe(t('chat.status_writing'))
    const page = screen.getByTestId('mood-music-page').textContent ?? ''
    expect(page).not.toMatch(/web_search|web_fetch|example\.com|被低估/)
  })

  it('asks for one approval on the page: allow once or not, never Trust', async () => {
    await start()
    const parked = running({ role: 'permission', content: 'web_fetch', meta: { approval_id: 'r1', tool_input: { url: 'https://music.example.org/list' } } })
    api.getSlot.mockResolvedValue(parked)
    await flush(POLL_MS)
    const card = screen.getByTestId('mood-approval')
    expect(card).toHaveTextContent(t('chat.approval_host', { host: 'music.example.org' }))
    expect(within(card).queryByText(/trust/i)).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: t('chat.allow_once') }))
    await flush()
    expect(api.approve).toHaveBeenCalledWith('mood-music', 'r1', 'approved')
    fireEvent.click(within(card).getByRole('button', { name: t('chat.deny') }))
    await flush()
    expect(api.approve).toHaveBeenLastCalledWith('mood-music', 'r1', 'rejected')

    // Waiting on the person is not the buddy being stuck.
    await flush(STUCK_MS + POLL_MS)
    expect(screen.queryByTestId('mood-stuck')).toBeNull()
  })

  it('shows the steps when the app may not ask for approvals yet', async () => {
    await start()
    api.getSlot.mockResolvedValue(running({ role: 'permission', content: 'web_fetch', meta: { approval_id: 'r1' } }))
    await flush(POLL_MS)
    api.approve.mockRejectedValue(Object.assign(new Error('403'), { status: 403, body: JSON.stringify({ code: 'session_approval_not_granted', cause: 'consent_pending' }) }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.allow_once') }))
    await flush()
    const grant = screen.getByTestId('mood-grant')
    expect(grant).toHaveTextContent(t('chat.grant_consent'))
    fireEvent.click(within(grant).getByRole('button', { name: t('chat.open_full') }))
    expect(stubOpenChat).toHaveBeenCalledWith({ slotKey: 'mood-music' })
  })

  it('shows a failed turn with a retry that asks again', async () => {
    await start()
    const first = api.ask.mock.calls[0][0]
    api.getSlot.mockResolvedValue({ running: false, messages: [USER, { role: 'error', content: 'model overloaded' }] })
    await flush(POLL_MS)
    const banner = screen.getByTestId('mood-turn-error')
    expect(banner).toHaveTextContent('model overloaded')
    fireEvent.click(within(banner).getByRole('button', { name: t('retry') }))
    await flush()
    expect(api.ask.mock.calls[1][0]).toBe(first)
  })

  it('does not treat an auto-retry notice as a failure', async () => {
    await start()
    api.getSlot.mockResolvedValue(running({ role: 'error', content: 'retrying', kind: 'transient_retry' }))
    await flush(POLL_MS)
    expect(screen.queryByTestId('mood-turn-error')).toBeNull()
    expect(screen.getByTestId('mood-status')).toBeInTheDocument()
  })

  it('says the buddy seems stuck after two quiet minutes, and can wait or start over', async () => {
    await start()
    api.getSlot.mockResolvedValue(running())
    await flush(STUCK_MS + 2 * POLL_MS)
    const stuck = screen.getByTestId('mood-stuck')
    fireEvent.click(within(stuck).getByRole('button', { name: t('chat.wait') }))
    expect(screen.queryByTestId('mood-stuck')).toBeNull()
    await flush(STUCK_MS + 2 * POLL_MS)
    fireEvent.click(within(screen.getByTestId('mood-stuck')).getByRole('button', { name: t('chat.stop_restart') }))
    await flush()
    expect(api.stop).toHaveBeenCalledWith('mood-music')
    expect(api.ask).toHaveBeenCalledTimes(2)
  })

  it('says it cannot reach Kiro Crew when reads keep failing, and reconnects on the button', async () => {
    await start()
    api.getSlot.mockRejectedValue(new Error('down'))
    await flush(OFFLINE_MS + 2 * POLL_MS)
    const banner = screen.getByTestId('mood-offline')
    api.getSlot.mockResolvedValue(running())
    fireEvent.click(within(banner).getByRole('button', { name: t('chat.reconnect') }))
    await flush()
    expect(screen.queryByTestId('mood-offline')).toBeNull()
  })

  it('stops a turn the person cancels, with no error', async () => {
    await start()
    api.getSlot.mockResolvedValue(running({ role: 'tool', content: 'x', meta: { tool_name: 'web_search' } }))
    await flush(POLL_MS)
    fireEvent.click(screen.getByRole('button', { name: t('chat.stop') }))
    await flush()
    expect(api.stop).toHaveBeenCalledWith('mood-music')
    api.getSlot.mockResolvedValue({ running: false, messages: [USER, { role: 'assistant', content: 'half a repl' }] })
    await flush(POLL_MS)
    expect(screen.getByText(t('chat.stopped'))).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.verifyPicks).not.toHaveBeenCalled()
  })

  it('says when nothing playable is left, and asks again on the button', async () => {
    await start()
    const first = api.ask.mock.calls[0][0]
    api.verifyPicks.mockResolvedValue({ picks: [], dropped: { not_found: 1, timeout: 1 } })
    api.getSlot.mockResolvedValue(reply({ picks: [
      { title: 'A', source: 'youtube', url: `https://youtu.be/${ID}` },
      { title: 'B', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    ] }))
    await flush(POLL_MS)
    expect(screen.getByText(t('chat.all_dropped', { count: 2 }))).toBeInTheDocument()
    expect(api.setQueue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('retry') }))
    await flush()
    expect(api.ask.mock.calls[1][0]).toBe(first)
  })

  it('shows an honest "nothing good enough" reply with its follow-ups, not an error', async () => {
    await start()
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['换成国语歌'] }))
    await flush(POLL_MS)
    expect(screen.queryByText(t('error_unreadable'))).toBeNull()
    expect(screen.getByText('听起来是安静地想。')).toBeInTheDocument()
    expect(within(screen.getByTestId('mood-follow-ups')).getByRole('button', { name: '换成国语歌' })).toBeInTheDocument()
  })

  it('says so when the reply has no readable block', async () => {
    await start()
    api.getSlot.mockResolvedValue({ running: false, messages: [USER, { role: 'assistant', content: 'no block' }] })
    await flush(POLL_MS)
    expect(screen.getByText(t('error_unreadable'))).toBeInTheDocument()
  })

  it('shows the buddy question and sends the answer', async () => {
    await start()
    api.getSlot.mockResolvedValue(reply({ question: 'Quiet or loud?' }))
    await flush(POLL_MS)
    expect(screen.getAllByText('Quiet or loud?').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText(t('answer_placeholder')), { target: { value: 'quiet' } })
    fireEvent.click(screen.getByRole('button', { name: t('send_answer') }))
    await flush()
    expect(api.ask.mock.calls[1][0]).toContain('Answer to your question: quiet')
  })

  it('saves a preference only when the person taps it', async () => {
    await start()
    api.getSlot.mockResolvedValue(reply({ question: 'x', remember: '喜欢粤语' }))
    await flush(POLL_MS)
    expect(api.addMemory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('chat.remember', { note: '喜欢粤语' }) }))
    await flush()
    expect(api.addMemory).toHaveBeenCalledWith({ kind: 'note', text: '喜欢粤语', origin: 'user' })
  })

  it('labels a song the link check could not confirm', async () => {
    const picks = [queued({ id: 'a'.repeat(32), title: 'Checked' }), queued({ id: 'b'.repeat(32), title: 'Unchecked', source: 'bilibili', video_id: undefined, url: 'https://www.bilibili.com/video/BV1xx411c7mD', unverified: true })]
    const slot = reply({ picks: [] })
    api.state.mockResolvedValue({ ...EMPTY, queue: picks, last_source: replySource(slot.messages![1].content!) })
    api.getSlot.mockResolvedValue(slot)
    render(<MoodMusicPage />)
    await flush()
    const [checked, unchecked] = screen.getAllByTestId('mood-song-card')
    expect(within(checked).queryByTestId('mood-unverified')).toBeNull()
    expect(within(unchecked).getByTestId('mood-unverified')).toHaveTextContent(t('card.unverified'))
    expect(within(unchecked).getByTestId('mood-unverified').getAttribute('title')).toBe(t('card.unverified_hint'))
  })

  it('records "I know it" as the person’s', async () => {
    const picks = [queued({ id: 'a'.repeat(32), title: 'One' }), queued({ id: 'b'.repeat(32), title: 'Two' })]
    const slot = reply({ picks: [] })
    api.state.mockResolvedValue({ ...EMPTY, queue: picks, last_source: replySource(slot.messages![1].content!) })
    api.getSlot.mockResolvedValue(slot)
    render(<MoodMusicPage />)
    await flush()
    const [one, two] = screen.getAllByTestId('mood-song-card')
    fireEvent.click(within(one).getByRole('button', { name: t('card.known') }))
    await flush()
    expect(api.addMemory).toHaveBeenCalledWith({ kind: 'known', title: 'One', artist: 'A', origin: 'user' })
    // Pressing play alone marks nothing: a song counts as heard once the buddy started it.
    fireEvent.click(within(two).getByRole('button', { name: t('play', { title: 'Two' }) }))
    await flush()
    expect(api.addMemory).toHaveBeenCalledTimes(1)
  })

  it('sends the explore level and stay-only choice, and keeps the level', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: t('chat.explore_more') }))
    expect(api.setSettings).toHaveBeenCalledWith({ explore: 'explore' })
    fireEvent.click(screen.getByRole('button', { name: t('chat.stay_only') }))
    fireEvent.click(screen.getByRole('button', { name: t('mood_sad') }))
    await flush()
    const sent = api.ask.mock.calls[0][0]
    expect(sent).toContain('Explore level: explore (0 anchor, 4 explore, 1 deep)')
    expect(sent).toContain('Arc: stay only')
  })

  it('has no player choice, and every request says songs play in Kiro Crew\'s browser', async () => {
    render(<MoodMusicPage />)
    await flush()
    expect(screen.queryByTestId('mood-player-choice')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('mood_sad') }))
    await flush()
    expect(api.ask.mock.calls[0][0]).toContain("Player: Kiro Crew's browser.")
  })

  it('keeps the full record collapsed until asked, and remembers it open', async () => {
    const slot = reply({ picks: [] })
    api.state.mockResolvedValue({ ...EMPTY, last_source: 'r1' })
    api.getSlot.mockResolvedValue(slot)
    render(<MoodMusicPage />)
    await flush()
    const toggle = screen.getByRole('button', { name: t('chat.show_record') })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('chat-embed')).toBeNull()
    fireEvent.click(toggle)
    expect(api.setSettings).toHaveBeenCalledWith({ record_open: true })
    expect(screen.getByTestId('chat-embed').dataset.slot).toBe('mood-music')
    fireEvent.click(within(screen.getByTestId('mood-full-record')).getByRole('button', { name: t('chat.open_full') }))
    expect(stubOpenChat).toHaveBeenCalledWith({ slotKey: 'mood-music' })
  })

  it('opens the full record from a banner', async () => {
    await start()
    api.getSlot.mockResolvedValue({ running: false, messages: [USER, { role: 'error', content: 'boom' }] })
    await flush(POLL_MS)
    fireEvent.click(within(screen.getByTestId('mood-turn-error')).getByRole('button', { name: t('chat.show_record') }))
    expect(api.setSettings).toHaveBeenCalledWith({ record_open: true })
    expect(screen.getByTestId('chat-embed')).toBeInTheDocument()
  })

  it('skips to the next pick and records it', async () => {
    const picks = [queued({ id: 'a'.repeat(32), title: 'One' }), queued({ id: 'b'.repeat(32), title: 'Two' })]
    api.state.mockResolvedValue({ ...EMPTY, queue: picks })
    api.feedback.mockResolvedValue({ ...picks[0], feedback: 'skipped' })
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByRole('heading', { name: 'One' })).toBeInTheDocument()
    api.state.mockResolvedValue({ ...EMPTY, queue: [{ ...picks[0], feedback: 'skipped' }, picks[1]] })
    fireEvent.click(within(screen.getByTestId('mood-now-playing')).getByRole('button', { name: t('skip') }))
    await flush()
    expect(api.feedback).toHaveBeenCalledWith('a'.repeat(32), 'skipped')
    expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()
    // The next song goes straight to the buddy to play in Kiro Crew's browser.
    expect(api.ask.mock.calls[api.ask.mock.calls.length - 1][0]).toContain('Play in Crew Browser: "Two"')
  })

  it('lists the moments with their songs on the second tab', async () => {
    api.state.mockResolvedValue({ ...EMPTY, moments: [{ id: 'm'.repeat(32), mood: '下雨的傍晚', note: '', tags: ['想念'], songs: [{ title: '晴天', artist: '周杰伦' }], at: 1 }] })
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: t('tab_moments') }))
    expect(screen.getByText('下雨的傍晚')).toBeInTheDocument()
    expect(screen.getByText('晴天 — 周杰伦')).toBeInTheDocument()
  })

  it('shows the memory on its tab', async () => {
    render(<MoodMusicPage />)
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: t('tab_memory') }))
    expect(screen.getByText(/Old Love — B/)).toBeInTheDocument()
  })

  it('pauses the backdrop drift with its control', async () => {
    render(<MoodMusicPage />)
    await flush()
    expect(screen.getByTestId('mood-backdrop').dataset.moving).toBe('true')
    expect(screen.getByTestId('mood-motion-toggle')).toHaveTextContent(t('pause_motion'))
    fireEvent.click(screen.getByTestId('mood-motion-toggle'))
    expect(screen.getByTestId('mood-backdrop').dataset.moving).toBe('false')
  })

  it('holds the backdrop and the status still under reduced motion', async () => {
    motion.reduced = true
    await start()
    api.getSlot.mockResolvedValue(running())
    await flush(POLL_MS)
    expect(screen.getByTestId('mood-backdrop').dataset.moving).toBe('false')
    expect(screen.queryByTestId('mood-motion-toggle')).toBeNull()
    expect(screen.getByTestId('mood-status').querySelector('.animate-pulse')).toBeNull()
  })

  it('paints only through theme variables, so a dark theme carries through', async () => {
    document.documentElement.classList.add('dark')
    try {
      const { container } = render(<MoodMusicPage />)
      await flush()
      const styles = [...container.querySelectorAll<HTMLElement>('[style]')].map(el => el.getAttribute('style') ?? '')
      expect(styles.join(' ')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
      const glows = screen.getAllByTestId('mood-glow')
      expect(glows[0].style.background).toContain('var(--bg)')
      expect(glows[0].dataset.hue).toBe('212')
    } finally {
      document.documentElement.classList.remove('dark')
    }
  })
})

describe('the backdrop scene', () => {
  const SCENE = { hues: [8, 30, 350], saturation: 'vivid', lightness: 'medium', strength: 0.8, motion: 'lively', pattern: 'particles', arc: 'turn' }
  const backdrop = () => screen.getByTestId('mood-backdrop')
  const afterFade = () => flush(FADE_MS + 200)

  it('sets a chip preset at once, then takes the scene the buddy chose', async () => {
    await start('mood_sad')
    expect(backdrop().dataset.look).toBe('sad')
    expect(backdrop().dataset.hues).toBe(presetScene('sad').hues.join(','))
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['换成国语歌'], scene: SCENE }))
    await flush(POLL_MS)
    expect(backdrop().dataset.look).toBe('dj')
    expect(backdrop().dataset.pattern).toBe('particles')
    expect(backdrop().dataset.hues).toBe('8,30,350')
    // The old scene fades out under the new one, then is dropped.
    expect(screen.getAllByTestId('mood-scene')).toHaveLength(2)
    await afterFade()
    expect(screen.getAllByTestId('mood-scene')).toHaveLength(1)
    expect(screen.getAllByTestId('mood-particle').length).toBeGreaterThan(0)
  })

  it('keeps the scene when a reply leaves it out, or sends one out of bounds', async () => {
    await start('mood_sad')
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['换成国语歌'], scene: SCENE }))
    await flush(POLL_MS)
    await afterFade()
    fireEvent.click(within(screen.getByTestId('mood-follow-ups')).getByRole('button', { name: '换成国语歌' }))
    await flush()
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['再安静一点'], mood_tags: ['开心'] }))
    await flush(POLL_MS)
    expect(backdrop().dataset.hues).toBe('8,30,350')
    fireEvent.click(within(screen.getByTestId('mood-follow-ups')).getByRole('button', { name: '再安静一点' }))
    await flush()
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['x'], scene: { ...SCENE, pattern: 'url(https://evil.example)' } }))
    await flush(POLL_MS)
    expect(backdrop().dataset.hues).toBe('8,30,350')
    expect(screen.getAllByTestId('mood-scene')).toHaveLength(1)
  })

  it('swaps scenes at once and holds still under reduced motion', async () => {
    motion.reduced = true
    await start('mood_sad')
    api.getSlot.mockResolvedValue(reply({ picks: [], follow_ups: ['x'], scene: SCENE }))
    await flush(POLL_MS)
    expect(backdrop().dataset.look).toBe('dj')
    expect(backdrop().dataset.moving).toBe('false')
    expect(screen.getAllByTestId('mood-scene')).toHaveLength(1)
    for (const el of screen.getAllByTestId('mood-particle')) expect(el.style.animation).toBe('none')
  })

  it('pauses while the page is hidden', async () => {
    render(<MoodMusicPage />)
    await flush()
    expect(backdrop().dataset.moving).toBe('true')
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(backdrop().dataset.moving).toBe('false')
    } finally {
      state.mockRestore()
    }
  })
})
