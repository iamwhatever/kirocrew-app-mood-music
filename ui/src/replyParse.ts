/**
 * Read the DJ agent's `mood-music` block out of a reply.
 *
 * The agent found its links on web pages, so the block is untrusted: each pick
 * is checked here with `links.ts` and reduced to the fields the page draws, a
 * bad pick is dropped, and lengths are cut to the backend's limits. Text is only
 * ever rendered as React text, never as HTML.
 */
import { bilibiliUrl, evidenceUrl, validVideoId, youtubeVideoId } from './links'

export type PickSource = 'youtube' | 'bilibili'
export type PickTier = 'anchor' | 'explore' | 'deep'
export type PickArc = 'stay' | 'turn' | 'lift'

export interface Evidence {
  url: string
  label: string
}

/** A pick as the page sends it to `POST /queue`. */
export interface NewPick {
  title: string
  artist: string
  why: string
  tags: string[]
  source: PickSource
  video_id?: string
  url?: string
  tier?: PickTier
  arc?: PickArc
  listen_for?: string
  evidence?: Evidence
  /** Set by the backend link check when YouTube / bilibili could not be asked. */
  unverified?: boolean
}

export interface DjReply {
  /** The buddy's words outside the block, cut short. */
  text: string
  question: string
  moodTags: string[]
  picks: NewPick[]
  /** Picks the block named that failed a check. */
  dropped: number
  followUps: string[]
  /** A preference the buddy offers to save; stored only if the person taps it. */
  remember: string
}

const FENCE_RE = /```mood-music[^\n]*\n([\s\S]*?)```/g
const ANY_FENCE_RE = /```[\s\S]*?(```|$)/g
const MAX_PICKS = 12
const TIERS: readonly PickTier[] = ['anchor', 'explore', 'deep']
const ARCS: readonly PickArc[] = ['stay', 'turn', 'lift']

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function tags(value: unknown, limit = 40, count = 8): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim().slice(0, limit))
    .slice(0, count)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

function evidence(raw: unknown): Evidence | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const url = evidenceUrl(r.url)
  return url ? { url, label: text(r.label, 200) } : undefined
}

function pick(raw: unknown): NewPick | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = text(r.title, 200)
  if (!title) return null
  const base: Omit<NewPick, 'source'> = { title, artist: text(r.artist, 200), why: text(r.why, 400), tags: tags(r.tags) }
  const tier = oneOf(r.tier, TIERS)
  const arc = oneOf(r.arc, ARCS)
  const listenFor = text(r.listen_for, 400)
  const ev = evidence(r.evidence)
  if (tier) base.tier = tier
  if (arc) base.arc = arc
  if (listenFor) base.listen_for = listenFor
  if (ev) base.evidence = ev
  // `platform` is a spelling the model has used for `source`; the checks are the same.
  const source = r.source ?? r.platform
  if (source === 'youtube') {
    const id = r.video_id !== undefined ? validVideoId(r.video_id) : youtubeVideoId(r.url)
    return id ? { ...base, source: 'youtube', video_id: id } : null
  }
  if (source === 'bilibili') {
    const url = bilibiliUrl(r.url)
    return url ? { ...base, source: 'bilibili', url } : null
  }
  return null
}

/** Picks in arc order (stay, turn, lift), a pick with no arc after them; ties keep their order. */
function byArc(picks: NewPick[]): NewPick[] {
  const rank = (p: NewPick) => (p.arc ? ARCS.indexOf(p.arc) : ARCS.length)
  if (!picks.some(p => p.arc)) return picks
  return picks.map((p, i) => [p, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p)
}

/** The LAST `mood-music` block in *content*, or null when there is none that parses. */
export function parseDjReply(content: string): DjReply | null {
  const blocks = [...content.matchAll(FENCE_RE)]
  const last = blocks[blocks.length - 1]
  if (!last) return null
  let data: unknown
  try {
    data = JSON.parse(last[1])
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const rawPicks = Array.isArray(d.picks) ? d.picks.slice(0, MAX_PICKS) : []
  const picks = rawPicks.map(pick).filter((p): p is NewPick => p !== null)
  return {
    text: replyText(content),
    question: text(d.question, 300),
    moodTags: tags(d.mood_tags ?? d.moods),
    picks: byArc(picks),
    dropped: rawPicks.length - picks.length,
    followUps: tags(d.follow_ups, 40, 3),
    remember: text(d.remember, 60),
  }
}

/** The reply's prose: every fenced block removed, cut to a short paragraph. */
export function replyText(content: string): string {
  return content.replace(ANY_FENCE_RE, '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** A short stable id for a reply, so the page queues each reply once. */
export function replySource(content: string): string {
  let h = 0
  for (let i = 0; i < content.length; i++) h = ((h << 5) - h + content.charCodeAt(i)) | 0
  return `r${(h >>> 0).toString(36)}-${content.length}`
}
