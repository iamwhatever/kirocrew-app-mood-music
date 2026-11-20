import { describe, expect, it, vi } from 'vitest'
import type { AppApi } from '@kirocrew/app-sdk'
import { createMoodApi, grantCause, latestReply, replyMark, sameReply } from '../src/api'
import { replySource } from '../src/replyParse'
import { CATALOGS } from '../src/i18n'

function fakeApi(post: (path: string, body?: unknown) => unknown): AppApi {
  return {
    request: vi.fn(), get: vi.fn(), put: vi.fn(), del: vi.fn(),
    post: vi.fn(async (path: string, body?: unknown) => post(path, body)),
  } as unknown as AppApi
}

describe('createMoodApi', () => {
  const refused = (status: number, code: string) => Object.assign(new Error(`API ${status}`), { status, body: JSON.stringify({ code }) })

  it("opens the buddy's chat through the app's backend, never the chat route", async () => {
    const api = fakeApi(() => ({ key: 'mood-music-dj' }))
    await expect(createMoodApi(api).openSlot()).resolves.toEqual({ key: 'mood-music-dj' })
    expect(api.post).toHaveBeenCalledWith('/api/apps/mood-music/buddy')
  })

  it('sends one turn through the backend and answers the key it went to', async () => {
    const api = fakeApi(() => ({ ok: true, key: 'mood-music-dj', queued: false }))
    await expect(createMoodApi(api).ask('[Mood Music] calm')).resolves.toBe('mood-music-dj')
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/api/apps/mood-music/buddy/send', { message: '[Mood Music] calm' })
  })

  it.each(['old_host', 'hidden_refused'])('turns a %s refusal into its bare code', async code => {
    const api = fakeApi(() => { throw refused(code === 'old_host' ? 409 : 403, code) })
    await expect(createMoodApi(api).openSlot()).rejects.toThrow(new Error(code))
    await expect(createMoodApi(api).ask('x')).rejects.toThrow(new Error(code))
  })

  it('passes any other failure through unchanged', async () => {
    const other = refused(403, 'owner_only')
    const api = fakeApi(() => { throw other })
    await expect(createMoodApi(api).ask('x')).rejects.toBe(other)
  })
})

describe('latestReply', () => {
  it('picks the newest non-empty assistant message', () => {
    expect(latestReply({ messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }, { role: 'assistant', content: ' ' }] })).toBe('a')
    expect(latestReply(undefined)).toBe('')
  })
})

describe('grantCause', () => {
  const refused = (body: unknown, status = 403) => Object.assign(new Error('x'), { status, body: JSON.stringify(body) })
  it('reads the cause of a missing chat-control grant', () => {
    expect(grantCause(refused({ code: 'session_approval_not_granted', cause: 'not_declared' }))).toBe('not_declared')
    expect(grantCause(refused({ code: 'session_approval_not_granted', cause: 'weird' }))).toBe('other')
  })
  it('is null for any other refusal', () => {
    expect(grantCause(refused({ code: 'owner_only' }))).toBeNull()
    expect(grantCause(refused({ code: 'session_approval_not_granted' }, 500))).toBeNull()
    expect(grantCause(new Error('x'))).toBeNull()
  })
})

describe('catalogs', () => {
  it('give every locale the same keys as English', () => {
    const keys = (o: object, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [p + k] : keys(v, `${p}${k}.`)))
    const en = keys(CATALOGS.en).sort()
    for (const [lang, cat] of Object.entries(CATALOGS)) expect(keys(cat).sort(), lang).toEqual(en)
  })
})

describe('replyMark', () => {
  const said = (text: string) => ({ role: 'assistant', content: text })
  it('changes with a new reply even when its text is the same as the last', () => {
    const one = { messages: [{ role: 'user', content: 'a' }, said('Same.')] }
    const two = { messages: [...one.messages, { role: 'user', content: 'b' }, said('Same.')] }
    expect(replyMark(one)).not.toBe(replyMark(two))
    expect(sameReply(replyMark(one), two)).toBe(false)
    expect(sameReply(replyMark(two), two)).toBe(true)
    expect(replyMark({ messages: [] })).toBe('')
  })

  it('reads a baseline a 0.2.6 page saved, which named the reply by its text', () => {
    const slot = { messages: [said('Old.')] }
    expect(sameReply(replySource('Old.'), slot)).toBe(true)
    expect(sameReply(replySource('Other.'), slot)).toBe(false)
  })
})
