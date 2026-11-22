// Saved playlists (0.2.14): the tab saves the queue and liked songs, caps say so,
// rename / delete / remove call their routes; on the page, playing a list
// replaces the queue with the marker on its first song, and continuous play goes
// through the list before it asks the buddy for more, and then only when allowed.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../src/i18n'
import type { MemoryItem, MoodApi, MoodState, Playlist, Playlists, QueuedPick, SlotData } from '../src/api'

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), approve: vi.fn(), stop: vi.fn(), setSettings: vi.fn(),
    setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
    playlists: vi.fn(), createPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(),
    removePlaylistSong: vi.fn(), playPlaylist: vi.fn(), playlistNext: vi.fn(), setPlaylistThenBuddy: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage, { POLL_MS } from '../src/MoodMusicPage'
import PlaylistsTab, { defaultName, likedSongs } from '../src/PlaylistsTab'
import { setStubMedia, stubMedia } from './stubs/app-sdk'
import type { BrowserMediaState } from '@kirocrew/app-sdk'

const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }

const api = mock.api
const ID = 'dQw4w9WgXcQ'
const LIST_ID = 'a'.repeat(32)

function pick(n: number, over: Partial<QueuedPick> = {}): QueuedPick {
  return { id: String(n).repeat(32), title: `Song ${n}`, artist: `Artist ${n}`, why: '', tags: [], source: 'youtube', video_id: ID, feedback: '', ...over }
}
function liked(title: string, artist = ''): MemoryItem {
  return { id: `${title}`.padEnd(32, '0').slice(0, 32), kind: 'liked', origin: 'app', pinned: false, stale: false, created_at: 1, last_used_at: 1, title, artist }
}
function state(extra: Partial<MoodState> = {}): MoodState {
  return {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: ['平静', '温柔'], songs: [], at: 1 }],
    queue: [pick(1), pick(2), pick(3)], feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, continuous: true },
    ...extra,
  }
}
function list(over: Partial<Playlist> = {}): Playlist {
  return { id: LIST_ID, name: 'Rainy', created_at: 1, songs: [{ id: 'b'.repeat(32), title: 'Song 5', artist: 'Artist 5', tags: [], source: 'youtube' }], ...over }
}
function lists(over: Partial<Playlists> = {}): Playlists {
  return { lists: [list()], active: null, then_buddy: false, limits: { lists: 50, songs: 200 }, ...over }
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  stubMedia.error = 'no_tab'
  api.state.mockResolvedValue(state())
  api.openSlot.mockResolvedValue({ key: 'dashboard:mood-music-buddy' })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue('dashboard:mood-music-buddy')
  api.setPlayback.mockResolvedValue({})
  api.setSettings.mockResolvedValue({})
  api.addMemory.mockResolvedValue({})
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.setPlaySteps.mockResolvedValue({})
  api.playlists.mockResolvedValue(lists())
  api.createPlaylist.mockResolvedValue(list())
  api.renamePlaylist.mockResolvedValue(list())
  api.deletePlaylist.mockResolvedValue({ deleted: LIST_ID })
  api.removePlaylistSong.mockResolvedValue(list())
  api.setPlaylistThenBuddy.mockResolvedValue({ then_buddy: true })
  api.playlistNext.mockResolvedValue({ active: false, added: 0, ask_buddy: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('likedSongs and the default name', () => {
  it('keeps a queued link, gathers mood words, and plays the rest on the site that last worked', () => {
    const songs = likedSongs(state({
      memory: [liked('Song 1', 'Artist 1'), liked('苏州河', '薛凯琪'), liked(' song 1 ', 'ARTIST 1')],
      feedback: [{ pick_id: 'x', title: '苏州河', artist: '薛凯琪', tags: ['想念'], verdict: 'liked', at: 1 }],
      moments: [{ id: 'm', mood: 'x', note: '', tags: ['平静'], songs: [{ title: 'Song 1', artist: 'Artist 1' }], at: 1 }],
      play_steps: { bilibili: { steps: ['x'], updated_at: 9 }, youtube: { steps: ['y'], updated_at: 3 } },
    }))
    expect(songs.map(s => [s.title, s.source, s.video_id ?? '', s.tags])).toEqual([
      ['Song 1', 'youtube', ID, ['平静']],
      ['苏州河', 'bilibili', '', ['想念']],
    ])
  })

  it('names a list by the mood words and the date, or "Playlist" with none', () => {
    const day = new Date(2026, 10, 22)
    expect(defaultName(['平静', '温柔', '下雨'], day)).toMatch(/^平静 · 温柔 · .*22/)
    expect(defaultName([], day)).toMatch(new RegExp(`^${t('playlists.default_name')} · `))
  })
})

function renderTab(s: MoodState, onPlay = vi.fn().mockResolvedValue(undefined), busy = false) {
  render(<PlaylistsTab api={api as unknown as MoodApi} state={s} busy={busy} onPlay={onPlay} />)
  return onPlay
}

describe('the Playlists tab', () => {
  it('saves the queue in one press under the mood-and-date name', async () => {
    renderTab(state())
    await flush()
    fireEvent.click(screen.getByTestId('mood-save-queue'))
    await flush()
    const [name, songs] = api.createPlaylist.mock.calls[0]
    expect(name).toMatch(/^平静 · 温柔 · /)
    expect(songs.map((s: { title: string }) => s.title)).toEqual(['Song 1', 'Song 2', 'Song 3'])
    // The queue's own id and feedback stay behind.
    expect(songs[0]).not.toHaveProperty('id')
    expect(songs[0]).not.toHaveProperty('feedback')
    expect(screen.getByTestId('mood-save-queue-status')).toHaveTextContent(name)
  })

  it('makes a list from the liked songs a mood filter shows, or a ticked few', async () => {
    renderTab(state({
      memory: [liked('A'), liked('B'), liked('C')],
      feedback: [
        { pick_id: '1', title: 'A', artist: '', tags: ['calm'], verdict: 'liked', at: 1 },
        { pick_id: '2', title: 'C', artist: '', tags: ['calm'], verdict: 'liked', at: 1 },
      ],
    }))
    await flush()
    const form = screen.getByTestId('pl-from-liked')
    fireEvent.click(within(form).getByRole('button', { name: 'calm' }))
    fireEvent.click(within(form).getByRole('button', { name: t('playlists.pick_shown', { count: 2 }) }))
    fireEvent.click(within(form).getByRole('button', { name: t('playlists.create', { count: 2 }) }))
    await flush()
    expect(api.createPlaylist.mock.calls[0][0]).toMatch(/^calm · /)
    expect(api.createPlaylist.mock.calls[0][1].map((s: { title: string }) => s.title)).toEqual(['A', 'C'])

    fireEvent.click(within(form).getByRole('button', { name: t('playlists.all_moods') }))
    fireEvent.click(within(form).getByLabelText('B'))
    fireEvent.change(within(form).getByLabelText(t('playlists.name_label')), { target: { value: ' Just B ' } })
    fireEvent.click(within(form).getByRole('button', { name: t('playlists.create', { count: 1 }) }))
    await flush()
    expect(api.createPlaylist).toHaveBeenLastCalledWith('Just B', [expect.objectContaining({ title: 'B' })])
  })

  it('after a taste fold pruned likes, lists only what is left and says so', async () => {
    const profile = { likes: [], dislikes: [], updated_at: 1, folded: 20, pruned: 15 }
    renderTab(state({ memory: [liked('A'), liked('B')], profile }))
    await flush()
    expect(screen.getByTestId('pl-liked-folded')).toHaveTextContent(t('playlists.liked_folded', { count: 2 }))
    expect(within(screen.getByTestId('pl-liked-list')).getAllByRole('checkbox')).toHaveLength(2)
    cleanup()
    // Nothing folded yet: no note.
    renderTab(state({ memory: [liked('A')], profile: null }))
    await flush()
    expect(screen.queryByTestId('pl-liked-folded')).toBeNull()
  })

  it('says a list is too long before it is sent', async () => {
    renderTab(state({ memory: Array.from({ length: 201 }, (_, i) => liked(`S${i}`)) }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('playlists.pick_shown', { count: 201 }) }))
    expect(screen.getByTestId('pl-too-many')).toHaveTextContent(t('playlists.too_many', { count: 200 }))
    expect(screen.getByRole('button', { name: t('playlists.create', { count: 201 }) })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('S0'))
    expect(screen.queryByTestId('pl-too-many')).toBeNull()
    expect(screen.getByRole('button', { name: t('playlists.create', { count: 200 }) })).toBeEnabled()
  })

  it('says when there are too many lists, in the backend\'s words too', async () => {
    api.playlists.mockResolvedValue(lists({ lists: Array.from({ length: 50 }, (_, i) => list({ id: String(i).padStart(32, '0'), name: `L${i}` })) }))
    renderTab(state({ memory: [liked('A')] }))
    await flush()
    expect(screen.getByTestId('pl-full')).toHaveTextContent(t('playlists.error_full', { count: 50 }))
    fireEvent.click(screen.getByLabelText('A'))
    expect(screen.getByRole('button', { name: t('playlists.create', { count: 1 }) })).toBeDisabled()
    // The backend's own refusal is said in the same words.
    api.createPlaylist.mockRejectedValueOnce(Object.assign(new Error('409'), { body: '{"code":"playlists_full"}' }))
    fireEvent.click(screen.getByTestId('mood-save-queue'))
    await flush()
    expect(screen.getByTestId('mood-save-queue-status')).toHaveTextContent(t('playlists.error_full', { count: 50 }))
  })

  it('opens, renames, removes a song, and deletes only after a confirm', async () => {
    renderTab(state())
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('playlists.open', { name: 'Rainy' }) }))
    fireEvent.click(within(screen.getByTestId('pl-songs')).getByRole('button', { name: t('playlists.remove_song', { song: 'Song 5' }) }))
    await flush()
    expect(api.removePlaylistSong).toHaveBeenCalledWith(LIST_ID, 'b'.repeat(32))

    fireEvent.click(screen.getByRole('button', { name: t('playlists.rename', { name: 'Rainy' }) }))
    fireEvent.change(screen.getByLabelText(t('playlists.name_label'), { selector: '[autofocus], input:not(#pl-name)' }), { target: { value: 'Night' } })
    fireEvent.click(screen.getByRole('button', { name: t('playlists.save') }))
    await flush()
    expect(api.renamePlaylist).toHaveBeenCalledWith(LIST_ID, 'Night')

    fireEvent.click(screen.getByRole('button', { name: t('playlists.delete', { name: 'Rainy' }) }))
    expect(api.deletePlaylist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('playlists.delete_yes') }))
    await flush()
    expect(api.deletePlaylist).toHaveBeenCalledWith(LIST_ID)
  })

  it('plays a list, but not while the buddy works, and keeps the "ask the buddy" choice', async () => {
    const onPlay = renderTab(state(), undefined, true)
    await flush()
    expect(screen.getByRole('button', { name: t('playlists.play', { name: 'Rainy' }) })).toBeDisabled()
    cleanup()
    renderTab(state(), onPlay)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('playlists.play', { name: 'Rainy' }) }))
    await flush()
    expect(onPlay).toHaveBeenCalledWith(LIST_ID)
    expect(screen.getByTestId('pl-then-buddy')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('pl-then-buddy'))
    await flush()
    expect(api.setPlaylistThenBuddy).toHaveBeenCalledWith(true)
  })
})

const asks = () => api.ask.mock.calls.map(c => c[0] as string)
const REFILL = 'The queue is nearly empty'
const block = (data: unknown) => '好。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const replyTo = (asked: string, data: unknown): SlotData => ({
  running: false, messages: [{ role: 'user', content: asked }, { role: 'assistant', content: block(data) }],
})

describe('playing a list on the page', () => {
  it('replaces the queue, puts the marker on its first song and plays it', async () => {
    const fromList = [pick(5), pick(6), pick(7)]
    api.playPlaylist.mockResolvedValue({ queue: fromList })
    render(<MoodMusicPage />)
    await flush()
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: t('playlists.tab') }))
    await flush()
    api.state.mockResolvedValue(state({ queue: fromList, last_source: `playlist:${LIST_ID}:abcd1234` }))
    fireEvent.click(screen.getByRole('button', { name: t('playlists.play', { name: 'Rainy' }) }))
    await flush()
    await flush()
    expect(api.playPlaylist).toHaveBeenCalledWith(LIST_ID)
    const rows = screen.getAllByTestId('mood-queue-row')
    expect(rows.map(r => within(r).getByText(/^Song \d$/).textContent)).toEqual(['Song 5', 'Song 6', 'Song 7'])
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(rows[1]).not.toHaveAttribute('aria-current')
    expect(asks()).toHaveLength(1)
    expect(asks()[0]).toContain('Play in Crew Browser: "Song 5" - Artist 5')
    // Three songs: no refill yet, so the list was not asked for its next part.
    expect(api.playlistNext).not.toHaveBeenCalled()
  })

  it('moves the marker off a song still playing from the old queue to the list\'s first, and keeps it there once it plays', async () => {
    api.playlistNext.mockResolvedValue({ active: false, added: 0, ask_buddy: false })
    render(<MoodMusicPage />)
    await flush()
    await flush()
    // Song 1 of the old queue plays in the tab.
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    api.getSlot.mockResolvedValue(replyTo(asks()[0], { played: true, site: 'youtube', steps: ['x'] }))
    await flush(POLL_MS)
    await flush()
    await act(async () => { setStubMedia(PLAYING) })
    await flush()

    const fromList = [pick(5), pick(6), pick(7)]
    api.playPlaylist.mockResolvedValue({ queue: fromList })
    fireEvent.click(screen.getByRole('tab', { name: t('playlists.tab') }))
    await flush()
    api.state.mockResolvedValue(state({ queue: fromList, last_source: `playlist:${LIST_ID}:abcd1234` }))
    fireEvent.click(screen.getByRole('button', { name: t('playlists.play', { name: 'Rainy' }) }))
    await flush()
    await flush()
    const marked = () => screen.getAllByTestId('mood-queue-row').map(r => r.getAttribute('aria-current'))
    // The person chose this list: its first song is the one up, not the old song still in the tab.
    expect(marked()).toEqual(['true', null, null])
    expect(asks()[asks().length - 1]).toContain('Play in Crew Browser: "Song 5" - Artist 5')

    api.getSlot.mockResolvedValue(replyTo(asks()[asks().length - 1], { played: true, site: 'youtube', steps: ['open the video'] }))
    await flush(POLL_MS)
    await flush()
    expect(marked()).toEqual(['true', null, null])
    expect(api.setPlayback).toHaveBeenLastCalledWith({ pick_id: pick(5).id })
  })

  it.each([
    ['a list still playing adds its next part, and the buddy is not asked', { active: true, added: 2, ask_buddy: false }, false],
    ['a list that ran out asks the buddy only when allowed', { active: true, added: 0, ask_buddy: true }, true],
    ['no list playing refills from the buddy as before', { active: false, added: 0, ask_buddy: true }, true],
  ])('%s', async (_name, part, refills) => {
    api.state.mockResolvedValue(state({ queue: [pick(5), pick(6)], last_source: `playlist:${LIST_ID}:abcd1234` }))
    api.playlistNext.mockResolvedValue(part)
    render(<MoodMusicPage />)
    await flush()
    await flush()
    const reads = api.state.mock.calls.length
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(api.playlistNext).toHaveBeenCalledWith(pick(5).id)
    expect(asks()[0].includes(REFILL)).toBe(refills)
    // The part the list added is read back, so the queue on screen shows it.
    expect(api.state.mock.calls.length > reads).toBe(part.added > 0)
    api.getSlot.mockResolvedValue(replyTo(asks()[0], { played: true, site: 'youtube', steps: ['x'] }))
    await flush(POLL_MS)
  })
})
