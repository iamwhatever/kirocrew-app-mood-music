/**
 * Mood Music clients, over the host's permission-scoped `AppApi`: the app's own
 * storage routes, and the one chat slot the page uses to talk to its DJ agent.
 *
 * The backend opens the slot through `ctx.chat_slots` (`backend/buddy.py`), so
 * it carries this app's name: the host's live browser view, its media buttons
 * and the approved `browserSites` all key off that name. It is opened hidden
 * (`permissions.hiddenSessions`), out of Kiro Crew's session lists, and every
 * turn goes through the backend too. A host too old to open a hidden chat for an
 * app answers `old_host`, and the page says to update Kiro Crew; the chat is
 * never opened visible instead.
 */
import type { AppApi, AppApiError } from '@kirocrew/app-sdk'
import { replySource, type Evidence, type NewPick, type PickArc, type PickSource, type PickTier } from './replyParse'
import type { ExploreLevel } from './request.prompt'

const BASE = '/api/apps/mood-music'
export const DJ_AGENT = 'mood-music-dj'
/** The buddy's chat, opened by the backend (`backend/buddy.py` `BUDDY_KEY`). */
export const SLOT_NAME = 'mood-music-dj'

/** Why the backend could not open the buddy's chat: too old a host, or the host refused to hide it. */
export type BuddyRefusal = 'old_host' | 'hidden_refused'

/** The backend's refusal code in a failed buddy call, or null for any other failure. */
export function buddyRefusal(e: unknown): BuddyRefusal | null {
  const err = e as Partial<AppApiError> | null
  if (!err || typeof err.body !== 'string') return null
  try {
    const code = (JSON.parse(err.body) as { code?: unknown }).code
    return code === 'old_host' || code === 'hidden_refused' ? code : null
  } catch {
    return null
  }
}

/** Rethrow a buddy refusal as its bare code, which the page shows in plain words. */
function plainRefusal(e: unknown): never {
  const code = buddyRefusal(e)
  throw code ? new Error(code) : e
}

export type Verdict = 'liked' | 'skipped' | ''

export interface Moment {
  id: string
  mood: string
  note: string
  tags: string[]
  songs: { title: string; artist: string }[]
  at: number
}

export interface QueuedPick {
  id: string
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
  unverified?: boolean
  feedback: Verdict
}

export interface FeedbackEntry {
  pick_id: string
  title: string
  artist: string
  tags: string[]
  verdict: Exclude<Verdict, ''>
  at: number
}

export type MemoryKind = 'note' | 'liked' | 'skipped' | 'known' | 'mood'

/** One thing the buddy knows about the person (design §2). */
export interface MemoryItem {
  id: string
  kind: MemoryKind
  origin: 'user' | 'app'
  pinned: boolean
  /** Worked out by the backend: an app item unused for 90 days, or replaced. */
  stale: boolean
  created_at: number
  last_used_at: number
  text?: string
  title?: string
  artist?: string
}

export type NewMemory =
  | { kind: 'note' | 'mood'; text: string; origin?: 'user' | 'app' }
  | { kind: 'liked' | 'skipped' | 'known'; title: string; artist?: string; origin?: 'user' | 'app' }

export interface MoodState {
  moments: Moment[]
  queue: QueuedPick[]
  feedback: FeedbackEntry[]
  last_source: string
  memory: MemoryItem[]
  settings: Settings
  /** Per site, the steps that last played a song in Kiro Crew's browser. Absent on an older backend. */
  play_steps?: Partial<Record<PickSource, { steps: string[]; updated_at: number }>>
  /** The song in the buddy's tab, as the page or the backend last started it. Absent on an older backend. */
  playback?: Playback
}

/** Shared with the backend, so one song's end wakes the buddy once, page open or closed. */
export interface Playback {
  pick_id: string
  /** The song whose ending already woke the buddy. */
  ended_for: string
  paused: boolean
}

export interface Settings {
  explore: ExploreLevel
  record_open: boolean
  /** When a song ends, the buddy plays the next one. */
  continuous?: boolean
  /** The buddy's live browser box in the player column is open. Absent on an older backend. */
  view_open?: boolean
  /** Picks stay with the feeling instead of turning and lifting it. Absent until the person sets it. */
  stay_only?: boolean
}

export interface SlotMessage {
  role?: string
  type?: string
  content?: string
  /** On a `permission` row: the approval's id, and `resolved` once it is answered.
   *  On a `tool` row: `input`, the call's arguments (JSON text). */
  meta?: { approval_id?: unknown; resolved?: unknown; tool_name?: unknown; tool_input?: unknown; input?: unknown; kind?: unknown }
}

export interface SlotData {
  running?: boolean
  messages?: SlotMessage[]
}

/** The cause a 403 `session_approval_not_granted` names (App Kit api-reference). */
export type GrantCause = 'not_declared' | 'consent_pending' | 'disabled' | 'unavailable'

/** The grant cause in a refused approval, or null when it was refused for another reason. */
export function grantCause(e: unknown): GrantCause | 'other' | null {
  const err = e as { status?: unknown; body?: unknown }
  if (err?.status !== 403 || typeof err.body !== 'string') return null
  try {
    const body = JSON.parse(err.body) as { code?: unknown; cause?: unknown }
    if (body.code !== 'session_approval_not_granted') return null
    const cause = body.cause
    return cause === 'not_declared' || cause === 'consent_pending' || cause === 'disabled' || cause === 'unavailable' ? cause : 'other'
  } catch {
    return null
  }
}

export type MoodApi = ReturnType<typeof createMoodApi>

export function createMoodApi(api: AppApi) {
  const openSlot = () => api.post<{ key: string }>(`${BASE}/buddy`).catch(plainRefusal)
  return {
    state: () => api.get<MoodState>(`${BASE}/state`),
    addMoment: (mood: string) => api.post<Moment>(`${BASE}/moments`, { mood }),
    setQueue: (body: { source: string; moment_id?: string; mood_tags: string[]; picks: NewPick[]; append?: boolean }) =>
      api.post<{ queue: QueuedPick[] }>(`${BASE}/queue`, body),
    /** Look each pick up on YouTube / bilibili; only confirmed picks come back. */
    verifyPicks: (picks: NewPick[]) =>
      api.post<{ picks: NewPick[]; dropped: Record<string, number> }>(`${BASE}/verify-picks`, { picks }),
    feedback: (pickId: string, verdict: Verdict) =>
      api.put<QueuedPick>(`${BASE}/queue/${encodeURIComponent(pickId)}/feedback`, { verdict }),
    setSettings: (patch: Partial<Settings>) => api.put<Settings>(`${BASE}/settings`, patch),
    /** Keep the steps that just played a song on *site*. */
    setPlaySteps: (site: PickSource, steps: string[]) =>
      api.put<{ site: PickSource; steps: string[] }>(`${BASE}/play-steps/${site}`, { steps }),
    /** Forget *site*'s steps after they failed, so the buddy finds the way again. */
    forgetPlaySteps: (site: PickSource) =>
      api.del<{ site: PickSource; forgotten: boolean }>(`${BASE}/play-steps/${site}`),
    /** A song (re)started in the tab, or the person's pause / play. */
    setPlayback: (patch: { pick_id?: string; paused?: boolean }) => api.put<Playback>(`${BASE}/playback`, patch),
    /**
     * Claim the ending of *pickId*: only the first claim, the page's or the
     * backend's, wakes the buddy. A failed request answers true, so the page
     * keeps playing as it did before the backend could hear endings.
     */
    claimEnded: (pickId: string) =>
      api.post<{ claimed: boolean }>(`${BASE}/playback/ended`, { pick_id: pickId }).then(r => r.claimed !== false, () => true),
    addMemory: (item: NewMemory) => api.post<MemoryItem>(`${BASE}/memory`, item),
    updateMemory: (id: string, patch: { text?: string; pinned?: boolean }) =>
      api.put<MemoryItem>(`${BASE}/memory/${encodeURIComponent(id)}`, patch),
    deleteMemory: (id: string) => api.del<{ deleted: string }>(`${BASE}/memory/${encodeURIComponent(id)}`),
    clearStale: () => api.post<{ removed: number }>(`${BASE}/memory/clear-stale`),
    markUsed: (ids: string[]) => api.post<{ marked: number }>(`${BASE}/memory/used`, { ids }),
    openSlot,
    getSlot: (key: string) => api.get<SlotData>(`/api/chat/slots/${encodeURIComponent(key)}`),
    /** Answer one tool approval once: never Trust, which would approve every later call too. */
    approve: (key: string, requestId: string, action: 'approved' | 'rejected') =>
      api.post(`/api/chat/slots/${encodeURIComponent(key)}/approve`, { action, request_id: requestId }),
    stop: (key: string) => api.post(`/api/chat/slots/${encodeURIComponent(key)}/stop`),
    /**
     * Put *message* into the buddy's RUNNING turn, so it changes course now.
     * The page sends as the person, through the dashboard's own send route
     * (`POST /api/chat` with `steer`, App Kit "Host Sessions"); an app's backend
     * cannot steer. True when the gateway steered it; false when it queued it
     * behind the turn instead (the turn had just ended, or not started yet).
     */
    steer: (key: string, message: string) =>
      api.post<{ steered?: unknown }>('/api/chat?ws=1', { message, slot: key, steer: true }).then(r => r?.steered === true),
    /** Send one turn through the backend; a refusal rejects. Returns the slot key the turn went to. */
    ask: async (message: string): Promise<string> => {
      const receipt = await api.post<{ key: string }>(`${BASE}/buddy/send`, { message }).catch(plainRefusal)
      return receipt.key
    },
  }
}

/**
 * Which reply is the slot's newest: how many replies the slot holds and the
 * newest one's text, or '' with none. A new reply word for word like the last
 * one still changes it, because the count grows. The slot read carries the
 * whole history (no `limit`), so the count only grows.
 */
export function replyMark(slot: SlotData | undefined): string {
  let n = 0
  for (const m of slot?.messages ?? []) {
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) n++
  }
  return n ? `${n}:${replySource(latestReply(slot))}` : ''
}

/** Whether the slot's newest reply is still the one *baseline* named when the turn went out. */
export function sameReply(baseline: string, slot: SlotData | undefined): boolean {
  // A page saved by 0.2.6 named the reply by its text alone.
  if (baseline && !baseline.includes(':')) return replySource(latestReply(slot)) === baseline
  return replyMark(slot) === baseline
}

/** The newest assistant reply in a slot, or ''. */
export function latestReply(slot: SlotData | undefined): string {
  const msgs = slot?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content
  }
  return ''
}
