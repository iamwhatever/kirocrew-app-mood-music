/**
 * The one way the buddy may use Kiro Crew's `browser` tool: read bilibili search
 * pages and video pages. Nothing else.
 *
 * The browser is often the person's own Chrome, signed in to bilibili, so a
 * navigate sends their cookies. The agent prompt says "search pages only", but
 * a prompt is a request. This module is the check the page enforces: every
 * browser call the buddy makes waits for an approval (`agents/dj.json` never
 * auto-approves it), and the page declines, without asking, any call that is
 * not `navigate` to a URL from {@link allowedBrowserUrl} or a `snapshot`.
 *
 * It also reads the browser's answers in the slot: the BV ids a snapshot showed
 * (a pick whose link the buddy saw there counts as verified), and whether
 * browsing is not set up or turned off by policy (the page then says so).
 */
import type { SlotData, SlotMessage } from './api'

/** The bilibili search page the buddy opens: `?keyword=<query>`. */
export const BILIBILI_SEARCH = 'https://search.bilibili.com/all'

const BVID = '(BV[0-9A-Za-z]{10})'
const VIDEO_PATH_RE = new RegExp(`^/video/${BVID}/?$`)
/** A bilibili video link in page text: `https://`, `//` or bare host. */
const VIDEO_LINK_RE = new RegExp(`(?:https?:)?//(?:www|m)\\.bilibili\\.com/video/${BVID}`, 'g')

/** The search page for *query*, the keyword encoded once. */
export function bilibiliSearchUrl(query: string): string {
  return `${BILIBILI_SEARCH}?keyword=${encodeURIComponent(query.trim())}`
}

function plainHttps(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(raw)) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null
  } catch {
    return null
  }
}

/**
 * Whether the buddy may navigate to *raw*: the search page with exactly one
 * `keyword` (other search filters such as `page` allowed), or a
 * `www.bilibili.com/video/BV…` page with no query.
 */
export function allowedBrowserUrl(raw: unknown): boolean {
  const url = plainHttps(raw)
  if (!url || url.hash) return false
  if (url.hostname === 'search.bilibili.com') {
    if (url.pathname !== '/all' && url.pathname !== '/video') return false
    const keys = [...url.searchParams.keys()]
    return url.searchParams.getAll('keyword').length === 1
      && !!url.searchParams.get('keyword')?.trim()
      && keys.every(k => k === 'keyword' || k === 'page' || k === 'order')
  }
  if (url.hostname === 'www.bilibili.com') return VIDEO_PATH_RE.test(url.pathname) && !url.search
  return false
}

/** Whether a slot row is the browser tool of Kiro Crew's own server. */
export function isBrowserRow(m: SlotMessage): boolean {
  const meta = (m.meta ?? {}) as { tool_name?: unknown; mcp_server?: unknown }
  return meta.tool_name === 'browser' && (meta.mcp_server === undefined || meta.mcp_server === 'kirocrew-core')
}

/**
 * Whether the page lets a browser call through to the person's "Allow once":
 * `snapshot`, or `navigate` to an {@link allowedBrowserUrl}. *input* is the
 * approval's `tool_input`, a JSON string or object.
 */
export function browserCallAllowed(input: unknown): boolean {
  let call: unknown = input
  if (typeof input === 'string') {
    try {
      call = JSON.parse(input)
    } catch {
      return false
    }
  }
  if (!call || typeof call !== 'object') return false
  const { op, args } = call as { op?: unknown; args?: unknown }
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a !== 'object' || Array.isArray(a)) return false
  if (op === 'snapshot') return true
  if (op === 'navigate') return Object.keys(a).every(k => k === 'url') && allowedBrowserUrl(a.url)
  return false
}

/** The BV ids of every bilibili video link in *text*, in order, once each. */
export function bilibiliLinksIn(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(VIDEO_LINK_RE)) if (!out.includes(match[1])) out.push(match[1])
  return out
}

/** Rows after the newest `user` row: the current turn. */
function currentTurn(slot: SlotData | undefined): SlotMessage[] {
  const all = slot?.messages ?? []
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') return all.slice(i + 1)
  return all
}

function outputOf(m: SlotMessage): string {
  const out = (m.meta as { output?: unknown } | undefined)?.output
  return typeof out === 'string' ? out : out ? JSON.stringify(out) : ''
}

/** The BV ids the browser showed the buddy in the current turn. */
export function seenInBrowser(slot: SlotData | undefined): Set<string> {
  const ids = new Set<string>()
  for (const m of currentTurn(slot)) {
    if (m.role === 'tool' && isBrowserRow(m)) for (const id of bilibiliLinksIn(outputOf(m))) ids.add(id)
  }
  return ids
}

/** The BV id of a bilibili video URL, or null. */
export function bvidOf(url: string | undefined): string | null {
  const parsed = plainHttps(url)
  if (!parsed || (parsed.hostname !== 'www.bilibili.com' && parsed.hostname !== 'm.bilibili.com')) return null
  return parsed.pathname.match(VIDEO_PATH_RE)?.[1] ?? null
}

/**
 * Why the browser could not search in the current turn: `setup` (browsing is not
 * set up on this host) or `policy` (turned off by policy); null when it worked
 * or was not used. Read off the tool's own fixed refusal text.
 */
export function browserBlocked(slot: SlotData | undefined): 'setup' | 'policy' | null {
  for (const m of currentTurn(slot)) {
    if (m.role !== 'tool' || !isBrowserRow(m)) continue
    const out = outputOf(m)
    if (/browsing is disabled by governance policy/i.test(out)) return 'policy'
    if (/browsing is not set up/i.test(out)) return 'setup'
  }
  return null
}
