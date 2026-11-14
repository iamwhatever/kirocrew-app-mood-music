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

export interface MoodState {
  moments: Moment[]
  queue: QueuedPick[]
  feedback: FeedbackEntry[]
  last_source: string
}

export interface SlotMessage {
  role?: string
  type?: string
  content?: string
  /** On a `permission` row: the approval's id, and `resolved` once it is answered. */
  meta?: { approval_id?: unknown; resolved?: unknown }
}

export interface SlotData {
  running?: boolean
  messages?: SlotMessage[]
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
    openSlot,
    getSlot: (key: string) => api.get<SlotData>(`/api/chat/slots/${encodeURIComponent(key)}`),
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

/**
 * Whether the DJ's turn is parked on a tool approval: an unanswered `permission`
 * row after the newest user message. The row is the one the chat's approval card
 * reads; the page cannot answer it, so it sends the person to that chat.
 */
export function awaitingApproval(slot: SlotData | undefined): boolean {
  const msgs = slot?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user') return false
    if (m.role === 'permission' && m.meta?.approval_id && !m.meta.resolved) return true
  }
  return false
}
