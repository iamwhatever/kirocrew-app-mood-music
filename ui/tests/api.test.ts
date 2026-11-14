import { describe, expect, it, vi } from 'vitest'
import type { AppApi } from '@kirocrew/app-sdk'
import { createMoodApi, latestReply } from '../src/api'
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

describe('catalogs', () => {
  it('give every locale the same keys as English', () => {
    const keys = (o: object, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [p + k] : keys(v, `${p}${k}.`)))
    const en = keys(CATALOGS.en).sort()
    for (const [lang, cat] of Object.entries(CATALOGS)) expect(keys(cat).sort(), lang).toEqual(en)
  })
})
