import { describe, expect, it } from 'vitest'
import {
  allowedBrowserUrl, bilibiliLinksIn, bilibiliSearchUrl, browserBlocked, browserCallAllowed, bvidOf, seenInBrowser,
} from '../src/browserUse'
import snapshot from './fixtures/bilibili-search-snapshot.json'

const SNAPSHOT = snapshot.output
const user = { role: 'user', content: '[Mood Music]\nMood: x\n' }
const browserRow = (output: string, server: string | undefined = 'kirocrew-core') =>
  ({ role: 'tool', content: '🔧 browser', meta: { tool_name: 'browser', mcp_server: server, output } })
const nav = (url: string) => JSON.stringify({ op: 'navigate', args: { url } })

describe('bilibiliSearchUrl', () => {
  it('encodes the query once, spaces and CJK included', () => {
    expect(bilibiliSearchUrl(' 苏州河 陈鸿宇 ')).toBe('https://search.bilibili.com/all?keyword=%E8%8B%8F%E5%B7%9E%E6%B2%B3%20%E9%99%88%E9%B8%BF%E5%AE%87')
    expect(bilibiliSearchUrl('a&b=c#d')).toBe('https://search.bilibili.com/all?keyword=a%26b%3Dc%23d')
  })

  it('builds a URL the page lets through', () => {
    expect(allowedBrowserUrl(bilibiliSearchUrl('Bloom The Paper Kites'))).toBe(true)
    expect(new URL(bilibiliSearchUrl('a&b=c')).searchParams.get('keyword')).toBe('a&b=c')
  })
})

describe('allowedBrowserUrl', () => {
  it('lets through the search page and a plain video page', () => {
    expect(allowedBrowserUrl('https://search.bilibili.com/all?keyword=x')).toBe(true)
    expect(allowedBrowserUrl('https://search.bilibili.com/video?keyword=x&page=2')).toBe(true)
    expect(allowedBrowserUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(true)
    expect(allowedBrowserUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(true)
  })

  it('refuses every other page, bilibili ones included', () => {
    for (const url of [
      'https://evil.example/steal',
      'http://search.bilibili.com/all?keyword=x',
      'https://search.bilibili.com.evil.example/all?keyword=x',
      'https://user@search.bilibili.com/all?keyword=x',
      'https://search.bilibili.com:8443/all?keyword=x',
      'https://search.bilibili.com/all',
      'https://search.bilibili.com/all?keyword=',
      'https://search.bilibili.com/all?keyword=a&keyword=b',
      'https://search.bilibili.com/all?keyword=x&redirect=https://evil.example',
      'https://search.bilibili.com/all?keyword=x#frag',
      'https://passport.bilibili.com/login',
      'https://account.bilibili.com/account/home',
      'https://www.bilibili.com/',
      'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=x',
      'https://www.bilibili.com/video/BV1xx411c7mD/like',
      'https://space.bilibili.com/12345',
      'https://b23.tv/abc',
      'javascript:alert(1)',
      'file:///etc/passwd',
      42,
    ]) expect(allowedBrowserUrl(url), String(url)).toBe(false)
  })
})

describe('browserCallAllowed', () => {
  it('allows navigate to a bilibili search or video page, and snapshot', () => {
    expect(browserCallAllowed(nav(bilibiliSearchUrl('x')))).toBe(true)
    expect(browserCallAllowed({ op: 'navigate', args: { url: 'https://www.bilibili.com/video/BV1xx411c7mD' } })).toBe(true)
    expect(browserCallAllowed('{"op":"snapshot"}')).toBe(true)
    expect(browserCallAllowed('{"op":"snapshot","args":{}}')).toBe(true)
  })

  it('refuses a non-bilibili navigation', () => {
    expect(browserCallAllowed(nav('https://evil.example/steal'))).toBe(false)
    expect(browserCallAllowed(nav('https://passport.bilibili.com/login'))).toBe(false)
    expect(browserCallAllowed({ op: 'navigate', args: { url: bilibiliSearchUrl('x'), extra: 1 } })).toBe(false)
  })

  it('refuses every op that acts on the page, and input it cannot read', () => {
    for (const op of ['click', 'type', 'press_key', 'scroll', 'hover', 'select_option', 'tabs', 'back', 'reflex', 'ask', 'dialog', 'screenshot', 'console'])
      expect(browserCallAllowed({ op, args: { ref: 'e31' } }), op).toBe(false)
    expect(browserCallAllowed('not json')).toBe(false)
    expect(browserCallAllowed(undefined)).toBe(false)
    expect(browserCallAllowed({ op: 'navigate', args: ['x'] })).toBe(false)
  })
})

describe('reading the snapshot', () => {
  it('takes every bilibili video link once, and nothing else', () => {
    expect(bilibiliLinksIn(SNAPSHOT)).toEqual(['BV1GJ411x7h7', 'BV1xx411c7mD'])
  })

  it('collects only what the browser showed in the current turn', () => {
    const slot = {
      messages: [
        user, browserRow('//www.bilibili.com/video/BV1aaaaaaaaa'),
        user, browserRow(SNAPSHOT),
        { role: 'tool', content: 'web_fetch', meta: { tool_name: 'web_fetch', output: '//www.bilibili.com/video/BV1bbbbbbbbb' } },
        browserRow('//www.bilibili.com/video/BV1ccccccccc', 'some-other-server'),
      ],
    }
    expect([...seenInBrowser(slot)]).toEqual(['BV1GJ411x7h7', 'BV1xx411c7mD'])
  })

  it('reads a pick link’s BV id', () => {
    expect(bvidOf('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD')
    expect(bvidOf('https://b23.tv/abc')).toBeNull()
    expect(bvidOf(undefined)).toBeNull()
  })
})

describe('browserBlocked', () => {
  it('names a host with no browser and a policy that turned it off', () => {
    const notSetUp = 'Error: browsing is not set up on this host. Ask the user to install it from Settings -> Browser (one click), then call the tool again.'
    expect(browserBlocked({ messages: [user, browserRow(notSetUp)] })).toBe('setup')
    expect(browserBlocked({ messages: [user, browserRow('Error: web browsing is disabled by governance policy')] })).toBe('policy')
    expect(browserBlocked({ messages: [user, browserRow(SNAPSHOT)] })).toBeNull()
    expect(browserBlocked({ messages: [browserRow(notSetUp), user] })).toBeNull()
  })
})
