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
  it('reopens its temporary slot, then sends to it as the DJ agent', async () => {
    const api = fakeApi(path => (path === '/api/chat/slots' ? { key: 'mood-music' } : { ok: true }))
    await expect(createMoodApi(api).ask('[Mood Music] calm')).resolves.toBe('mood-music')
    expect(api.post).toHaveBeenNthCalledWith(1, '/api/chat/slots', { name: 'mood-music', agent: 'mood-music-dj', memory_mode: 'temporary' })
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/chat?ws=1', {
      message: '[Mood Music] calm', slot: 'mood-music', agent: 'mood-music-dj', memory_mode: 'temporary',
    })
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
