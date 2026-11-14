/**
 * Mood Music clients, over the host's permission-scoped `AppApi`: the app's own
 * storage routes, and the one chat slot the page uses to talk to its DJ agent.
 *
 * The slot is named and owned by this app, and created with
 * `memory_mode: 'temporary'`, so feelings typed here are not written into
 * Kiro Crew memory: taste lives in the app's storage and is sent with each
 * request instead (`request.prompt.ts`). The slot is (re)opened before every
 * send, because a send to a missing slot would recreate it as a plain chat.
 */
import type { AppApi } from '@kirocrew/app-sdk'
import type { Evidence, NewPick, PickArc, PickSource, PickTier } from './replyParse'
import type { ExploreLevel } from './request.prompt'

const BASE = '/api/apps/mood-music'
export const DJ_AGENT = 'mood-music-dj'
export const SLOT_NAME = 'mood-music'
const MEMORY_MODE = 'temporary'

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
}

export interface Settings {
  explore: ExploreLevel
  record_open: boolean
}

export interface SlotMessage {
  role?: string
  type?: string
  content?: string
  /** On a `permission` row: the approval's id, and `resolved` once it is answered. */
  meta?: { approval_id?: unknown; resolved?: unknown; tool_name?: unknown; tool_input?: unknown; kind?: unknown }
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

/** A send the gateway answered but refused (`{ok: false, error}` in a 2xx). */
interface SendReceipt {
  ok?: boolean
  error?: string
}

export type MoodApi = ReturnType<typeof createMoodApi>

export function createMoodApi(api: AppApi) {
  const openSlot = () =>
    api.post<{ key: string }>('/api/chat/slots', { name: SLOT_NAME, agent: DJ_AGENT, memory_mode: MEMORY_MODE })
  return {
    state: () => api.get<MoodState>(`${BASE}/state`),
    addMoment: (mood: string) => api.post<Moment>(`${BASE}/moments`, { mood }),
    setQueue: (body: { source: string; moment_id?: string; mood_tags: string[]; picks: NewPick[] }) =>
      api.post<{ queue: QueuedPick[] }>(`${BASE}/queue`, body),
    /** Look each pick up on YouTube / bilibili; only confirmed picks come back. */
    verifyPicks: (picks: NewPick[]) =>
      api.post<{ picks: NewPick[]; dropped: Record<string, number> }>(`${BASE}/verify-picks`, { picks }),
    feedback: (pickId: string, verdict: Verdict) =>
      api.put<QueuedPick>(`${BASE}/queue/${encodeURIComponent(pickId)}/feedback`, { verdict }),
    setSettings: (patch: Partial<Settings>) => api.put<Settings>(`${BASE}/settings`, patch),
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
    /** Send one turn; a refusal rejects. Returns the slot key the turn went to. */
    ask: async (message: string): Promise<string> => {
      const { key } = await openSlot()
      const receipt = await api.post<SendReceipt | undefined>('/api/chat?ws=1', {
        message, slot: key, agent: DJ_AGENT, memory_mode: MEMORY_MODE,
      })
      if (receipt && receipt.ok === false) throw new Error(receipt.error || 'send_refused')
      return key
    },
  }
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
