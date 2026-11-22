/**
 * Where the person was on the page, so leaving it (the full chat, the sidebar,
 * browser back, a reload) and coming back shows the same view.
 *
 * What the page shows is already durable elsewhere: the conversation is the
 * buddy's chat slot and the cards and queue are the app's storage. This keeps
 * only the view around them (tab, what is typed, which song is up, the scroll
 * positions of the page and the buddy record) and a turn still out, so its reply is read when the page is back.
 *
 * It lives in this browser tab's `sessionStorage`, under one key, capped in
 * size: it is the person's own view, gone when the tab closes, and holds no
 * secret (nothing here is not already on their screen).
 */
import { isMoodKey, parseScene, presetScene, type MoodKey, type Scene } from './moods'

export const PAGE_KEY = 'mood-music:page'
/** Larger than this, the saved view is dropped rather than stored in part. */
export const PAGE_MAX_BYTES = 8 * 1024

export type Tab = 'listen' | 'moments' | 'memory'

export interface SavedPending {
  momentId: string
  baseline: string
  memoryIds: string[]
  text: string
  stopped?: boolean
  /** Sent from the one box: its moment is kept only once its picks land, so a command is no moment. */
  say?: boolean
  /** The person's words were steered into this turn: its reply is read like a box message's. */
  steered?: boolean
  /** A play request to the buddy (Crew Browser): the song, its site, and whether it asked for more. */
  play?: { pickId: string; site: 'youtube' | 'bilibili'; refill: boolean }
}

export interface PageView {
  tab: Tab
  text: string
  chip: MoodKey | null
  stayOnly: boolean
  /** The backdrop scene on screen (`moods.ts`), checked again on load. */
  scene: Scene
  currentId: string | null
  slotKey: string | null
  scroll: number
  /** The buddy record's own scroll. */
  recordScroll?: number
  pending: SavedPending | null
  /** The queued song the Crew Browser tab plays, as the buddy last reported. */
  browserPick?: string | null
  /** The song whose end already woke the buddy, so one ending wakes it once. */
  endedFor?: string | null
}

const TABS: Tab[] = ['listen', 'moments', 'memory']
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

function readPending(v: unknown): SavedPending | null {
  const p = v as Partial<SavedPending> | null
  if (!p || typeof p !== 'object' || typeof p.baseline !== 'string') return null
  return {
    momentId: str(p.momentId, 64),
    baseline: str(p.baseline, 64),
    memoryIds: Array.isArray(p.memoryIds) ? p.memoryIds.filter(i => typeof i === 'string').slice(0, 50).map(i => i.slice(0, 64)) : [],
    text: str(p.text, 300),
    stopped: p.stopped === true || undefined,
    say: p.say === true || undefined,
    steered: p.steered === true || undefined,
    play: readPlay(p.play),
  }
}

function readPlay(v: unknown): SavedPending['play'] {
  const p = v as Partial<NonNullable<SavedPending['play']>> | null
  if (!p || typeof p !== 'object' || typeof p.pickId !== 'string') return undefined
  if (p.site !== 'youtube' && p.site !== 'bilibili') return undefined
  return { pickId: p.pickId.slice(0, 64), site: p.site, refill: p.refill === true }
}

/** The saved view, or null when there is none or it does not read. */
export function loadView(): Partial<PageView> | null {
  try {
    const raw = window.sessionStorage.getItem(PAGE_KEY)
    if (!raw || raw.length > PAGE_MAX_BYTES) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object') return null
    return {
      tab: TABS.includes(v.tab as Tab) ? (v.tab as Tab) : 'listen',
      text: str(v.text, 200),
      chip: isMoodKey(v.chip) ? v.chip : null,
      stayOnly: v.stayOnly === true,
      // A view saved before scenes carried only a chip's `look`.
      scene: parseScene(v.scene) ?? presetScene(v.look),
      currentId: typeof v.currentId === 'string' ? v.currentId.slice(0, 64) : null,
      slotKey: typeof v.slotKey === 'string' ? v.slotKey.slice(0, 200) : null,
      scroll: typeof v.scroll === 'number' && v.scroll > 0 ? v.scroll : 0,
      recordScroll: typeof v.recordScroll === 'number' && v.recordScroll > 0 ? v.recordScroll : 0,
      pending: readPending(v.pending),
      browserPick: typeof v.browserPick === 'string' ? v.browserPick.slice(0, 64) : null,
      endedFor: typeof v.endedFor === 'string' ? v.endedFor.slice(0, 64) : null,
    }
  } catch {
    return null
  }
}

/** Save the view; a full or blocked storage just means it is not kept. */
export function saveView(view: PageView): void {
  try {
    const raw = JSON.stringify(view)
    if (raw.length > PAGE_MAX_BYTES) window.sessionStorage.removeItem(PAGE_KEY)
    else window.sessionStorage.setItem(PAGE_KEY, raw)
  } catch {
    // Private mode or a full quota: the page still works, it just forgets.
  }
}
