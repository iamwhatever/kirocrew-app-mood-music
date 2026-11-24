// The music sites of 0.2.18 (Spotify, Amazon Music, Apple Music, SoundCloud) live
// through a page reload like YouTube and bilibili: a held song and a pending play
// request on one of them are read back, and a site the app does not play is not.
import { afterEach, describe, expect, it } from 'vitest'
import { loadView, PAGE_KEY } from '../src/pageMemory'
import { PICK_SOURCES } from '../src/replyParse'
import { t } from '../src/i18n'

const save = (v: unknown) => window.sessionStorage.setItem(PAGE_KEY, JSON.stringify(v))
const held = (source: string) => ({ id: 'a'.repeat(32), title: 'Song', artist: 'A', why: '', source })
const pending = (site: string) => ({
  slotKey: 'k', baseline: 'b', memoryIds: [], text: '', play: { pickId: 'a'.repeat(32), site, refill: false },
})

afterEach(() => window.sessionStorage.clear())

describe('music sites in the saved view', () => {
  for (const site of ['spotify', 'amazon_music', 'apple_music', 'soundcloud']) {
    it(`reads back a song held and a play pending on ${site}`, () => {
      save({ tab: 'listen', held: held(site), pending: pending(site) })
      const v = loadView()
      expect(v?.held?.source).toBe(site)
      expect(v?.pending?.play?.site).toBe(site)
    })
  }

  it('drops a site the app does not play', () => {
    save({ tab: 'listen', held: held('netease'), pending: pending('netease') })
    const v = loadView()
    expect(v?.held).toBeNull()
    expect(v?.pending?.play).toBeUndefined()
  })

  it('names every site on the song chip', () => {
    for (const s of PICK_SOURCES) expect(t(`page.source_${s}`)).not.toBe(`page.source_${s}`)
  })
})
