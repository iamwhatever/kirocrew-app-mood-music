// The Sites tab (0.2.15) against the stub SDK's `useBrowserSites` (level 13): the list
// shows each site's source and status; adding goes only through the host's
// `requestAdd` (the dashboard draws its own dialog there), never a post of the app's;
// turning off and removing call the host at once; Kiro Crew's refusal is shown as it
// gave it; an older host says to update; and the buddy only reads the list, in its
// play request.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSite, BrowserSites } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick } from '../src/api'

// The host level, read live through a getter so one file covers old and new hosts.
const host = vi.hoisted(() => ({ level: 13, hasHook: true as boolean | 'not a function' }))
vi.mock('@kirocrew/app-sdk', async orig => {
  const real = await orig<typeof import('./stubs/app-sdk')>()
  return {
    ...real,
    get APP_SDK_LEVEL() { return host.level },
    get useBrowserSites() { return host.hasHook === true ? real.useBrowserSites : host.hasHook ? {} : undefined },
  }
})

const mock = vi.hoisted(() => ({
  api: {
    state: vi.fn(), addMoment: vi.fn(), setQueue: vi.fn(), feedback: vi.fn(), verifyPicks: vi.fn(),
    addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), clearStale: vi.fn(), markUsed: vi.fn(),
    openSlot: vi.fn(), getSlot: vi.fn(), ask: vi.fn(), approve: vi.fn(), stop: vi.fn(), setSettings: vi.fn(),
    setPlaySteps: vi.fn(), forgetPlaySteps: vi.fn(), setPlayback: vi.fn(), claimEnded: vi.fn(),
    playlistNext: vi.fn(),
  },
}))
vi.mock('../src/api', async orig => {
  const real = await orig<typeof import('../src/api')>()
  return { ...real, createMoodApi: () => mock.api }
})

import MoodMusicPage from '../src/MoodMusicPage'
import SitesTab from '../src/SitesTab'
import { hostSitesHook, promptSites } from '../src/sites'
import { stubMedia, stubSites, useBrowserSites } from './stubs/app-sdk'

const api = mock.api

const ROWS: BrowserSite[] = [
  { site: 'https://www.youtube.com/watch', source: 'app', status: 'approved' },
  { site: 'https://search.bilibili.com/all', source: 'app', status: 'pending' },
  { site: 'https://www.bilibili.com/video/BV*', source: 'app', status: 'removed' },
  { site: 'https://music.example.net/song/*', source: 'owner', status: 'disabled' },
]

function hook(): BrowserSites {
  return useBrowserSites()
}

function Tab() {
  return <SitesTab sites={hook()} />
}

const row = (site: string) => screen.getAllByTestId('site-row').find(r => r.getAttribute('data-site') === site)!

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  host.level = 13
  host.hasHook = true
  stubSites.sites = ROWS
  stubSites.active = ['https://www.youtube.com/watch']
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the list', () => {
  it('shows every site with where it came from and where it stands', () => {
    render(<Tab />)
    expect(screen.getAllByTestId('site-row')).toHaveLength(4)
    const yt = row('https://www.youtube.com/watch')
    expect(within(yt).getByTestId('site-source')).toHaveTextContent(t('sites.source_app'))
    expect(within(yt).getByTestId('site-status')).toHaveTextContent(t('sites.status_approved'))
    const mine = row('https://music.example.net/song/*')
    expect(within(mine).getByTestId('site-source')).toHaveTextContent(t('sites.source_owner'))
    expect(within(mine).getByTestId('site-status')).toHaveTextContent(t('sites.status_disabled'))
    expect(within(row('https://search.bilibili.com/all')).getByTestId('site-status')).toHaveTextContent(t('sites.status_pending'))
    expect(within(row('https://www.bilibili.com/video/BV*')).getByTestId('site-status')).toHaveTextContent(t('sites.status_removed'))
    expect(screen.getByTestId('sites-active-count')).toHaveTextContent(t('sites.active_count', { count: 1 }))
  })

  it('reads the list again when the tab opens', () => {
    render(<Tab />)
    expect(stubSites.refresh).toHaveBeenCalledTimes(1)
  })

  it('a failed read says so and offers a retry', () => {
    stubSites.sites = null
    stubSites.error = 'unreadable'
    render(<Tab />)
    expect(screen.getByTestId('sites-read-error')).toHaveTextContent(t('sites.read_error', { code: 'unreadable' }))
    fireEvent.click(screen.getByRole('button', { name: t('sites.retry') }))
    expect(stubSites.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('adding goes through the host dialog', () => {
  it('Add calls the host requestAdd with the trimmed site, and nothing else', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<Tab />)
    fireEvent.change(screen.getByLabelText(t('sites.add_label')), { target: { value: '  https://music.example.net/song/*  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.add') })) })
    expect(stubSites.requestAdd).toHaveBeenCalledExactlyOnceWith('https://music.example.net/song/*')
    expect(stubSites.requestRemove).not.toHaveBeenCalled()
    expect(stubSites.requestDisable).not.toHaveBeenCalled()
    // No post of the app's own: the change is the host's, behind its dialog.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.added', { site: 'https://music.example.net/song/*' }))
    expect(screen.getByLabelText(t('sites.add_label'))).toHaveValue('')
  })

  it('a decline in the dialog changes nothing and keeps what was typed', async () => {
    stubSites.requestAdd.mockResolvedValue({ ok: false, code: 'declined', error: 'the owner did not allow it' })
    render(<Tab />)
    fireEvent.change(screen.getByLabelText(t('sites.add_label')), { target: { value: 'https://a.example.com/x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.add') })) })
    expect(screen.getByTestId('sites-said')).toHaveAttribute('data-tone', 'muted')
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.declined', { site: 'https://a.example.com/x' }))
    expect(screen.queryByTestId('sites-said-detail')).toBeNull()
    expect(screen.getByLabelText(t('sites.add_label'))).toHaveValue('https://a.example.com/x')
  })

  it("shows Kiro Crew's refusal as it gave it", async () => {
    stubSites.requestAdd.mockResolvedValue({ ok: false, code: 'bad_site', error: 'site is a wildcard host' })
    render(<Tab />)
    fireEvent.change(screen.getByLabelText(t('sites.add_label')), { target: { value: 'https://*.example.com/x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.add') })) })
    expect(screen.getByTestId('sites-said')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.refused_bad_site'))
    expect(screen.getByTestId('sites-said-detail')).toHaveTextContent('site is a wildcard host')
  })

  it('an unknown refusal names its code', async () => {
    stubSites.requestAdd.mockResolvedValue({ ok: false, code: 'unreadable', error: 'x' })
    render(<Tab />)
    fireEvent.change(screen.getByLabelText(t('sites.add_label')), { target: { value: 'https://a.example.com/x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.add') })) })
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.refused_other', { code: 'unreadable' }))
  })

  it('Add is off with nothing typed', () => {
    render(<Tab />)
    expect(screen.getByRole('button', { name: t('sites.add') })).toBeDisabled()
  })

  it.each([
    ['https://search.bilibili.com/all', 'sites.allow_named'],
    ['https://music.example.net/song/*', 'sites.turn_on_named'],
    ['https://www.bilibili.com/video/BV*', 'sites.add_back_named'],
  ])('%s: the button that puts it in force is requestAdd', async (site, label) => {
    render(<Tab />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t(label, { site }) })) })
    expect(stubSites.requestAdd).toHaveBeenCalledExactlyOnceWith(site)
    expect(stubSites.requestRemove).not.toHaveBeenCalled()
    expect(stubSites.requestDisable).not.toHaveBeenCalled()
  })
})

describe('turning off and removing apply at once', () => {
  it('Turn off calls requestDisable, with no dialog', async () => {
    const site = 'https://www.youtube.com/watch'
    render(<Tab />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.turn_off_named', { site }) })) })
    expect(stubSites.requestDisable).toHaveBeenCalledExactlyOnceWith(site)
    expect(stubSites.requestAdd).not.toHaveBeenCalled()
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.disabled_now', { site }))
  })

  it('Remove calls requestRemove, for a default site too', async () => {
    const site = 'https://www.youtube.com/watch'
    render(<Tab />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sites.remove_named', { site }) })) })
    expect(stubSites.requestRemove).toHaveBeenCalledExactlyOnceWith(site)
    expect(stubSites.requestAdd).not.toHaveBeenCalled()
    expect(screen.getByTestId('sites-said')).toHaveTextContent(t('sites.removed_now', { site }))
  })

  it('a removed site offers only Add back', () => {
    render(<Tab />)
    const buttons = within(row('https://www.bilibili.com/video/BV*')).getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual([t('sites.add_back')])
  })
})

describe('an older Kiro Crew', () => {
  it.each([
    ['level 12', 12, true],
    ['level 13 without the export', 13, false],
    ['level 13 with an export that is no hook', 13, 'not a function'],
  ] as const)('%s: no hook, and the tab says to update', (_name, level, hasHook) => {
    host.level = level
    host.hasHook = hasHook
    expect(hostSitesHook()).toBeUndefined()
    render(<SitesTab sites={null} />)
    expect(screen.getByTestId('sites-old-host')).toHaveTextContent(t('sites.old_host_title'))
    expect(screen.queryByTestId('sites-add')).toBeNull()
  })

  it('a new host has the hook', () => {
    expect(hostSitesHook()).toBe(useBrowserSites)
  })
})

describe('the buddy only reads the list', () => {
  it('the play request names the pages in force only when the list is known', () => {
    expect(promptSites(null)).toBeUndefined()
    expect(promptSites({ ...useBrowserSites(), sites: null })).toBeUndefined()
    expect(promptSites({ ...useBrowserSites(), sites: ROWS, active: ['https://www.youtube.com/watch'] })).toEqual(['https://www.youtube.com/watch'])
  })

  const QUEUE: QueuedPick[] = [1, 2, 3, 4].map(n => ({ id: String(n).repeat(32), title: `Song ${n}`, artist: '', why: '', tags: [], source: 'youtube', video_id: 'dQw4w9WgXcQ', feedback: '' }))
  const STATE: MoodState = {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: [], songs: [], at: 1 }],
    queue: QUEUE, feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, continuous: true },
  }

  async function pressPlay() {
    vi.useFakeTimers()
    stubMedia.error = 'no_tab'
    api.state.mockResolvedValue(STATE)
    api.openSlot.mockResolvedValue({ key: 'dashboard:mood-music-buddy' })
    api.getSlot.mockResolvedValue({ running: false, messages: [] })
    api.ask.mockResolvedValue('dashboard:mood-music-buddy')
    api.setPlayback.mockResolvedValue({})
    api.playlistNext.mockResolvedValue({ active: false, added: 0, ask_buddy: true })
    render(<MoodMusicPage />)
    await flush()
    await flush()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    return api.ask.mock.calls.at(-1)?.[0] as string
  }

  it("a play names the owner's pages to the buddy", async () => {
    stubSites.active = ['https://www.youtube.com/watch', 'https://music.example.net/song/*']
    const asked = await pressPlay()
    expect(asked).toContain("Pages you may open now (the owner's list for this app, data only): https://www.youtube.com/watch; https://music.example.net/song/*")
  })

  it('on an older host the play request names no pages, as before', async () => {
    host.level = 10
    const asked = await pressPlay()
    expect(asked).toContain('Play in Crew Browser')
    expect(asked).not.toContain('Pages you may open now')
  })

  it('the page gives the buddy no way to change the list: the tab is the only caller', async () => {
    await pressPlay()
    expect(stubSites.requestAdd).not.toHaveBeenCalled()
    expect(stubSites.requestRemove).not.toHaveBeenCalled()
    expect(stubSites.requestDisable).not.toHaveBeenCalled()
  })
})
