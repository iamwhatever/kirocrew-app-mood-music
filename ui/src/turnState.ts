/**
 * What the page reads off the buddy's chat slot (design §1.6-1.8): the
 * conversation in the person's own words, what the buddy is doing right now,
 * and anything that needs the person (an approval, an error).
 *
 * Tool names and search words never leave this module: the status says only
 * "thinking / searching / reading / writing" and how many times, and each turn's
 * steps are plain kinds ("searched", "read a page", "clicked") and the notes
 * the buddy wrote between them, always shown in the record with the
 * conversation. Tool names and URLs stay in the full chat.
 */
import type { SlotData, SlotMessage } from './api'
import { replyText } from './replyParse'

export type Phase = 'thinking' | 'searching' | 'reading' | 'writing' | 'checking' | 'playing'

export interface BuddyStatus {
  phase: Phase
  searches: number
  pages: number
}

/** What one tool call did, in the person's words; never the tool's own name. */
export type StepKind =
  | 'search' | 'read' | 'open' | 'click' | 'type' | 'look' | 'scroll' | 'wait' | 'back' | 'tab' | 'key' | 'browser' | 'other'
  | 'note'

/** A run of the same kind of step, in order. A `note` is the buddy's own words between steps. */
export interface Step {
  kind: StepKind
  count: number
  /** On a `note`: what the buddy wrote, fenced blocks removed. */
  text?: string
}

export interface Line {
  who: 'you' | 'buddy'
  text: string
  /** On a buddy line: the raw reply, so the page can match it to its picks. */
  reply?: string
  /** On a buddy line: what it did in that turn before replying. */
  steps?: Step[]
  /** On a person's line: put into the buddy's running turn (a steer). */
  steered?: boolean
}

/** The heads `request.prompt.ts` writes on the line after `[Mood Music]`. */
const HEADS = ['Message', 'Mood', 'Answer to your question', 'More like this song', 'Follow-up', 'Play in Crew Browser', 'More songs']

const msgs = (slot: SlotData | undefined): SlotMessage[] => slot?.messages ?? []

/** A person's row the gateway put into a running turn: it starts no turn of its own. */
const isSteer = (m: SlotMessage) => m.role === 'user' && m.meta?.steer === true

/**
 * A steer row the transcript does not draw: its own turn wrote a fresh row
 * (`superseded`), or it was taken back (`retracted`).
 */
const hiddenSteer = (m: SlotMessage) => isSteer(m) && (m.meta?.steerState === 'superseded' || m.meta?.steerState === 'retracted')

/** Rows after the newest `user` row that started a turn: the current turn. */
function currentTurn(slot: SlotData | undefined): SlotMessage[] {
  const all = msgs(slot)
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user' && !isSteer(all[i])) return all.slice(i + 1)
  return all
}

/** 'web_search', 'web_fetch' or ''. A live row may carry only its title ("🔧 Fetch URL"). */
const toolOf = (m: SlotMessage) => {
  const name = (m.meta as { tool_name?: unknown } | undefined)?.tool_name
  const text = `${typeof name === 'string' ? name : ''} ${m.content ?? ''}`.toLowerCase()
  if (/browser/.test(text)) return 'browser'
  if (/web_fetch|fetch/.test(text)) return 'web_fetch'
  if (/web_search|search/.test(text)) return 'web_search'
  return text.trim() ? 'other' : ''
}

/** The browser tool's ops, as the step the person sees. */
const BROWSER_OPS: Record<string, StepKind> = {
  navigate: 'open', click: 'click', type: 'type', snapshot: 'look', screenshot: 'look',
  scroll: 'scroll', wait_for: 'wait', back: 'back', tabs: 'tab', press_key: 'key',
}

/** The `op` a browser call's input names: an object, or the JSON text a row carries. */
function browserOp(m: SlotMessage): string {
  const meta = m.meta ?? {}
  for (const raw of [meta.input, meta.tool_input]) {
    let input = raw
    if (typeof input === 'string') {
      try { input = JSON.parse(input) } catch { continue }
    }
    const op = (input as { op?: unknown } | null)?.op
    if (typeof op === 'string') return op
  }
  return ''
}

function stepOf(m: SlotMessage): StepKind | null {
  const tool = toolOf(m)
  if (tool === 'web_search') return 'search'
  if (tool === 'web_fetch') return 'read'
  if (tool === 'browser') return BROWSER_OPS[browserOp(m)] ?? 'browser'
  return tool ? 'other' : null
}

/** Longest note shown in the record. */
const NOTE_CHARS = 200

/**
 * The tool rows and the buddy's notes in *rows* as steps, in order; a run of
 * one tool kind folds into one step with its count.
 */
export function stepsOf(rows: SlotMessage[]): Step[] {
  const out: Step[] = []
  for (const m of rows) {
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? replyText(m.content).slice(0, NOTE_CHARS) : ''
      if (text) out.push({ kind: 'note', count: 1, text })
      continue
    }
    if (m.role !== 'tool') continue
    const kind = stepOf(m)
    if (!kind) continue
    const last = out[out.length - 1]
    if (last?.kind === kind) last.count += 1
    else out.push({ kind, count: 1 })
  }
  return out
}

/**
 * Whether the newest steer of *words* was not read by its turn: the turn
 * ended first, so the gateway runs the words as a turn of their own.
 */
export function steerRequeued(slot: SlotData | undefined, words: string): boolean {
  const all = msgs(slot)
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (!isSteer(m) || typeof m.content !== 'string' || personText(m.content) !== words) continue
    return m.meta?.steerState === 'requeued' || m.meta?.steerState === 'superseded'
  }
  return false
}

/** What the running turn has done so far. */
export function liveSteps(slot: SlotData | undefined): Step[] {
  return slot?.running ? stepsOf(currentTurn(slot)) : []
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
 * first") are working steps, not the answer: they show among that turn's steps.
 * A turn still running shows no buddy line yet; its live steps speak for it.
 */
export function conversation(slot: SlotData | undefined): Line[] {
  const out: Line[] = []
  const all = msgs(slot)
  let last: SlotMessage | null = null
  let turn: SlotMessage[] = []
  const flush = () => {
    if (last?.content) out.push({ who: 'buddy', text: replyText(last.content), reply: last.content, steps: stepsOf(turn) })
    last = null
    turn = []
  }
  for (const m of all) {
    if (m.role === 'tool') {
      // A reply followed by more steps was a note on the way, not the answer.
      if (last) { turn.push(last); last = null }
      turn.push(m)
      continue
    }
    if (typeof m.content !== 'string' || !m.content.trim() || hiddenSteer(m)) continue
    if (isSteer(m)) {
      // Words put into the running turn: the turn goes on, so a note before them stays a step.
      if (last) { turn.push(last); last = null }
      const into = m.meta?.steerState !== 'requeued'
      out.push({ who: 'you', text: personText(m.content), ...(into ? { steered: true } : {}) })
    } else if (m.role === 'user') { flush(); out.push({ who: 'you', text: personText(m.content) }) }
    else if (m.role === 'assistant') {
      if (last) turn.push(last)
      last = m
    }
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
  if (tool === 'browser') return { phase: 'playing', searches, pages }
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
