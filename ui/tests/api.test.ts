import { describe, expect, it, vi } from 'vitest'
import type { AppApi } from '@kirocrew/app-sdk'
import { createMoodApi, grantCause, latestReply } from '../src/api'
import { CATALOGS } from '../src/i18n'

function fakeApi(post: (path: string, body?: unknown) => unknown): AppApi {
  return {
    request: vi.fn(), get: vi.fn(), put: vi.fn(), del: vi.fn(),
    post: vi.fn(async (path: string, body?: unknown) => post(path, body)),
  } as unknown as AppApi
}

describe('createMoodApi', () => {
  it('reopens its hidden temporary slot, then sends to it as the DJ agent', async () => {
    const api = fakeApi(path => (path === '/api/chat/slots' ? { key: 'mood-music-buddy' } : { ok: true }))
    await expect(createMoodApi(api).ask('[Mood Music] calm')).resolves.toBe('mood-music-buddy')
    expect(api.post).toHaveBeenNthCalledWith(1, '/api/chat/slots', {
      name: 'mood-music-buddy', agent: 'mood-music-dj', memory_mode: 'temporary', mode: 'mood-music',
    })
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/chat?ws=1', {
      message: '[Mood Music] calm', slot: 'mood-music-buddy', agent: 'mood-music-dj', memory_mode: 'temporary',
    })
  })

  it('falls back to the old listed chat when the host refuses the mode, and stays there', async () => {
    const refusal = Object.assign(new Error('invalid mode'), { status: 400, body: JSON.stringify({ code: 'invalid_mode' }) })
    const api = fakeApi((path, body) => {
      if (path !== '/api/chat/slots') return { ok: true }
      if ((body as { mode?: string }).mode) throw refusal
      return { key: 'mood-music' }
    })
    const mood = createMoodApi(api)
    await expect(mood.openSlot()).resolves.toEqual({ key: 'mood-music' })
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/chat/slots', { name: 'mood-music', agent: 'mood-music-dj', memory_mode: 'temporary' })
    await mood.openSlot()
    expect(api.post).toHaveBeenCalledTimes(3)
  })

  it('does not hide another failure behind the fallback', async () => {
    const other = Object.assign(new Error('nope'), { status: 403, body: JSON.stringify({ code: 'forbidden' }) })
    const api = fakeApi(() => { throw other })
    await expect(createMoodApi(api).openSlot()).rejects.toBe(other)
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('rejects a send the gateway refused inside a 2xx', async () => {
    const api = fakeApi(path => (path === '/api/chat/slots' ? { key: 'k' } : { ok: false, error: 'busy' }))
    await expect(createMoodApi(api).ask('x')).rejects.toThrow('busy')
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
