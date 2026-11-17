/**
 * What the page reads off the buddy's chat slot (design §1.6-1.8): the
 * conversation in the person's own words, what the buddy is doing right now,
 * and anything that needs the person (an approval, an error).
 *
 * Tool names and search words never leave this module: the status says only
 * "thinking / searching / reading / writing" and how many times. The full
 * record, with tools and URLs, is the collapsed transcript below the chat.
 */
import type { SlotData, SlotMessage } from './api'
import { replyText } from './replyParse'

export type Phase = 'thinking' | 'searching' | 'reading' | 'writing' | 'checking'

export interface BuddyStatus {
  phase: Phase
  searches: number
  pages: number
}

export interface Line {
  who: 'you' | 'buddy'
  text: string
  /** On a buddy line: the raw reply, so the page can match it to its picks. */
  reply?: string
}

/** The heads `request.prompt.ts` writes on the line after `[Mood Music]`. */
const HEADS = ['Mood', 'Answer to your question', 'More like this song', 'Follow-up']

const msgs = (slot: SlotData | undefined): SlotMessage[] => slot?.messages ?? []

/** Rows after the newest `user` row: the current turn. */
function currentTurn(slot: SlotData | undefined): SlotMessage[] {
  const all = msgs(slot)
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') return all.slice(i + 1)
  return all
}

/** 'web_search', 'web_fetch' or ''. A live row may carry only its title ("🔧 Fetch URL"). */
const toolOf = (m: SlotMessage) => {
  const name = (m.meta as { tool_name?: unknown } | undefined)?.tool_name
  const text = `${typeof name === 'string' ? name : ''} ${m.content ?? ''}`.toLowerCase()
  if (/web_fetch|fetch/.test(text)) return 'web_fetch'
  if (/web_search|search/.test(text)) return 'web_search'
  return text.trim() ? 'other' : ''
}

/** The person's own words in a request the page sent; other text is shown as typed. */
export function personText(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '[Mood Music]') return content.trim().slice(0, 300)
  const second = lines[1] ?? ''
  for (const head of HEADS) {
    if (second.startsWith(`${head}: `)) return second.slice(head.length + 2).trim()
  }
  return second.trim()
}

/**
 * The conversation as the page draws it: the person's words and, per turn, the
 * buddy's LAST reply. The notes a model writes between tool calls ("I'll search
 * first") are working steps, not the answer: they stay in the full record. A
 * turn still running shows no buddy line yet; the status line speaks for it.
 */
export function conversation(slot: SlotData | undefined): Line[] {
  const out: Line[] = []
  const all = msgs(slot)
  let last: SlotMessage | null = null
  const flush = () => {
    if (last?.content) out.push({ who: 'buddy', text: replyText(last.content), reply: last.content })
    last = null
  }
  for (const m of all) {
    if (typeof m.content !== 'string' || !m.content.trim()) continue
    if (m.role === 'user') { flush(); out.push({ who: 'you', text: personText(m.content) }) }
    else if (m.role === 'assistant') last = m
  }
  if (!slot?.running) flush()
  return out
}

/** What the buddy is doing in the running turn, or null when nothing is running. */
export function buddyStatus(slot: SlotData | undefined, checking: boolean): BuddyStatus | null {
  const turn = currentTurn(slot)
  const tools = turn.filter(m => m.role === 'tool').map(toolOf)
  const searches = tools.filter(n => n === 'web_search').length
  const pages = tools.filter(n => n === 'web_fetch').length
  if (checking) return { phase: 'checking', searches, pages }
  if (!slot?.running) return null
  const last = [...turn].reverse().find(m => m.role === 'tool' || m.role === 'streaming' || m.role === 'assistant')
  if (last?.role === 'streaming' && last.content?.trim()) return { phase: 'writing', searches, pages }
  const tool = last?.role === 'tool' ? toolOf(last) : ''
  if (tool === 'web_fetch') return { phase: 'reading', searches, pages }
  if (tool) return { phase: 'searching', searches, pages }
  return { phase: 'thinking', searches, pages }
}

export interface PendingApproval {
  id: string
  /** The site the tool wants, when its input names one. */
  host: string
}

/** The unanswered tool approval in the current turn, or null. */
export function pendingApproval(slot: SlotData | undefined): PendingApproval | null {
  for (const m of [...currentTurn(slot)].reverse()) {
    if (m.role !== 'permission') continue
    const meta = (m.meta ?? {}) as { approval_id?: unknown; resolved?: unknown; tool_input?: unknown }
    if (!meta.approval_id || meta.resolved) continue
    return { id: String(meta.approval_id), host: hostIn(meta.tool_input) }
  }
  return null
}

function hostIn(input: unknown): string {
  const text = typeof input === 'string' ? input : input ? JSON.stringify(input) : ''
  const match = text.match(/https?:\/\/([a-z0-9.-]+)/i)
  return match ? match[1].toLowerCase() : ''
}

/** A failed turn's error text (an auto-retry notice is not a failure), or ''. */
export function turnError(slot: SlotData | undefined): string {
  for (const m of [...currentTurn(slot)].reverse()) {
    if (m.role !== 'error') continue
    const kind = (m as { kind?: unknown }).kind ?? (m.meta as { kind?: unknown } | undefined)?.kind
    if (kind === 'transient_retry') continue
    return (m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  return ''
}

/** Changes whenever the slot shows any new activity; the stuck clock restarts on a change. */
export function activityKey(slot: SlotData | undefined): string {
  const all = msgs(slot)
  const last = all[all.length - 1]
  return `${all.length}:${last?.role ?? ''}:${last?.content?.length ?? 0}:${slot?.running ? 1 : 0}`
}
