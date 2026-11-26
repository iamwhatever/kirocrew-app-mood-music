// Browser recipes (0.2.21, KiroCrew#41783, App Kit level 15): the page presses
// play with the site's play recipe and checks the song really plays, and on every
// refusal (preview off, not approved, no target, timeout, a click with no effect,
// an older host) it falls back to what 0.2.20 did: the media route's own play, and
// for a new song the buddy pressing play. Where recipes are off, one plain line
// says where to turn them on.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserMedia, BrowserMediaState } from '@kirocrew/app-sdk'
import { t } from '../src/i18n'
import type { MoodState, QueuedPick, SlotData } from '../src/api'

// The host level and its recipe route, read live so one file covers old and new hosts.
const host = vi.hoisted(() => ({
  level: 15,
  runRecipe: null as null | ((name: string) => Promise<{ ok: boolean; code?: string; step?: number }>),
}))
vi.mock('@kirocrew/app-sdk', async orig => {
  const real = await orig<typeof import('./stubs/app-sdk')>()
  // The page reads the tab fresh after a recipe: answered from the stub's media.
  const appApi = {
    request: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(),
    get: vi.fn(async () => (real.stubMedia.media ? { ok: true, media: real.stubMedia.media } : { ok: false, code: 'no_media' })),
  }
  return {
    ...real,
    get APP_SDK_LEVEL() { return host.level },
    useAppApi: () => appApi,
    useBrowserMedia: (key: string, options?: { pollMs?: number }) => {
      const media = real.useBrowserMedia(key, options)
      return host.runRecipe ? { ...media, runRecipe: host.runRecipe } : media
    },
  }
})

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
import { PAGE_PLAYS_LINE, buildPlayRequest } from '../src/request.prompt'
import { SETTLE_MS, gateOf, hintFor, playByRecipe, probeRecipes } from '../src/recipes'
import { resetStubMedia, setStubMedia, stubMedia } from './stubs/app-sdk'

const api = mock.api
const KEY = 'dashboard:mood-music-buddy'

function pick(n: number, source: QueuedPick['source'] = 'youtube'): QueuedPick {
  return { id: String(n).padStart(32, 'p'), title: `Song ${n}`, artist: `Artist ${n}`, why: `why ${n}`, tags: [], source, video_id: 'dQw4w9WgXcQ', feedback: '' }
}
const QUEUE = [pick(1), pick(2), pick(3)]

function state(queue: QueuedPick[]): MoodState {
  return {
    moments: [{ id: 'm'.repeat(32), mood: 'calm', note: '', tags: [], songs: [], at: 1 }],
    queue, feedback: [], last_source: 'r0', memory: [],
    settings: { explore: 'balanced', record_open: false, continuous: true, view_open: true },
  }
}

const block = (data: unknown) => '好。\n```mood-music\n' + JSON.stringify(data) + '\n```'
const PLAYING: BrowserMediaState = { kind: 'video', paused: false, ended: false, currentTime: 42, duration: 200, volume: 0.8, muted: false }
const PAUSED: BrowserMediaState = { ...PLAYING, paused: true }

let history: SlotData['messages'] = []
const asks = () => api.ask.mock.calls.map(c => c[0] as string)
const lastAsk = () => asks()[asks().length - 1]

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function open() {
  render(<MoodMusicPage />)
  await flush()
  await flush()
}
async function answer(data: unknown, asked = lastAsk()) {
  history = [...(history ?? []), { role: 'user', content: asked }, { role: 'assistant', content: block(data) }]
  api.getSlot.mockResolvedValue({ running: false, messages: history })
  await flush(POLL_MS)
  await flush()
}
/** The recipe route answers *answer*; an ok one starts the song when *plays*. */
function recipeAnswers(answer: { ok: boolean; code?: string }, plays = true) {
  const run = vi.fn(async (_name: string) => {
    if (answer.ok && plays && stubMedia.media) setStubMedia({ ...stubMedia.media, paused: false })
    return answer
  })
  host.runRecipe = run
  return run
}
/** A song in the tab, paused, which the buddy started earlier. */
async function pausedSong() {
  fireEvent.click(screen.getByTestId('mood-browser-play'))
  await flush()
  stubMedia.error = null
  await act(async () => { setStubMedia(PLAYING) })
  await answer({ played: true, site: 'youtube', steps: ['x'] })
  // The page's own check after the buddy's play sees the song playing.
  await flush(SETTLE_MS)
  await act(async () => { setStubMedia(PAUSED) })
  await flush()
}
const hint = () => screen.queryByTestId('mood-recipe-hint')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetStubMedia()
  window.sessionStorage.clear()
  host.level = 15
  host.runRecipe = null
  stubMedia.error = 'no_tab'
  history = []
  api.state.mockResolvedValue(state(QUEUE))
  api.openSlot.mockResolvedValue({ key: KEY })
  api.getSlot.mockResolvedValue({ running: false, messages: [] })
  api.ask.mockResolvedValue(KEY)
  api.addMoment.mockResolvedValue({ id: 'n'.repeat(32), mood: 'x', note: '', tags: [], songs: [], at: 2 })
  api.verifyPicks.mockImplementation(async (picks: unknown[]) => ({ picks, dropped: {} }))
  api.setQueue.mockResolvedValue({ queue: QUEUE })
  api.setSettings.mockResolvedValue({})
  api.setPlayback.mockResolvedValue({})
  api.setPlaySteps.mockResolvedValue({})
  api.forgetPlaySteps.mockResolvedValue({ forgotten: true })
  api.markUsed.mockResolvedValue({ marked: 0 })
  api.addMemory.mockResolvedValue({})
  api.claimEnded.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('recipe answers', () => {
  it('reads each answer as a gate', () => {
    expect(gateOf({ ok: true })).toBe('ok')
    expect(gateOf({ ok: false, code: 'preview_off' })).toBe('preview_off')
    expect(gateOf({ ok: false, code: 'recipe_not_approved' })).toBe('not_approved')
    // A host before level 15 has no `recipe` action on the media route.
    expect(gateOf({ ok: false, code: 'bad_action' })).toBe('old_host')
    expect(gateOf({ ok: false, code: 'not_declared' })).toBe('old_host')
    for (const code of ['unknown_session', 'policy_denied', 'browser_error']) expect(gateOf({ ok: false, code })).toBe('unknown')
    for (const code of ['not_found', 'hidden', 'covered', 'wait_timeout', 'wrong_site', 'no_effect']) expect(gateOf({ ok: false, code })).toBe('failed')
    expect(hintFor('preview_off')).toBe('preview_off')
    expect(hintFor('not_approved')).toBe('not_approved')
    for (const g of ['unknown', 'ok', 'old_host', 'failed'] as const) expect(hintFor(g)).toBeNull()
  })

  it('probes with no tab: an answer past the gates means recipes are on', async () => {
    const media = (run: unknown) => ({ ...stubMedia, runRecipe: run } as unknown as BrowserMedia)
    expect(await probeRecipes(media(async () => ({ ok: false, code: 'no_tab' })))).toBe('ok')
    expect(await probeRecipes(media(async () => ({ ok: false, code: 'preview_off' })))).toBe('preview_off')
    expect(await probeRecipes(media(async () => ({ ok: false, code: 'recipe_not_approved' })))).toBe('not_approved')
    expect(await probeRecipes(media(async () => { throw new Error('down') }))).toBe('unknown')
    host.level = 14
    expect(await probeRecipes(media(async () => ({ ok: true })))).toBe('old_host')
  })

  it('counts a click only when the song then plays', async () => {
    const wait = async () => undefined
    const run = vi.fn(async () => ({ ok: true }))
    const media = { ...stubMedia, runRecipe: run } as unknown as BrowserMedia
    expect(await playByRecipe(media, 'youtube', async () => PLAYING, wait)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('youtube_play')
    expect(await playByRecipe(media, 'bilibili', async () => PLAYING, wait)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('bilibili_play')
    // `ok` from the route is a script click the site may have ignored.
    expect(await playByRecipe(media, 'youtube', async () => PAUSED, wait)).toEqual({ ok: false, code: 'no_effect' })
    expect(await playByRecipe(media, 'youtube', async () => null, wait)).toEqual({ ok: false, code: 'no_effect' })
    run.mockClear()
    expect(await playByRecipe(media, 'spotify', async () => PLAYING, wait)).toEqual({ ok: false, code: 'no_recipe' })
    expect(run).not.toHaveBeenCalled()
    host.level = 14
    expect(await playByRecipe(media, 'youtube', async () => PLAYING, wait)).toEqual({ ok: false, code: 'old_host' })
  })
})

describe('the play request', () => {
  const opts = { song: { title: 'A', artist: 'B', source: 'youtube' as const }, steps: [], why: 'start' as const, state: undefined }
  it('tells the buddy to leave play to the page only when asked to', () => {
    expect(buildPlayRequest(opts)).not.toContain(PAGE_PLAYS_LINE)
    expect(buildPlayRequest({ ...opts, pagePlays: true })).toContain(PAGE_PLAYS_LINE)
  })
})

describe('play on a song in the tab', () => {
  it('presses play with the recipe, and the media route is not asked', async () => {
    const run = recipeAnswers({ ok: true })
    await open()
    await pausedSong()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush(SETTLE_MS)
    await flush()
    expect(run).toHaveBeenCalledWith('youtube_play')
    expect(stubMedia.play).not.toHaveBeenCalled()
    expect(hint()).toBeNull()
  })

  for (const [code, shown] of [
    ['preview_off', 'preview_off'],
    ['recipe_not_approved', 'not_approved'],
    ['not_found', null],
    ['wait_timeout', null],
  ] as const) {
    it(`falls back to the media route's play on ${code}`, async () => {
      const run = recipeAnswers({ ok: false, code })
      await open()
      await pausedSong()
      fireEvent.click(screen.getByTestId('mood-browser-play'))
      await flush(SETTLE_MS)
      await flush()
      expect(run).toHaveBeenCalledWith('youtube_play')
      expect(stubMedia.play).toHaveBeenCalledTimes(1)
      if (shown) {
        expect(hint()).toHaveAttribute('data-hint', shown)
        expect(hint()).toHaveTextContent(t(`browser.recipes_${shown}`))
      } else {
        expect(hint()).toBeNull()
      }
    })
  }

  it('falls back when the click ran but the song stayed paused', async () => {
    recipeAnswers({ ok: true }, false)
    await open()
    await pausedSong()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush(SETTLE_MS)
    await flush()
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
  })

  it('works as 0.2.20 on an older host: no recipe, no hint', async () => {
    host.level = 14
    const run = recipeAnswers({ ok: true })
    await open()
    await pausedSong()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush(SETTLE_MS)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
    expect(hint()).toBeNull()
    expect(lastAsk()).not.toContain(PAGE_PLAYS_LINE)
  })
})

describe('starting a new song', () => {
  it('asks once with no tab, then leaves play to the page, which presses it', async () => {
    const run = recipeAnswers({ ok: false, code: 'no_tab' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(lastAsk()).toContain(PAGE_PLAYS_LINE)
    // The buddy opened the song and stopped; the tab holds it, paused.
    run.mockImplementation(async () => {
      if (stubMedia.media) setStubMedia({ ...stubMedia.media, paused: false })
      return { ok: true }
    })
    stubMedia.error = null
    await act(async () => { setStubMedia(PAUSED) })
    await answer({ played: true, site: 'youtube', steps: ['Open the watch page'] })
    await flush(SETTLE_MS)
    await flush(SETTLE_MS)
    await flush()
    expect(run).toHaveBeenLastCalledWith('youtube_play')
    expect(stubMedia.media?.paused).toBe(false)
    expect(api.ask).toHaveBeenCalledTimes(1)
  })

  it('asks the buddy to press play when the recipe and the media route both fail', async () => {
    const run = recipeAnswers({ ok: false, code: 'no_tab' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(lastAsk()).toContain(PAGE_PLAYS_LINE)
    run.mockResolvedValue({ ok: false, code: 'covered' })
    stubMedia.error = null
    await act(async () => { setStubMedia(PAUSED) })
    await answer({ played: true, site: 'youtube', steps: ['Open the watch page'] })
    await flush(SETTLE_MS)
    await flush(SETTLE_MS)
    await flush()
    expect(stubMedia.play).toHaveBeenCalledTimes(1)
    // The 0.2.20 request: the buddy presses play itself.
    expect(api.ask).toHaveBeenCalledTimes(2)
    expect(lastAsk()).toContain('Play in Crew Browser: "Song 1"')
    expect(lastAsk()).not.toContain(PAGE_PLAYS_LINE)
  })

  it('asks without the recipe line even when the recipe answer said nothing', async () => {
    const run = recipeAnswers({ ok: false, code: 'no_tab' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    run.mockResolvedValue({ ok: false, code: 'browser_error' })
    stubMedia.error = null
    await act(async () => { setStubMedia(PAUSED) })
    await answer({ played: true, site: 'youtube', steps: ['Open the watch page'] })
    await flush(SETTLE_MS)
    await flush(SETTLE_MS)
    await flush()
    expect(api.ask).toHaveBeenCalledTimes(2)
    expect(lastAsk()).not.toContain(PAGE_PLAYS_LINE)
  })

  it('leaves a song that already plays alone', async () => {
    const run = recipeAnswers({ ok: false, code: 'no_tab' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    stubMedia.error = null
    await act(async () => { setStubMedia(PLAYING) })
    await answer({ played: true, site: 'youtube', steps: ['Open the watch page'] })
    await flush(SETTLE_MS)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(stubMedia.play).not.toHaveBeenCalled()
    expect(api.ask).toHaveBeenCalledTimes(1)
  })

  for (const [code, shown] of [['preview_off', 'preview_off'], ['recipe_not_approved', 'not_approved']] as const) {
    it(`sends the 0.2.20 request and says where to turn recipes on when ${code}`, async () => {
      recipeAnswers({ ok: false, code })
      await open()
      fireEvent.click(screen.getByTestId('mood-browser-play'))
      await flush()
      expect(lastAsk()).not.toContain(PAGE_PLAYS_LINE)
      stubMedia.error = null
      await act(async () => { setStubMedia(PLAYING) })
      await answer({ played: true, site: 'youtube', steps: ['x'] })
      expect(hint()).toHaveAttribute('data-hint', shown)
    })
  }

  it('opens the app page from the approval hint', async () => {
    recipeAnswers({ ok: false, code: 'recipe_not_approved' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    stubMedia.error = null
    await act(async () => { setStubMedia(PLAYING) })
    await answer({ played: true, site: 'youtube', steps: ['x'] })
    const { stubNavigate } = await import('./stubs/app-sdk')
    fireEvent.click(screen.getByTestId('mood-recipe-approve'))
    expect(stubNavigate).toHaveBeenCalledWith('/apps/detail/mood-music')
  })

  it('sends no recipe line for a site without one', async () => {
    api.state.mockResolvedValue(state([pick(1, 'spotify'), pick(2), pick(3)]))
    recipeAnswers({ ok: false, code: 'no_tab' })
    await open()
    fireEvent.click(screen.getByTestId('mood-browser-play'))
    await flush()
    expect(lastAsk()).toContain('Site: spotify')
    expect(lastAsk()).not.toContain(PAGE_PLAYS_LINE)
  })
})
