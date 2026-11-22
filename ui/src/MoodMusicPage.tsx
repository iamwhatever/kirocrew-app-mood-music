/**
 * MoodMusicPage — talk to your music buddy, hear songs with the same feeling.
 *
 * The Listen tab is a conversation with the buddy (design §1.6). Its left
 * column is the buddy's record, always open: the person's words, every step
 * the buddy takes in plain words (searched, read a page, opened, clicked) and
 * the notes it writes on the way, its one or two sentences, and its picks as
 * song cards, newest at the bottom, with a status line that never names a
 * tool. Under it is the one box: a feeling ("this one makes me cry") and a
 * command ("next", "play Suzhou River") go in the same box and the same
 * conversation, and the buddy reads which it is. A command comes back as an
 * `action` the page runs with the player's own code. The player, the live view
 * and the queue sit beside it, and their buttons drive the browser tab directly,
 * never through the box. Moments and Memory are the other tabs.
 *
 * The page talks to the buddy through one app-owned chat slot (`api.ts`). The
 * App SDK gives an app bundle no slot push of its own (only `ChatEmbed` reads
 * it), so this page polls the slot while a turn runs. A finished reply's
 * `mood-music` block is read (`replyParse.ts`), every pick is looked up by the
 * backend (`/verify-picks`), and only what passed is queued and drawn.
 *
 * Songs play only in Kiro Crew's browser (`crewBrowser.ts`). A play goes to
 * the buddy as one request: it finds the song on its site in Kiro Crew's
 * browser and reports the steps that worked, which the app keeps per site and
 * sends back next time. A song picked while a turn runs is steered into that
 * turn (`api.ts` `steer`), so the buddy switches at once instead of after it.
 * Words typed in the box while a turn runs are steered in the same way and
 * marked "cut in"; words the turn did not take are never queued (`steerIn`).
 * Pause, seek and volume go straight to the tab. With
 * continuous play on, a song's end (read by this page's poll) wakes the buddy
 * once for the next song, and asks for more when the queue runs low. The
 * backend hears endings too, with the page closed (`backend/playback.py`): each
 * ending is claimed once through `/playback/ended`, so only one side wakes the
 * buddy, and the page follows a song the backend started. A host
 * without the seam, sites the owner has not approved, or a policy that turns the
 * browser off, show a note with what to do, and the play button stays off.
 *
 * Anything that needs the person shows here with a button (design §1.8): a
 * tool approval (allow once / don't), a missing chat-control grant, a failed
 * turn, a turn that went quiet, a lost connection, and a reply with nothing
 * playable left.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from 'react'
import { ArrowDown, CornerDownRight, ExternalLink, Headphones, MessageCircleQuestion, Play, Send, ShieldCheck, Square, TriangleAlert, Volume2, Waves, WifiOff } from 'lucide-react'
import { useAppApi, useChatLauncher, useNavigate } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice, PageHeader, SegmentedControl } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { createMoodApi, grantCause, latestReply, replyMark, sameReply, type GrantCause, type MoodState, type QueuedPick, type Verdict } from './api'
import Banner from './Banner'
import BrowserControls from './BrowserControls'
import BrowserView from './BrowserView'
import BuddySteps from './BuddySteps'
import { APPROVE_PATH, endedBetween, hostBrowserView, readiness, stillEnded, useCrewBrowser } from './crewBrowser'
import type { BrowserMedia } from '@kirocrew/app-sdk'
import MemoryTab from './MemoryTab'
import MomentsTab from './MomentsTab'
import MoodBackdrop from './MoodBackdrop'
import { MOOD_KEYS, moodLookFor, presetScene, type MoodKey, type MoodLook, type Scene } from './moods'
import NowPlaying from './NowPlaying'
import { REFILL_AT, buildPlayRequest, buildRequest, memorySummary, type ExploreLevel } from './request.prompt'
import { parseDjReply, replySource, type DjReply, type ReplyAction } from './replyParse'
import { usePrefersReducedMotion } from './reducedMotion'
import { CARD_STYLE } from './cardStyle'
import SongCard from './SongCard'
import { activityKey, buddyStatus, conversation, liveSteps, pendingApproval, steerRequeued, turnError, type BuddyStatus } from './turnState'
import { loadView, saveView, type PageView, type SavedPending, type Tab } from './pageMemory'

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '')

type Kind = 'say' | 'answer' | 'more' | 'follow'

/** Poll cadence while the buddy works. */
export const POLL_MS = 1000
/** How many state reads the page makes, one per POLL_MS, waiting for a song the backend started. */
export const FOLLOW_READS = 120
/** No new activity for this long: the page says the buddy may be stuck (design §1.8). */
export const STUCK_MS = 2 * 60_000
/** How many times the page tries to tell the backend which song plays. */
export const PLAYBACK_TRIES = 3
/** Readings of the tab playing after the person's pause, this long after it, mean they played it on the site. */
export const RESUME_GRACE_MS = 3000
/** Failed reads for this long: the page says it cannot reach Kiro Crew. */
export const OFFLINE_MS = 10_000

/** A turn out to the buddy. `memoryIds`: memory items the request carried, marked used if its picks land. */
type Pending = SavedPending

const MOOD_LABELS = {
  calm: 'page.mood_calm',
  sad: 'page.mood_sad',
  happy: 'page.mood_happy',
  missing: 'page.mood_missing',
  fired: 'page.mood_fired',
} as const satisfies Record<MoodKey, string>

const moodLabel = (key: MoodKey) => t(MOOD_LABELS[key])

/**
 * The Listen tab uses the page's whole width. Wide enough, it is two columns:
 * the chat on the left, and on the right the buddy's browser on top with the
 * player and the queue under it. The page itself does not scroll: on the left
 * the record scrolls, on the right only the queue does (never the column around
 * it, so the queue's last row is never pushed below the window). On a wide right
 * column the player and the queue sit side by side. A window too short for all
 * of it, and a narrow page (one column), scroll as one with no inner queue
 * scroll. Container queries, so the layout follows the page's own size (the
 * Crew sidebar takes part of the window), not the window's.
 */
export const SPLIT_CSS = `
.mm-root { container: mm-page / inline-size; }
.mm-listen { display: grid; gap: 1.25rem; grid-template-columns: minmax(0, 1fr); align-items: start; width: 100%; max-width: 1760px; margin: 0 auto; }
.mm-player { container-type: inline-size; }
.mm-deck { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr); align-items: start; }
/* The live view: tall enough to watch, short enough to leave the player and queue in view. */
.mm-view-body { display: flex; flex-direction: column; height: clamp(14rem, 42vh, 30rem); }
.mm-view-body > * { flex: 1; min-height: 0; }
/* The queue: rows that wrap rather than cut off. One column: the page scrolls, the queue does not. */
.mm-queue-list { padding-right: 0.25rem; }
.mm-queue-num { flex: none; width: 1.25rem; padding-top: 0.125rem; display: inline-flex; justify-content: center; }
.mm-clamp2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
/* The buddy's record scrolls on its own. No scroll anchoring: the page itself follows new rows. */
.mm-record { overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none; min-height: 14rem; max-height: min(60vh, 36rem); }
/* A new row rises in; a press gives at once. Transform and opacity only. */
@keyframes mm-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.mm-row, .mm-step { animation: mm-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.mm-press { transition: transform 100ms ease-out, background-color 150ms ease-out; }
.mm-press:active { transform: scale(0.97); }
/* A turn's folded steps: the chevron turns as the row opens. */
.mm-chevron { transition: transform 150ms ease-out; }
.mm-chevron[data-open="true"] { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
  .mm-row, .mm-step { animation: none; }
  .mm-press, .mm-press:active { transition: none; transform: none; }
  .mm-chevron { transition: none; }
}
@container mm-page (min-width: 860px) {
  div.mm-scroll.mm-split { overflow: hidden; display: flex; flex-direction: column; padding-bottom: 0; }
  .mm-split > .mm-listen { flex: 1; min-height: 0; grid-template-columns: minmax(320px, 5fr) minmax(0, 7fr); align-items: stretch; }
  /* The left column holds still: the record fills it and scrolls, the box stays at its foot. */
  .mm-col { min-height: 0; overflow: hidden; padding-bottom: 1.5rem; }
  .mm-record-card { flex: 1; }
  .mm-record { flex: 1; min-height: 0; max-height: none; }
  /* The right column holds still and fills the height. Only the queue scrolls: the
     player keeps its own height, the live view gives way first, the queue takes the rest. */
  .mm-split > .mm-listen { grid-template-rows: minmax(0, 1fr); container: mm-cols / size; }
  .mm-player { min-height: 0; overflow: hidden; padding-bottom: 1.5rem; }
  .mm-view { flex: 0 1 auto; min-height: 0; }
  .mm-view-open { min-height: 9rem; }
  .mm-view .mm-view-body { height: auto; flex: 0 1 clamp(14rem, 42vh, 30rem); min-height: 0; }
  .mm-deck { flex: 1 1 0; grid-template-rows: auto minmax(0, 1fr); align-items: stretch; }
  .mm-deck > :first-child { align-self: start; }
  .mm-upnext { min-height: 0; }
  /* contain: size keeps the rows from stretching the column; the list fills what is left. */
  .mm-queue-list { flex: 1 1 0; min-height: 10rem; overflow-y: auto; overscroll-behavior: contain; contain: size; }
}
/* Columns too short to hold the player, a 10rem queue and (when open) the smallest
   live view: the right column scrolls as one and the queue shows every row, so
   there is still one scroll. Hiding the live view lowers the bar.
   shortcut: 48rem / 42rem assume a now-playing card of about 24rem; raise them if
   that card grows. */
@container mm-cols (max-height: 48rem) {
  .mm-player.mm-player-view { overflow-y: auto; overflow-anchor: none; }
  .mm-player-view .mm-view, .mm-player-view .mm-deck { flex: none; }
  .mm-player-view .mm-view .mm-view-body { flex: none; height: clamp(14rem, 42vh, 30rem); }
  .mm-player-view .mm-queue-list { flex: none; min-height: 0; overflow: visible; contain: none; }
}
@container mm-cols (max-height: 42rem) {
  .mm-player { overflow-y: auto; overflow-anchor: none; }
  .mm-view, .mm-deck { flex: none; }
  .mm-queue-list { flex: none; min-height: 0; overflow: visible; contain: none; }
}
@container (min-width: 720px) {
  .mm-deck { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
}
`

/** Whether the tab still has a song on (playing or paused mid-way); unknown until a reading says otherwise. */
const songOn = (b: BrowserMedia) => (b.media ? !stillEnded(b.media) : b.error !== 'no_tab' && b.error !== 'no_media')

const songKey = (title = '', artist = '') => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`

function statusText(s: BuddyStatus): string {
  switch (s.phase) {
    case 'searching': return t('chat.status_searching', { count: s.searches })
    case 'reading': return t('chat.status_reading', { count: s.pages })
    case 'writing': return t('chat.status_writing')
    case 'checking': return t('chat.status_checking')
    case 'playing': return t('chat.status_playing')
    default: return t('chat.status_thinking')
  }
}

const GRANT_STEPS: Record<GrantCause | 'other', string> = {
  not_declared: 'chat.grant_not_declared',
  consent_pending: 'chat.grant_consent',
  disabled: 'chat.grant_disabled',
  unavailable: 'chat.grant_unavailable',
  other: 'chat.grant_consent',
}

export default function MoodMusicPage() {
  const reduceMotion = usePrefersReducedMotion()
  const appApi = useAppApi()
  const moodApi = useMemo(() => createMoodApi(appApi), [appApi])
  const { openChat } = useChatLauncher()
  const navigate = useNavigate()
  // Where the person was when they last left the page (`pageMemory.ts`).
  const [saved] = useState(loadView)
  const [tab, setTab] = useState<Tab>(saved?.tab ?? 'listen')
  const [state, setState] = useState<MoodState | undefined>()
  // Kept in state so the full record repaints when the slot opens.
  const [slotKey, setSlotKey] = useState<string | null>(null)
  const [stayOnly, setStayOnly] = useState(saved?.stayOnly ?? false)
  const [slot, setSlot] = useState<import('./api').SlotData | undefined>()
  const [text, setText] = useState(saved?.text ?? '')
  const [chip, setChip] = useState<MoodKey | null>(saved?.chip ?? null)
  // A player command the buddy read from the box, run once the turn is over.
  const [action, setAction] = useState<{ kind: ReplyAction; pickId?: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The backdrop scene: a chip's preset, or the one the buddy chose on a big mood shift.
  const [scene, setScene] = useState<Scene>(saved?.scene ?? presetScene('neutral'))
  const [currentId, setCurrentId] = useState<string | null>(saved?.currentId ?? null)
  const [motionPaused, setMotionPaused] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [checking, setChecking] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [offline, setOffline] = useState(false)
  const [grant, setGrant] = useState<GrantCause | 'other' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnFailed, setTurnFailed] = useState('')
  const [droppedAll, setDroppedAll] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [dismissedRemember, setDismissedRemember] = useState('')
  // The song the Crew Browser tab plays, and the one whose end already woke the buddy.
  const [browserPick, setBrowserPick] = useState<string | null>(saved?.browserPick ?? null)
  const [endedFor, setEndedFor] = useState<string | null>(saved?.endedFor ?? null)
  const endedForRef = useRef(endedFor)
  // The song still playing in the tab after the buddy replaced the list it came
  // from: it is in no queue now, so the page keeps it to show until it ends.
  const [held, setHeld] = useState<QueuedPick | null>(saved?.held ?? null)
  const browserPickRef = useRef(browserPick)
  browserPickRef.current = browserPick
  // Set by the person's pause: no song end wakes the buddy until they press play.
  const stoppedRef = useRef(false)
  // Set once the saved view is applied; nothing is saved before, so a page
  // still loading never writes its empty first frame over it.
  const [restored, setRestored] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const recordRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(saved?.scroll ?? 0)
  const recordScrollRef = useRef(saved?.recordScroll ?? 0)
  // The record follows new rows while the person is at its bottom; scrolled up, it stays put.
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const slotRef = useRef<string | null>(null)
  const momentRef = useRef<string>('')
  // The last request sent, so a reply the page could not use can be asked again.
  const lastAskRef = useRef<string>('')
  const lastShownRef = useRef<string>('')
  // Memory ids behind the queue on screen; marked used once its picks land.
  const queueMemoryRef = useRef<string[]>([])
  const chipRef = useRef<MoodKey | null>(null)
  chipRef.current = chip

  const refresh = useCallback(async () => { setState(await moodApi.state()) }, [moodApi])

  useEffect(() => {
    let live = true
    moodApi.state().then(async s => {
      if (!live) return
      setState(s)
      // "Stay only" is kept with the backend, so a refill with the page closed
      // follows it. One set before it was kept there is handed over once.
      const stored = s.settings?.stay_only
      if (typeof stored === 'boolean') setStayOnly(stored)
      else if (saved?.stayOnly) void moodApi.setSettings({ stay_only: true }).catch(() => undefined)
      // Someone who talked to the buddy before sees that conversation again:
      // the slot holds it, so it is read back, not kept a second time.
      const out = saved?.pending
      if (s.last_source || s.moments.length || saved?.slotKey || out) {
        const { key } = await moodApi.openSlot()
        if (!live) return
        slotRef.current = key
        setSlotKey(key)
        const read = await moodApi.getSlot(key).catch(() => undefined)
        if (!live) return
        setSlot(read)
        // A turn still out when the person left: wait on it again, so its live
        // status shows and its reply is read. One whose reply the page already
        // queued, or that ended with nothing new, is over. One sent to another
        // chat (the listed one, before the move to the hidden chat) is not read here.
        if (out && (!saved?.slotKey || saved.slotKey === key)) {
          const source = replySource(latestReply(read))
          if (!read || read.running || turnError(read) || (!sameReply(out.baseline, read) && source !== s.last_source)) {
            momentRef.current = out.momentId
            setPending(out)
          }
        }
      }
      setRestored(true)
    }).catch(e => { if (live) setError(errMessage(e) || 'load_failed') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodApi])

  const view: PageView = { tab, text, chip, stayOnly, scene, currentId, slotKey, scroll: 0, pending, browserPick, endedFor, held }
  const viewRef = useRef(view)
  viewRef.current = view
  const persist = useCallback(() => {
    if (restored) saveView({ ...viewRef.current, scroll: scrollTopRef.current, recordScroll: recordScrollRef.current })
  }, [restored])
  const onScrolled = (e: UIEvent<HTMLElement>) => {
    // Only the page's own scroll: the record's scroll events bubble up here too.
    if (e.target !== e.currentTarget) return
    scrollTopRef.current = e.currentTarget.scrollTop
    persist()
  }
  /** Whether *el* is scrolled to (near) its bottom. */
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 32
  const onRecordScrolled = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    // Moving up is the person reading back; reaching the bottom follows again.
    // A smooth scroll on its way down changes neither.
    if (nearBottom(el)) stickRef.current = true
    else if (el.scrollTop < recordScrollRef.current) stickRef.current = false
    recordScrollRef.current = el.scrollTop
    setAtBottom(stickRef.current)
    persist()
  }
  useEffect(persist, [persist, tab, text, chip, stayOnly, scene, currentId, slotKey, pending, browserPick, endedFor, held])

  // Back where they were on the page, once what it shows is drawn again.
  useEffect(() => {
    if (!restored) return
    if (scrollTopRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollTopRef.current
    const record = recordRef.current
    if (record && recordScrollRef.current) {
      record.scrollTop = recordScrollRef.current
      stickRef.current = nearBottom(record)
      setAtBottom(stickRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored])

  const queue = state?.queue ?? []
  const queueRef = useRef(queue)
  queueRef.current = queue
  // A new song in the tab ends the old list's song.
  useEffect(() => {
    if (held && browserPick !== held.id) setHeld(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserPick])
  const explore: ExploreLevel = state?.settings?.explore ?? 'balanced'
  const viewOpen = state?.settings?.view_open ?? true
  // The host's live view of the buddy's tab (level 11); absent on an older host.
  // `stayLive`: when a turn ends with the tab still open, the host streams it
  // again instead of folding to a "Show live page" button, so the person keeps
  // watching the song play. A host without the prop ignores it and folds.
  const HostView = hostBrowserView()
  const continuous = state?.settings?.continuous ?? true
  // The Crew Browser player. Polled from the first play request on, so the page
  // sees the song in the tab even when the buddy's reply could not be read; read
  // once otherwise, which is how the page learns whether it can play here at all.
  const onEndedRef = useRef<() => void>(() => undefined)
  const crew = useCrewBrowser(slotKey ?? '', !!browserPick || !!pending?.play, () => onEndedRef.current())
  const crewMediaRef = useRef(crew.media)
  crewMediaRef.current = crew.media
  const crewRef = useRef(crew)
  crewRef.current = crew
  const browserReady = readiness(crew)
  // `unknown` (no answer about this chat yet) still lets a play go out: the buddy
  // then says what went wrong, so nothing waits in silence.
  const browserMode = browserReady === 'ready' || browserReady === 'unknown'

  const saveSettings = (patch: Partial<NonNullable<MoodState['settings']>>) => {
    setState(s => (s ? { ...s, settings: { ...s.settings, ...patch } } : s))
    void moodApi.setSettings(patch).catch(e => setError(errMessage(e) || 'unknown'))
  }
  // The tab still plays a song from a list since replaced: it stays the one
  // playing, and no new pick is marked playing until it really starts.
  const playingOld = !!browserPick && !queue.some(p => p.id === browserPick) && songOn(crew)
  const heldNow = playingOld && held?.id === browserPick ? held : null
  const current = queue.find(p => p.id === currentId)
    ?? heldNow
    ?? (playingOld ? null : queue.find(p => p.feedback !== 'skipped') ?? null)
  const knownSongs = useMemo(
    () => new Set((state?.memory ?? []).filter(m => m.kind === 'known').map(m => songKey(m.title, m.artist))),
    [state?.memory],
  )

  /** Send one turn to the buddy and start waiting for its reply. */
  const ask = useCallback(async (message: string, shown: string, memoryIds: string[], play?: Pending['play'], say?: boolean) => {
    const known = slotRef.current ?? (await moodApi.openSlot()).key
    // The reply already in the slot, so the poll waits for a NEW one.
    const before = await moodApi.getSlot(known).catch(() => undefined)
    lastAskRef.current = message
    lastShownRef.current = shown
    const key = await moodApi.ask(message)
    slotRef.current = key
    setSlotKey(key)
    setPending({ momentId: momentRef.current, baseline: replyMark(before), memoryIds, text: shown, ...(play ? { play } : {}), ...(say ? { say } : {}) })
    // What the person just sent shows at the bottom of the record.
    stickRef.current = true
    setAtBottom(true)
  }, [moodApi])
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  /**
   * Wake the buddy to play *pick* in Kiro Crew's browser. Asks for more songs too
   * when at most {@link REFILL_AT} would be left after it. A turn already out wins:
   * nothing is sent, so two turns never share the chat.
   */
  const askPlay = async (pick: QueuedPick, why: 'start' | 'ended') => {
    if (pendingRef.current) return
    const playable = queue.filter(p => p.feedback !== 'skipped')
    const after = playable.slice(playable.findIndex(p => p.id === pick.id) + 1)
    const refill = after.length <= REFILL_AT
    const moodTags = state?.moments?.[0]?.tags ?? []
    const { ids } = memorySummary(state?.memory ?? [])
    const message = buildPlayRequest({
      song: pick,
      steps: state?.play_steps?.[pick.source]?.steps ?? [],
      why,
      refill: refill ? { moodTags, queued: queue.map(p => ({ title: p.title, artist: p.artist, arc: p.arc })) } : null,
      state,
      explore,
      stayOnly,
    })
    await ask(message, pick.artist ? `"${pick.title}" - ${pick.artist}` : `"${pick.title}"`, refill ? ids : [], {
      pickId: pick.id, site: pick.source, refill,
    })
  }

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setTurnFailed('')
    setNotice(null)
    setStuck(false)
    try {
      await work()
    } catch (e) {
      setError(errMessage(e) || 'unknown')
      setPending(null)
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * Send the person's words. While the buddy works they go INTO its running
   * turn (`steerIn`); otherwise as a turn of their own. `sent` runs once they
   * are in, so words that did not get in stay where they were typed.
   */
  const send = (kind: Kind, words: string, sent?: () => void) => {
    if (!words) return
    if (pending) {
      void steerIn(kind, words).then(ok => { if (ok) sent?.() })
      return
    }
    if (busy) return
    sent?.()
    // A box message keeps its moment only once its picks land (a command is no moment).
    momentRef.current = ''
    void run(async () => {
      const { ids } = memorySummary(state?.memory ?? [])
      const nowPlaying = current ? { title: current.title, artist: current.artist } : null
      await ask(buildRequest({ kind, text: words, state, explore, stayOnly, nowPlaying }), words, ids, undefined, kind === 'say')
    })
  }

  /**
   * The one box. While the buddy's question is open, what is typed answers it;
   * otherwise it is a message the buddy reads as a feeling or a command. A
   * chip, or words that name a mood, set its scene now; other words keep it.
   */
  const submitBox = (e: FormEvent) => {
    e.preventDefault()
    const typed = text.trim()
    if (!typed || !canSend) return
    if (openQuestion) {
      send('answer', typed, () => setText(''))
    } else {
      const look: MoodLook = chip && typed.startsWith(moodLabel(chip)) ? chip : moodLookFor([typed])
      send('say', typed, () => {
        if (look !== 'neutral') setScene(presetScene(look))
        setText('')
      })
    }
  }

  /** A chip puts its mood at the start of the box, in place of another chip's, and leaves the rest typed. */
  const pickChip = (key: MoodKey) => {
    let rest = text.trim()
    for (const k of MOOD_KEYS) {
      const label = moodLabel(k)
      if (rest.startsWith(label)) { rest = rest.slice(label.length).replace(/^[\s:：,，]+/, ''); break }
    }
    setChip(key)
    setText(rest ? `${moodLabel(key)}: ${rest}` : moodLabel(key))
    inputRef.current?.focus()
  }

  const moreLike = (pick: QueuedPick) => send('more', pick.artist ? `"${pick.title}" - ${pick.artist}` : `"${pick.title}"`)

  const stop = () => {
    const key = slotRef.current
    if (!key || !pending) return
    setPending(p => (p ? { ...p, stopped: true } : p))
    void moodApi.stop(key).catch(e => setError(errMessage(e) || 'stop_failed'))
  }

  const readNow = useCallback(async () => {
    const key = slotRef.current
    if (!key) return
    try {
      setSlot(await moodApi.getSlot(key))
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [moodApi])

  // Poll the slot while a turn is out. A turn parked on an approval is waiting
  // on the person, not stuck; any other turn with no new activity for STUCK_MS
  // shows the stuck banner, and keeps being read in case it moves again.
  useEffect(() => {
    if (!pending) return
    let live = true
    let lastKey = ''
    let lastMove = Date.now()
    let failingSince = 0
    const timer = setInterval(async () => {
      const key = slotRef.current
      if (!key || !live) return
      let read
      try {
        read = await moodApi.getSlot(key)
        failingSince = 0
        setOffline(false)
      } catch {
        if (!failingSince) failingSince = Date.now()
        if (Date.now() - failingSince > OFFLINE_MS) setOffline(true)
        return
      }
      if (!live) return
      setSlot(read)
      const moved = activityKey(read)
      if (moved !== lastKey || pendingApproval(read)) {
        lastKey = moved
        lastMove = Date.now()
        setStuck(false)
      } else if (Date.now() - lastMove > STUCK_MS) {
        setStuck(true)
      }
      if (read.running) return
      const reply = latestReply(read)
      const source = replySource(reply)
      const failed = turnError(read)
      // A NEW reply ends the turn, even one word for word like the last.
      const fresh = !!reply && !sameReply(pending.baseline, read)
      if (!failed && !fresh && !pending.stopped) return
      live = false
      // Steered words the turn ended without reading run as their own turn:
      // this reply is the turn's own, and the page waits on theirs next.
      const requeued = pending.steered && steerRequeued(read, pending.text)
      const turn: Pending = requeued ? { ...pending, say: undefined, steered: undefined } : pending
      // A song picked, or words sent, during this turn that ran as a turn of its own runs next: wait on that turn.
      const next = pending.stopped ? null
        : requeued ? { momentId: '', memoryIds: pending.memoryIds, text: pending.text, say: pending.say }
          : nextRef.current
      nextRef.current = null
      setPending(next ? { ...next, baseline: replyMark(read) } : null)
      setStuck(false)
      if (pending.stopped) { setNotice(t('chat.stopped')); return }
      if (failed && !fresh) { setTurnFailed(failed); return }
      const parsed = parseDjReply(reply)
      if (turn.play) {
        if (!turn.steered) { await afterPlay(turn.play, parsed, source); return }
        // Words steered into a play: the play's own result is kept, then the reply is read like theirs.
        if (parsed?.play) await afterPlay(turn.play, { ...parsed, picks: [] }, source)
      }
      if (!parsed) { setError('unreadable'); return }
      if (parsed.scene) {
        // The buddy marked a big mood shift: its scene replaces the current one.
        setScene(parsed.scene)
      } else {
        // No scene: keep the one on screen. Only the resting scene still follows the tags.
        const tagLook = moodLookFor(parsed.moodTags)
        if (!chipRef.current && tagLook !== 'neutral') setScene(s => (s.source === 'neutral' ? presetScene(tagLook) : s))
      }
      if (parsed.picks.length === 0) {
        // A player command from the box: the page runs it once this turn is over.
        if (parsed.action && parsed.action !== 'play') { setAction({ kind: parsed.action }); return }
        // A question, or the buddy saying it found nothing good enough (with
        // follow-ups), is an answer the conversation already shows.
        if (!parsed.question && !parsed.followUps.length) {
          if (parsed.dropped > 0) { setDroppedAll(parsed.dropped); setError('all_dropped') }
          else setError('unreadable')
        }
        return
      }
      setChecking(true)
      try {
        const checked = await moodApi.verifyPicks(parsed.picks)
        const dropped = parsed.dropped + Object.values(checked.dropped).reduce((a, b) => a + b, 0)
        if (checked.picks.length === 0) { setDroppedAll(dropped); setError('all_dropped'); return }
        if (dropped > 0) setNotice(t('page.dropped', { count: dropped }))
        // A box message that brought songs was a feeling worth keeping as a moment.
        const momentId = turn.say ? (await moodApi.addMoment(turn.text)).id : turn.momentId
        // The song in the tab plays on through a new list: it stays the current
        // one, kept aside, and its end moves on to the new list's first pick.
        const playing = browserPickRef.current
        const before = queueRef.current.find(p => p.id === playing)
        const playsOn = !!playing && (songOn(crewRef.current) || playing === turn.play?.pickId)
        const { queue: next } = await moodApi.setQueue({
          source, moment_id: momentId || undefined, mood_tags: parsed.moodTags, picks: checked.picks,
        })
        queueMemoryRef.current = turn.memoryIds
        if (playsOn) setHeld(h => before ?? h)
        setState(await moodApi.state())
        setCurrentId(playsOn ? playing : next[0]?.id ?? null)
        // "Play this song now": the first pick goes straight to the browser.
        if (parsed.action === 'play' && next[0]) setAction({ kind: 'play', pickId: next[0].id })
      } catch (e) {
        setError(errMessage(e) || 'unknown')
      } finally {
        setChecking(false)
      }
    }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [pending, moodApi])

  /**
   * The buddy's answer to a play request. Played: the tab now plays that song,
   * and the steps that worked replace the site's old ones. Not played: the old
   * steps go, so the next play finds the way again. Picks in the same block (a
   * refill) are checked like any others and added after the queue.
   */
  async function afterPlay(play: NonNullable<Pending['play']>, parsed: DjReply | null, source: string) {
    const result = parsed?.play
    // No readable answer, but the tab now plays: the song is there all the same,
    // so the buttons reach it. Its steps are not known, so none are kept.
    const inTabNow = !result && !!crewMediaRef.current && !crewMediaRef.current.ended
    if (result?.played || inTabNow) {
      // Read at once by a reply in the same turn that replaces the list.
      browserPickRef.current = play.pickId
      setBrowserPick(play.pickId)
      // The backend learns which song plays, so it can play the next one with the page closed.
      void tellPlaying(play.pickId)
      // A song the buddy started counts as heard (design §0.6): not an explore pick again.
      const heard = queue.find(p => p.id === play.pickId)
      if (result?.played && heard && !knownSongs.has(songKey(heard.title, heard.artist))) {
        markKnown(heard, 'app')
        markUsed()
      }
      // A fresh start of a song lets its next ending wake the buddy again.
      if (endedForRef.current === play.pickId) { endedForRef.current = null; setEndedFor(null) }
      if (result?.steps.length) void moodApi.setPlaySteps(play.site, result.steps).then(refresh).catch(() => undefined)
    } else {
      void moodApi.forgetPlaySteps(play.site).then(refresh).catch(() => undefined)
      setNotice(t('browser.not_played', { reason: result?.reason || t('browser.no_reason') }))
    }
    if (!parsed?.picks.length) return
    setChecking(true)
    try {
      const checked = await moodApi.verifyPicks(parsed.picks)
      if (checked.picks.length) {
        await moodApi.setQueue({ source, mood_tags: parsed.moodTags, picks: checked.picks, append: true })
        setState(await moodApi.state())
      }
    } catch (e) {
      setError(errMessage(e) || 'unknown')
    } finally {
      setChecking(false)
    }
  }

  /**
   * Tell the backend which song now plays. Without it, every later claim for
   * this song's ending is refused, so continuous play stops: a failure is tried
   * again, and said on the page when it still fails.
   */
  const tellPlaying = async (pickId: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await moodApi.setPlayback({ pick_id: pickId })
        return
      } catch {
        if (attempt >= PLAYBACK_TRIES) { setNotice(t('browser.playback_unsaved')); return }
        await new Promise(resolve => setTimeout(resolve, POLL_MS * attempt))
      }
    }
  }

  /** The memory behind this queue helped: keep it fresh (design §2.3). */
  const markUsed = useCallback(() => {
    const ids = queueMemoryRef.current
    queueMemoryRef.current = []
    if (ids.length) void moodApi.markUsed(ids).catch(() => undefined)
  }, [moodApi])

  const giveFeedback = (pick: QueuedPick, verdict: Verdict) => {
    // The old list's song is in no queue to mark: Skip just goes on to the new list.
    if (pick === heldNow) {
      const first = queue.find(p => p.feedback !== 'skipped')
      if (verdict === 'skipped' && first) playPick(first)
      return
    }
    void run(async () => {
      const updated = await moodApi.feedback(pick.id, verdict)
      if (verdict === 'liked') markUsed()
      setState(await moodApi.state().catch(() => state))
      if (verdict === 'skipped') {
        const rest = queue.filter(p => p.id !== updated.id && p.feedback !== 'skipped')
        setCurrentId(rest[0]?.id ?? null)
        if (browserMode && rest[0]) {
          stoppedRef.current = false
          await askPlay(rest[0], 'start')
        }
      }
    })
  }

  const markKnown = (pick: QueuedPick, origin: 'user' | 'app') => {
    void moodApi.addMemory({ kind: 'known', title: pick.title, artist: pick.artist, origin })
      .then(refresh)
      .catch(e => setError(errMessage(e) || 'unknown'))
  }

  const playPick = (pick: QueuedPick) => {
    setCurrentId(pick.id)
    if (!browserMode) return
    if (pending && !pending.stopped) { void switchTo(pick); return }
    if (!pending && !busy) {
      stoppedRef.current = false
      void run(() => askPlay(pick, 'start'))
    }
  }

  // A song picked, or words sent, while a turn ran, that the gateway ran as a
  // turn of its own instead of steering it in: once that turn is over, the page
  // waits on this one.
  const nextRef = useRef<Omit<Pending, 'baseline'> | null>(null)
  // A steer on its way: one at a time, so a double press sends nothing twice.
  const [steering, setSteering] = useState(false)

  /**
   * The person's words while the buddy works: they go INTO the running turn (a
   * steer), and the turn's reply is then read like a box message's (scene,
   * picks, moment, memory). Never queued: words the gateway queued behind a
   * turn still running are taken back, and the page says they did not get in.
   * Words it ran as a turn of their own because the turn had just ended (too
   * late to take back, or already started) are a normal message, waited on next.
   * True when the words went in.
   */
  const steerIn = async (kind: Kind, words: string): Promise<boolean> => {
    const key = slotRef.current
    if (!key || steering) return false
    setSteering(true)
    setNotice(null)
    const { ids } = memorySummary(state?.memory ?? [])
    const nowPlaying = current ? { title: current.title, artist: current.artist } : null
    const message = buildRequest({ kind, text: words, state, explore, stayOnly, nowPlaying })
    const say = kind === 'say' || undefined
    try {
      const r = await moodApi.steer(key, message)
      if (!r.steered && r.queued) {
        const read = await moodApi.getSlot(key).catch(() => undefined)
        // Still running: queued means after it, which is not what was asked.
        if ((!read || read.running) && r.queueId && (await moodApi.cancelQueued(key, r.queueId))) {
          setNotice(t('chat.steer_missed'))
          return false
        }
      }
      lastAskRef.current = message
      lastShownRef.current = words
      if (r.steered) {
        setPending(p => (p ? { ...p, text: words, say, steered: true, memoryIds: [...new Set([...p.memoryIds, ...ids])] } : p))
      } else {
        nextRef.current = { momentId: '', memoryIds: ids, text: words, say }
      }
      stickRef.current = true
      setAtBottom(true)
      return true
    } catch {
      setNotice(t('chat.steer_missed'))
      return false
    } finally {
      setSteering(false)
    }
  }

  /**
   * The person picked *pick* while the buddy works: the play request goes INTO
   * the running turn (a steer), so the buddy switches now instead of after it.
   * The turn the page waits on becomes this song's play.
   */
  const switchTo = async (pick: QueuedPick) => {
    const key = slotRef.current
    if (!key) return
    stoppedRef.current = false
    const message = buildPlayRequest({
      song: pick, steps: state?.play_steps?.[pick.source]?.steps ?? [], why: 'switch', state, explore, stayOnly,
    })
    const shown = pick.artist ? `"${pick.title}" - ${pick.artist}` : `"${pick.title}"`
    const play = { pickId: pick.id, site: pick.source, refill: false }
    lastAskRef.current = message
    lastShownRef.current = shown
    try {
      if ((await moodApi.steer(key, message)).steered) {
        if (nextRef.current?.play) nextRef.current = null
        setPending(p => (p ? { ...p, play, text: shown, steered: undefined } : p))
      } else {
        nextRef.current = { momentId: '', memoryIds: [], text: shown, play }
      }
      stickRef.current = true
      setAtBottom(true)
    } catch (e) {
      setError(errMessage(e) || 'unknown')
    }
  }

  /**
   * A song in the Crew Browser tab ended (the host calls this once per ending).
   * With continuous play on and no pause from the person, the buddy is woken
   * once for the next song; `endedFor`, kept with the page view, makes a second
   * report of the same ending (a remount, a reload) wake nobody.
   */
  const onEnded = () => {
    const id = browserPick
    if (!browserMode || !continuous || stoppedRef.current || !id) return
    if (endedForRef.current === id) return
    // The host reports an ending once: with the buddy busy it is owed, not dropped.
    if (pendingRef.current || busy) { setOwedEnd(id); return }
    endedForRef.current = id
    setEndedFor(id)
    // The next one not skipped after it; a song from a replaced list goes on to the new list's first.
    const at = queue.findIndex(p => p.id === id)
    const next = queue.slice(at + 1).find(p => p.feedback !== 'skipped')
    if (!next) return
    void run(async () => {
      // The backend hears endings too (a Kiro Crew with the hook): one claim
      // decides who wakes the buddy. Lost: the backend woke it; follow its song.
      if (!(await moodApi.claimEnded(id))) { setFollowFrom(id); return }
      setCurrentId(next.id)
      await askPlay(next, 'ended')
    })
  }
  onEndedRef.current = onEnded

  // An ending heard while the buddy was busy: once its turn is over, and if the
  // same song is still over in the tab, it wakes the buddy then.
  const [owedEnd, setOwedEnd] = useState<string | null>(null)
  useEffect(() => {
    if (!owedEnd || pending || busy) return
    setOwedEnd(null)
    if (owedEnd === browserPick && stillEnded(crewMediaRef.current)) onEndedRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owedEnd, pending, busy])

  // Readings of the tab: an ending no reading called `ended` (`endedBetween`),
  // and the person pressing play on the site itself after pausing here.
  const lastMediaRef = useRef(crew.media)
  const pausedAtRef = useRef(0)
  useEffect(() => {
    const prev = lastMediaRef.current
    const now = crew.media
    lastMediaRef.current = now
    if (endedBetween(prev, now)) onEndedRef.current()
    const pausedHere = stoppedRef.current || state?.playback?.paused === true
    if (pausedHere && now && !now.paused && !now.ended && Date.now() - pausedAtRef.current > RESUME_GRACE_MS) {
      stoppedRef.current = false
      setState(s => (s?.playback ? { ...s, playback: { ...s.playback, paused: false } } : s))
      tellPlayback({ paused: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crew.media])

  // The backend woke the buddy for an ending: read the state until its song is in.
  const [followFrom, setFollowFrom] = useState<string | null>(null)
  useEffect(() => {
    if (!followFrom) return
    let left = FOLLOW_READS
    const timer = setInterval(() => {
      if (--left <= 0) setFollowFrom(null)
      void refresh().catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [followFrom, refresh])
  // A song the backend started (the page closed, or quicker than the page) is the one playing.
  const playingId = state?.playback?.pick_id || null
  useEffect(() => {
    if (!playingId) return
    setFollowFrom(f => (f && f !== playingId ? null : f))
    if (playingId !== browserPick) {
      setBrowserPick(playingId)
      setCurrentId(playingId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId])

  // The media route answers only for an open chat, so the page opens it: it can
  // then tell whether the sites are approved, before the first song.
  useEffect(() => {
    if (!restored || slotRef.current) return
    let live = true
    moodApi.openSlot().then(({ key }) => {
      if (!live || slotRef.current) return
      slotRef.current = key
      setSlotKey(key)
    }).catch(() => undefined)
    return () => { live = false }
  }, [restored, moodApi])

  // The pause is kept with the backend too, so it wakes nobody with the page closed.
  const tellPlayback = (patch: { pick_id?: string; paused?: boolean }) => {
    void moodApi.setPlayback(patch).catch(() => undefined)
  }
  const pauseBrowser = () => {
    stoppedRef.current = true
    pausedAtRef.current = Date.now()
    tellPlayback({ paused: true })
    void crew.pause()
  }
  const resumeBrowser = () => {
    stoppedRef.current = false
    tellPlayback({ paused: false })
    void crew.play()
  }
  const replayBrowser = () => {
    stoppedRef.current = false
    // A fresh start of the song in the tab lets its next ending wake the buddy again.
    endedForRef.current = null
    setEndedFor(null)
    tellPlayback(browserPick ? { pick_id: browserPick } : { paused: false })
    void crew.seek(0).then(() => crew.play())
  }
  const setContinuous = (on: boolean) => {
    if (on) {
      stoppedRef.current = false
      tellPlayback({ paused: false })
    }
    saveSettings({ continuous: on })
  }
  const askPlayCurrent = () => {
    if (!current || pending || busy) return
    stoppedRef.current = false
    void run(() => askPlay(current, 'start'))
  }

  /** The next song after the current one that was not skipped. */
  const nextPick = () => {
    const playable = queue.filter(p => p.feedback !== 'skipped')
    const at = current ? playable.findIndex(p => p.id === current.id) : -1
    return playable[at + 1]
  }

  // A command the buddy read from the box runs here, once its turn is over, with
  // the same code as the player's own buttons.
  useEffect(() => {
    if (!action || pending || busy) return
    setAction(null)
    if (action.kind === 'pause') pauseBrowser()
    else if (action.kind === 'resume') resumeBrowser()
    else if (action.kind === 'replay') replayBrowser()
    else {
      const pick = action.kind === 'next' ? nextPick() : queue.find(p => p.id === action.pickId)
      if (pick) playPick(pick)
      else setNotice(t('chat.no_next'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, pending, busy])

  const approve = (id: string, action: 'approved' | 'rejected') => {
    const key = slotRef.current
    if (!key) return
    void moodApi.approve(key, id, action).then(readNow).catch(e => {
      const cause = grantCause(e)
      if (cause) setGrant(cause)
      else setError(errMessage(e) || 'approve_failed')
    })
  }

  const openFullChat = () => { if (slotRef.current) openChat({ slotKey: slotRef.current }) }

  const retry = () => {
    const again = lastAskRef.current
    if (!again) return
    void run(() => ask(again, lastShownRef.current, []))
  }

  const stopAndRetry = () => {
    const key = slotRef.current
    const again = lastAskRef.current
    if (!key || !again) return
    setPending(null)
    void run(async () => {
      await moodApi.stop(key).catch(() => undefined)
      await ask(again, lastShownRef.current, [])
    })
  }

  const errorText = error === null ? null
    : error === 'unreadable' ? t('page.error_unreadable')
      : error === 'old_host' ? t('page.error_old_host')
      : error === 'hidden_refused' ? t('page.error_hidden_refused')
      : error === 'all_dropped' ? t('chat.all_dropped', { count: droppedAll })
        : t('page.error_generic', { code: error })
  const working = busy || !!pending
  // On the person's words that went into a running turn.
  const steeredMark = (
    <span className="mr-1.5 inline-flex items-center gap-0.5 rounded-full border border-[var(--accent)] px-1.5 align-[1px] text-[10px] font-semibold leading-4 text-[var(--accent)]" data-testid="mood-steered">
      <CornerDownRight size={10} aria-hidden="true" />
      {t('chat.steered')}
    </span>
  )
  const moving = !reduceMotion && !motionPaused
  const status = pending || checking ? buddyStatus(slot, checking) ?? { phase: 'thinking' as const, searches: 0, pages: 0 } : null
  const approval = pending ? pendingApproval(slot) : null
  const lines = conversation(slot)
  const lastBuddy = [...lines].reverse().find(l => l.who === 'buddy')
  // A turn the page woke for a song does not close the buddy's last reply: its
  // question and follow-ups stay open, and an answer goes into that turn.
  // The person's own words (sent or steered) do close it.
  const replyOpen = !pending || (!!pending.play && !pending.steered)
  const lastParsed = replyOpen && lastBuddy?.reply ? parseDjReply(lastBuddy.reply) : null
  const showYou = pending && pending.text && !(lines.length && lines[lines.length - 1].who === 'you' && lines[lines.length - 1].text === pending.text)
  const remember = lastParsed?.remember && lastParsed.remember !== dismissedRemember ? lastParsed.remember : ''
  // The buddy's open question: the one box answers it.
  const openQuestion = lastParsed?.question ?? ''
  // While the buddy works the box still sends, into its turn; not while a send is
  // on its way, or once Stop was pressed.
  const canSend = !steering && (pending ? !pending.stopped : !busy)

  // New rows in the record: follow them down, unless the person scrolled up.
  const recordKey = `${tab}|${lines.length}|${activityKey(slot)}|${status?.phase ?? ''}|${openQuestion}|${queue.length}|${!!approval}`
  const toEnd = (el: HTMLElement) => {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
    else el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    const el = recordRef.current
    if (!el) return
    if (stickRef.current) toEnd(el)
    // Drawn again after another tab: back to where the person left it.
    else if (!el.scrollTop && recordScrollRef.current) el.scrollTop = recordScrollRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordKey])
  // A buddy reply that lands while the person reads back marks the Latest button
  // until they are at the bottom again.
  const buddyCount = lines.filter(l => l.who === 'buddy').length
  const seenBuddyRef = useRef(buddyCount)
  const [unseen, setUnseen] = useState(false)
  useEffect(() => {
    if (buddyCount > seenBuddyRef.current && !stickRef.current) setUnseen(true)
    seenBuddyRef.current = buddyCount
  }, [buddyCount])
  useEffect(() => { if (atBottom) setUnseen(false) }, [atBottom])
  const toLatest = () => {
    stickRef.current = true
    setAtBottom(true)
    if (recordRef.current) toEnd(recordRef.current)
  }
  // Why songs cannot play here yet, with what to do; drawn in the player's place.
  const unready = browserMode ? null : (
    <Banner
      testId="mood-browser-unready"
      title={t('browser.unready_title')}
      body={t(`browser.unready_${browserReady}`)}
      icon={<ShieldCheck size={14} aria-hidden="true" />}
    >
      {browserReady === 'not_approved' && (
        <Btn primary onClick={() => navigate(APPROVE_PATH)}>{t('browser.approve')}</Btn>
      )}
    </Banner>
  )

  return (
    <div className="mm-root relative flex h-full flex-col overflow-hidden" data-testid="mood-music-page">
      <style>{SPLIT_CSS}</style>
      <MoodBackdrop scene={scene} playing={current?.arc} moving={moving} reduced={reduceMotion} />
      <div className="relative flex h-full flex-col">
        <PageHeader
          title={t('page.title')}
          subtitle={t('chat.subtitle')}
          actions={reduceMotion ? undefined : (
            <Btn onClick={() => setMotionPaused(p => !p)} data-testid="mood-motion-toggle">
              <Waves size={14} aria-hidden="true" />
              {motionPaused ? t('page.play_motion') : t('page.pause_motion')}
            </Btn>
          )}
        />
        <div className="px-4 pb-2">
          <SegmentedControl
            value={tab}
            onChange={v => setTab(v)}
            segments={[
              { key: 'listen', label: t('page.tab_listen') },
              { key: 'moments', label: t('page.tab_moments') },
              { key: 'memory', label: t('page.tab_memory') },
            ]}
          />
        </div>

        <div
          ref={scrollRef}
          onScroll={onScrolled}
          className={`mm-scroll flex-1 overflow-y-auto px-4 pb-6 ${tab === 'listen' ? 'mm-split' : ''}`}
          data-testid="mood-scroll"
        >
          {tab === 'memory' ? (
            <div className="mx-auto max-w-5xl">
              <MemoryTab memory={state?.memory ?? []} api={moodApi} onChanged={refresh} profile={state?.profile ?? null} room={state?.memory_room} taste={state?.taste_status} />
            </div>
          ) : tab === 'moments' ? <div className="mx-auto max-w-5xl"><MomentsTab moments={state?.moments ?? []} /></div> : (
            <div className="mm-listen" data-testid="mood-listen">
              <div className="mm-col flex min-w-0 flex-col gap-3" data-testid="mood-chat-column">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-[var(--muted)]">{t('chat.explore')}</span>
                  <SegmentedControl<ExploreLevel>
                    ariaLabel={t('chat.explore')}
                    value={explore}
                    onChange={v => saveSettings({ explore: v })}
                    segments={[
                      { key: 'familiar', label: t('chat.explore_familiar') },
                      { key: 'balanced', label: t('chat.explore_balanced') },
                      { key: 'explore', label: t('chat.explore_more') },
                    ]}
                  />
                  <button
                    type="button"
                    aria-pressed={stayOnly}
                    onClick={() => { setStayOnly(!stayOnly); saveSettings({ stay_only: !stayOnly }) }}
                    className={`mm-press rounded-full border px-3 py-1 text-xs transition-colors ${stayOnly
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`}
                  >
                    {t('chat.stay_only')}
                  </button>
                </div>

                {/* The buddy's record: always open, newest at the bottom, its own scroll. */}
                <section
                  className="mm-record-card relative flex min-h-0 flex-col rounded-2xl border border-[var(--border)]"
                  style={CARD_STYLE}
                  aria-labelledby="mood-record-title"
                  data-testid="mood-record-card"
                >
                  <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
                    <h2 id="mood-record-title" className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('chat.record_title')}</h2>
                    {slotKey && (
                      <button
                        type="button"
                        onClick={openFullChat}
                        className="mm-press inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        {t('chat.open_full')}
                      </button>
                    )}
                  </header>
                  <div
                    ref={recordRef}
                    onScroll={onRecordScrolled}
                    className="mm-record flex flex-col gap-2 px-3 py-3"
                    data-testid="mood-record"
                    role="log"
                    aria-label={t('chat.conversation')}
                    tabIndex={0}
                  >
                    <section className="flex flex-col gap-2" data-testid="mood-chat">
                      {lines.length === 0 && !pending && (
                        <p className="text-sm text-[var(--muted)]">{t('chat.hello')}</p>
                      )}
                      {lines.slice(-30).map((line, i) => (
                        line.who === 'you' ? (
                          <p key={i} className="mm-row self-end max-w-[85%] rounded-2xl bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--text)]">
                            <span className="sr-only">{t('chat.you')}: </span>{line.steered && steeredMark}{line.text}
                          </p>
                        ) : (
                          <div key={i} className="mm-row max-w-[95%]">
                            <BuddySteps steps={line.steps ?? []} testId="mood-steps" />
                            <p className="mt-1.5 text-sm text-[var(--text)]">
                              <span className="mr-1 font-semibold text-[var(--accent)]">{t('chat.buddy')}</span>
                              {line.text}
                            </p>
                            {line === lastBuddy && line.reply && replySource(line.reply) === state?.last_source && queue.length > 0 && (
                              <div className="mt-2 grid gap-2" data-testid="mood-cards">
                                {queue.map(p => (
                                  <SongCard
                                    key={p.id}
                                    pick={p}
                                    playing={current?.id === p.id}
                                    known={knownSongs.has(songKey(p.title, p.artist))}
                                    busy={working}
                                    onPlay={() => playPick(p)}
                                    onLike={() => giveFeedback(p, p.feedback === 'liked' ? '' : 'liked')}
                                    onSkip={() => giveFeedback(p, 'skipped')}
                                    onKnown={() => markKnown(p, 'user')}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      ))}
                      {showYou && (
                        <p className="mm-row self-end max-w-[85%] rounded-2xl bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--text)]">{pending.steered && steeredMark}{pending.text}</p>
                      )}
                      {status && <BuddySteps steps={liveSteps(slot)} live testId="mood-live-steps" />}
                      {status && (
                        <p role="status" className="mm-row flex items-center gap-1.5 text-xs text-[var(--muted)]" data-testid="mood-status">
                          <Headphones size={13} aria-hidden="true" className={reduceMotion ? '' : 'animate-pulse'} />
                          {statusText(status)}
                        </p>
                      )}
                      {openQuestion && (
                        <div className="mm-row rounded-2xl border border-[var(--accent)] px-3 py-2" data-testid="mood-question">
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)]">
                            <MessageCircleQuestion size={14} aria-hidden="true" />
                            {t('page.question_label')}
                          </p>
                          <p className="mt-1 text-sm text-[var(--text)]">{openQuestion}</p>
                        </div>
                      )}
                    </section>
                  </div>
                  {!atBottom && (
                    <button
                      type="button"
                      onClick={toLatest}
                      className="mm-press absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 text-xs text-[var(--text)] shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      data-testid="mood-record-latest"
                    >
                      {unseen && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden="true" data-testid="mood-record-unseen" />}
                      <ArrowDown size={12} aria-hidden="true" />
                      {unseen ? t('chat.new_message') : t('chat.latest')}
                    </button>
                  )}
                </section>

                {approval && (
                  <Banner testId="mood-approval" title={approval.host ? t('chat.approval_host', { host: approval.host }) : t('chat.approval_tool')} icon={<ShieldCheck size={14} aria-hidden="true" />}>
                    <Btn primary onClick={() => approve(approval.id, 'approved')}>{t('chat.allow_once')}</Btn>
                    <Btn onClick={() => approve(approval.id, 'rejected')}>{t('chat.deny')}</Btn>
                  </Banner>
                )}
                {grant && (
                  <Banner testId="mood-grant" title={t('chat.grant_title')} body={t(GRANT_STEPS[grant])} icon={<ShieldCheck size={14} aria-hidden="true" />}>
                    <Btn primary onClick={openFullChat}>{t('chat.open_full')}</Btn>
                    <Btn onClick={() => setGrant(null)}>{t('chat.dismiss')}</Btn>
                  </Banner>
                )}
                {turnFailed && (
                  <Banner testId="mood-turn-error" title={t('chat.error_title')} body={turnFailed} icon={<TriangleAlert size={14} aria-hidden="true" />}>
                    <Btn primary onClick={retry}>{t('page.retry')}</Btn>
                    <Btn onClick={openFullChat}>{t('chat.open_full')}</Btn>
                  </Banner>
                )}
                {stuck && pending && (
                  <Banner testId="mood-stuck" title={t('chat.stuck_title')} icon={<TriangleAlert size={14} aria-hidden="true" />}>
                    <Btn primary onClick={stopAndRetry}>{t('chat.stop_restart')}</Btn>
                    <Btn onClick={() => setStuck(false)}>{t('chat.wait')}</Btn>
                    <Btn onClick={openFullChat}>{t('chat.open_full')}</Btn>
                  </Banner>
                )}
                {offline && (
                  <Banner testId="mood-offline" title={t('chat.offline_title')} icon={<WifiOff size={14} aria-hidden="true" />}>
                    <Btn primary onClick={() => void readNow()}>{t('chat.reconnect')}</Btn>
                  </Banner>
                )}

                {/* The one box: feelings and commands alike, into the same conversation. */}
                <form onSubmit={submitBox} className="mm-composer flex flex-col gap-2" data-testid="mood-composer">
                  {replyOpen && ((lastParsed?.followUps.length ?? 0) > 0 || remember) && (
                    <div role="group" aria-label={t('chat.follow_ups')} className="flex flex-wrap gap-2" data-testid="mood-follow-ups">
                      {lastParsed!.followUps.map(f => (
                        <Btn key={f} type="button" disabled={!canSend} onClick={() => send('follow', f)}>{f}</Btn>
                      ))}
                      {remember && (
                        <Btn
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setDismissedRemember(remember)
                            void moodApi.addMemory({ kind: 'note', text: remember, origin: 'user' }).then(refresh)
                              .then(() => setNotice(t('chat.remembered', { note: remember })))
                              .catch(e => setError(errMessage(e) || 'unknown'))
                          }}
                        >
                          {t('chat.remember', { note: remember })}
                        </Btn>
                      )}
                    </div>
                  )}
                  <div role="group" aria-label={t('page.mood_chips')} className="flex flex-wrap gap-2">
                    {MOOD_KEYS.map(key => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={chip === key}
                        onClick={() => pickChip(key)}
                        className={`mm-press rounded-full border px-3 py-1 text-xs transition-colors ${chip === key
                          ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
                          : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`}
                      >
                        {moodLabel(key)}
                      </button>
                    ))}
                  </div>
                  <label id="mood-input-label" htmlFor="mood-input" className="sr-only">{t('page.mood_label')}</label>
                  <div className="flex gap-2">
                    <input
                      ref={inputRef}
                      id="mood-input"
                      aria-labelledby="mood-input-label"
                      value={text}
                      onChange={e => setText(e.target.value)}
                      maxLength={200}
                      placeholder={openQuestion ? t('page.answer_placeholder') : pending ? t('chat.steer_placeholder') : t('chat.placeholder')}
                      className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    />
                    <Btn type="submit" primary className="shrink-0 whitespace-nowrap" disabled={!canSend || !text.trim()}>
                      <Send size={14} aria-hidden="true" />
                      {t('chat.send')}
                    </Btn>
                    {pending && (
                      <Btn type="button" className="shrink-0 whitespace-nowrap" onClick={stop} disabled={pending.stopped}>
                        <Square size={14} aria-hidden="true" />
                        {t('chat.stop')}
                      </Btn>
                    )}
                  </div>
                  <ErrorNotice message={errorText} />
                  {(error === 'unreadable' || error === 'all_dropped') && lastAskRef.current && !working && (
                    <Btn type="button" onClick={retry}>{t('page.retry')}</Btn>
                  )}
                  {notice && <p role="status" className="text-xs text-[var(--muted)]" data-testid="mood-notice">{notice}</p>}
                </form>
              </div>

              <div className={`mm-player ${browserMode && slotKey && viewOpen && HostView ? 'mm-player-view ' : ''}flex min-w-0 flex-col gap-4`} data-testid="mood-player-column">
                {!current && unready}
                {browserMode && slotKey && (
                  <BrowserView
                    open={viewOpen}
                    onToggle={open => saveSettings({ view_open: open })}
                    operating={status?.phase === 'playing'}
                    live={HostView ? <HostView slot={slotKey} aria-label={t('view.title')} stayLive /> : null}
                  />
                )}
                <div className="mm-deck" data-testid="mood-deck">
                  {current ? (
                    <NowPlaying
                      pick={current}
                      stage={unready ?? (
                        <BrowserControls
                          media={crew}
                          waiting={working}
                          continuous={continuous}
                          onAskPlay={askPlayCurrent}
                          onPause={pauseBrowser}
                          onPlay={resumeBrowser}
                          onReplay={replayBrowser}
                          onContinuous={setContinuous}
                        />
                      )}
                      busy={working}
                      fromOldList={!!heldNow && current === heldNow}
                      onLike={() => giveFeedback(current, current.feedback === 'liked' ? '' : 'liked')}
                      onSkip={() => giveFeedback(current, 'skipped')}
                      onMore={() => moreLike(current)}
                    />
                  ) : (
                    <EmptyState icon={<Play size={28} />} title={t('page.empty_title')} subtitle={t('page.empty_body')} />
                  )}

                  {queue.length > 0 && (
                    <section aria-label={t('page.queue')} className="mm-upnext flex min-w-0 flex-col" data-testid="mood-queue-section">
                      <h3 className="mb-2 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                        {t('page.queue')}
                        <span className="font-normal tabular-nums" data-testid="mood-queue-count">{queue.length}</span>
                      </h3>
                      <ul className="mm-queue-list flex flex-col gap-2" data-testid="mood-queue" tabIndex={0} aria-label={t('page.queue')}>
                        {queue.map((p, i) => {
                          const now = current?.id === p.id
                          return (
                            <li key={p.id}>
                              <button
                                type="button"
                                onClick={() => playPick(p)}
                                aria-current={now ? 'true' : undefined}
                                className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${now
                                  ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                                  : 'border-[var(--border)] hover:bg-[var(--bg-hover)]'} ${p.feedback === 'skipped' ? 'opacity-50' : ''}`}
                                style={now ? undefined : CARD_STYLE}
                                data-testid="mood-queue-row"
                              >
                                <span className={`mm-queue-num text-xs tabular-nums ${now ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`} aria-hidden="true">
                                  {now ? <Volume2 size={14} /> : i + 1}
                                </span>
                                <span className="min-w-0 flex-1">
                                  {now && (
                                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]" data-testid="mood-queue-now">
                                      {t('page.now_playing')}
                                    </span>
                                  )}
                                  <span className="mm-clamp2 text-sm font-semibold leading-snug text-[var(--text)]">{p.title}</span>
                                  {p.artist && <span className="block text-xs text-[var(--muted)]">{p.artist}</span>}
                                  {p.why && (
                                    <span className="mm-clamp2 mt-1 text-xs leading-relaxed text-[var(--text)]" data-testid="mood-queue-why">
                                      <span className="sr-only">{t('page.why')}: </span>{p.why}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
                                  {p.source === 'youtube' ? t('page.source_youtube') : t('page.source_bilibili')}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
