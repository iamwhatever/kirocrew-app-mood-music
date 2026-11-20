/**
 * MoodMusicPage — talk to your music buddy, hear songs with the same feeling.
 *
 * The Listen tab is a conversation with the buddy (design §1.6): the person's
 * words, the buddy's one or two sentences, and its picks as song cards, with a
 * status line ("thinking / searching / reading / writing / checking") that
 * never names a tool. The player and the queue sit beside it. Moments and
 * Memory are the other tabs.
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
 * sends back next time. Pause, seek and volume go straight to the tab. With
 * continuous play on, a song's end (read by this page's poll) wakes the buddy
 * once for the next song, and asks for more when the queue runs low. A host
 * without the seam, sites the owner has not approved, or a policy that turns the
 * browser off, show a note with what to do, and the play button stays off.
 *
 * Anything that needs the person shows here with a button (design §1.8): a
 * tool approval (allow once / don't), a missing chat-control grant, a failed
 * turn, a turn that went quiet, a lost connection, and a reply with nothing
 * playable left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from 'react'
import { Headphones, MessageCircleQuestion, Play, Send, ShieldCheck, Square, TriangleAlert, Waves, WifiOff } from 'lucide-react'
import { useAppApi, useChatLauncher, useNavigate } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice, PageHeader, SegmentedControl } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { createMoodApi, grantCause, latestReply, type GrantCause, type MoodState, type QueuedPick, type Verdict } from './api'
import Banner from './Banner'
import BrowserControls from './BrowserControls'
import BrowserView from './BrowserView'
import BuddySteps from './BuddySteps'
import { APPROVE_PATH, hostBrowserView, readiness, useCrewBrowser } from './crewBrowser'
import FullRecord from './FullRecord'
import MemoryTab from './MemoryTab'
import MomentsTab from './MomentsTab'
import MoodBackdrop from './MoodBackdrop'
import { MOOD_KEYS, moodLookFor, presetScene, type MoodKey, type MoodLook, type Scene } from './moods'
import NowPlaying from './NowPlaying'
import { REFILL_AT, buildPlayRequest, buildRequest, memorySummary, type ExploreLevel } from './request.prompt'
import { parseDjReply, replySource, type DjReply } from './replyParse'
import { usePrefersReducedMotion } from './reducedMotion'
import { CARD_STYLE } from './cardStyle'
import SongCard from './SongCard'
import { activityKey, buddyStatus, conversation, liveSteps, pendingApproval, turnError, type BuddyStatus } from './turnState'
import { loadView, saveView, type PageView, type SavedPending, type Tab } from './pageMemory'

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '')

type Kind = 'mood' | 'answer' | 'more' | 'follow'

/** Poll cadence while the buddy works. */
export const POLL_MS = 1000
/** No new activity for this long: the page says the buddy may be stuck (design §1.8). */
export const STUCK_MS = 2 * 60_000
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
 * player and the queue under it. Each column scrolls on its own and the page
 * itself does not. On a wide right column the player and the queue sit side by
 * side. Narrower, it is one column and the page scrolls. Container queries, so
 * the layout follows the page's own width (the Crew sidebar takes part of the
 * window), not the window's.
 */
export const SPLIT_CSS = `
.mm-root { container-type: inline-size; }
.mm-listen { display: grid; gap: 1.25rem; grid-template-columns: minmax(0, 1fr); align-items: start; width: 100%; max-width: 1760px; margin: 0 auto; }
.mm-player { container-type: inline-size; }
.mm-deck { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr); align-items: start; }
@container (min-width: 860px) {
  div.mm-scroll.mm-split { overflow: hidden; display: flex; flex-direction: column; padding-bottom: 0; }
  .mm-split > .mm-listen { flex: 1; min-height: 0; grid-template-columns: minmax(320px, 5fr) minmax(0, 7fr); align-items: stretch; }
  /* No scroll anchoring: rows drawn in after a return must not push the restored position. */
  .mm-col { min-height: 0; overflow-y: auto; overflow-anchor: none; padding-bottom: 1.5rem; }
  .mm-player { min-height: 0; overflow-y: auto; overflow-anchor: none; padding-bottom: 1.5rem; }
}
@container (min-width: 720px) {
  .mm-deck { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
`

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
  const [answer, setAnswer] = useState('')
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
  // Set by the person's pause: no song end wakes the buddy until they press play.
  const stoppedRef = useRef(false)
  // Set once the saved view is applied; nothing is saved before, so a page
  // still loading never writes its empty first frame over it.
  const [restored, setRestored] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatColRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(saved?.scroll ?? 0)
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
          if (!read || read.running || turnError(read) || (source !== out.baseline && source !== s.last_source)) {
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

  const view: PageView = { tab, text, chip, stayOnly, scene, currentId, slotKey, scroll: 0, pending, browserPick, endedFor }
  const viewRef = useRef(view)
  viewRef.current = view
  const persist = useCallback(() => {
    if (restored) saveView({ ...viewRef.current, scroll: scrollTopRef.current })
  }, [restored])
  const onScrolled = (e: UIEvent<HTMLElement>) => { scrollTopRef.current = e.currentTarget.scrollTop; persist() }
  useEffect(persist, [persist, tab, text, chip, stayOnly, scene, currentId, slotKey, pending, browserPick, endedFor])

  // Back where they were on the page, once what it shows is drawn again.
  useEffect(() => {
    // One of the two scrolls, by layout: the page (one column) or the chat column.
    if (!restored || !scrollTopRef.current) return
    for (const el of [scrollRef.current, chatColRef.current]) if (el) el.scrollTop = scrollTopRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored])

  const queue = state?.queue ?? []
  const explore: ExploreLevel = state?.settings?.explore ?? 'balanced'
  const recordOpen = state?.settings?.record_open ?? false
  const viewOpen = state?.settings?.view_open ?? true
  // The host's live view of the buddy's tab (level 11); absent on an older host.
  const HostView = hostBrowserView()
  const continuous = state?.settings?.continuous ?? true
  // The Crew Browser player. Polled from the first play request on, so the page
  // sees the song in the tab even when the buddy's reply could not be read; read
  // once otherwise, which is how the page learns whether it can play here at all.
  const onEndedRef = useRef<() => void>(() => undefined)
  const crew = useCrewBrowser(slotKey ?? '', !!browserPick || !!pending?.play, () => onEndedRef.current())
  const crewMediaRef = useRef(crew.media)
  crewMediaRef.current = crew.media
  const browserReady = readiness(crew)
  // `unknown` (no answer about this chat yet) still lets a play go out: the buddy
  // then says what went wrong, so nothing waits in silence.
  const browserMode = browserReady === 'ready' || browserReady === 'unknown'

  const saveSettings = (patch: Partial<NonNullable<MoodState['settings']>>) => {
    setState(s => (s ? { ...s, settings: { ...s.settings, ...patch } } : s))
    void moodApi.setSettings(patch).catch(e => setError(errMessage(e) || 'unknown'))
  }
  const current = queue.find(p => p.id === currentId) ?? queue.find(p => p.feedback !== 'skipped') ?? null
  const knownSongs = useMemo(
    () => new Set((state?.memory ?? []).filter(m => m.kind === 'known').map(m => songKey(m.title, m.artist))),
    [state?.memory],
  )

  /** Send one turn to the buddy and start waiting for its reply. */
  const ask = useCallback(async (message: string, shown: string, memoryIds: string[], play?: Pending['play']) => {
    const known = slotRef.current ?? (await moodApi.openSlot()).key
    // The reply already in the slot, so the poll waits for a NEW one.
    const before = await moodApi.getSlot(known).catch(() => undefined)
    lastAskRef.current = message
    lastShownRef.current = shown
    const key = await moodApi.ask(message)
    slotRef.current = key
    setSlotKey(key)
    setPending({ momentId: momentRef.current, baseline: replySource(latestReply(before)), memoryIds, text: shown, ...(play ? { play } : {}) })
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
      refill: refill ? { moodTags, queued: queue.map(p => ({ title: p.title, artist: p.artist })) } : null,
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

  const send = (kind: Kind, words: string) => {
    if (!words || pending || busy) return
    void run(async () => {
      if (kind === 'mood') {
        const moment = await moodApi.addMoment(words)
        momentRef.current = moment.id
        setState(s => (s ? { ...s, moments: [moment, ...s.moments] } : s))
      }
      const { ids } = memorySummary(state?.memory ?? [])
      await ask(buildRequest({ kind, text: words, state, explore, stayOnly }), words, ids)
    })
  }

  /** Record the mood and ask the buddy for songs. A chip, or words that name one, set its scene now; other words keep the scene. */
  const startMood = (mood: string, nextLook: MoodLook) => {
    if (!mood || pending || busy) return
    if (nextLook !== 'neutral') setScene(presetScene(nextLook))
    send('mood', mood)
    setText('')
  }

  const submitMood = (e: FormEvent) => {
    e.preventDefault()
    const typed = text.trim()
    startMood(typed || (chip ? moodLabel(chip) : ''), chip ?? moodLookFor([typed]))
  }

  /** A chip is a search: its mood, plus whatever is typed in the box. */
  const pickChip = (key: MoodKey) => {
    const typed = text.trim()
    setChip(key)
    startMood(typed ? `${moodLabel(key)}: ${typed}` : moodLabel(key), key)
  }

  const submitAnswer = (e: FormEvent) => {
    e.preventDefault()
    const reply = answer.trim()
    if (!reply) return
    setAnswer('')
    send('answer', reply)
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
      if (!failed && (!reply || source === pending.baseline) && !pending.stopped) return
      live = false
      setPending(null)
      setStuck(false)
      if (pending.stopped) { setNotice(t('chat.stopped')); return }
      if (failed && source === pending.baseline) { setTurnFailed(failed); return }
      const parsed = parseDjReply(reply)
      if (pending.play) { await afterPlay(pending.play, parsed, source); return }
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
        const { queue: next } = await moodApi.setQueue({
          source, moment_id: pending.momentId || undefined, mood_tags: parsed.moodTags, picks: checked.picks,
        })
        queueMemoryRef.current = pending.memoryIds
        setState(await moodApi.state())
        setCurrentId(next[0]?.id ?? null)
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
      setBrowserPick(play.pickId)
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

  /** The memory behind this queue helped: keep it fresh (design §2.3). */
  const markUsed = useCallback(() => {
    const ids = queueMemoryRef.current
    queueMemoryRef.current = []
    if (ids.length) void moodApi.markUsed(ids).catch(() => undefined)
  }, [moodApi])

  const giveFeedback = (pick: QueuedPick, verdict: Verdict) => {
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
    if (browserMode && !pending && !busy) {
      stoppedRef.current = false
      void run(() => askPlay(pick, 'start'))
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
    if (endedForRef.current === id || pendingRef.current || busy) return
    endedForRef.current = id
    setEndedFor(id)
    const playable = queue.filter(p => p.feedback !== 'skipped')
    const at = playable.findIndex(p => p.id === id)
    const next = at >= 0 ? playable[at + 1] : undefined
    if (!next) return
    setCurrentId(next.id)
    void run(() => askPlay(next, 'ended'))
  }
  onEndedRef.current = onEnded

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

  const pauseBrowser = () => {
    stoppedRef.current = true
    void crew.pause()
  }
  const resumeBrowser = () => {
    stoppedRef.current = false
    void crew.play()
  }
  const replayBrowser = () => {
    stoppedRef.current = false
    // A fresh start of the song in the tab lets its next ending wake the buddy again.
    endedForRef.current = null
    setEndedFor(null)
    void crew.seek(0).then(() => crew.play())
  }
  const setContinuous = (on: boolean) => {
    if (on) stoppedRef.current = false
    saveSettings({ continuous: on })
  }
  const askPlayCurrent = () => {
    if (!current || pending || busy) return
    stoppedRef.current = false
    void run(() => askPlay(current, 'start'))
  }

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
  const openRecord = () => {
    if (!recordOpen) saveSettings({ record_open: true })
    document.getElementById('mood-full-record')?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }

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
  const moving = !reduceMotion && !motionPaused
  const status = pending || checking ? buddyStatus(slot, checking) ?? { phase: 'thinking' as const, searches: 0, pages: 0 } : null
  const approval = pending ? pendingApproval(slot) : null
  const lines = conversation(slot)
  const lastBuddy = [...lines].reverse().find(l => l.who === 'buddy')
  const lastParsed = !pending && lastBuddy?.reply ? parseDjReply(lastBuddy.reply) : null
  const showYou = pending && pending.text && !(lines.length && lines[lines.length - 1].who === 'you' && lines[lines.length - 1].text === pending.text)
  const remember = lastParsed?.remember && lastParsed.remember !== dismissedRemember ? lastParsed.remember : ''
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
              <MemoryTab memory={state?.memory ?? []} api={moodApi} onChanged={refresh} />
            </div>
          ) : tab === 'moments' ? <div className="mx-auto max-w-5xl"><MomentsTab moments={state?.moments ?? []} /></div> : (
            <div className="mm-listen" data-testid="mood-listen">
              <div
                ref={chatColRef}
                onScroll={onScrolled}
                className="mm-col flex min-w-0 flex-col gap-3"
                data-testid="mood-chat-column"
                role="region"
                aria-label={t('page.tab_listen')}
                tabIndex={0}
              >
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
                    onClick={() => setStayOnly(v => !v)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${stayOnly
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`}
                  >
                    {t('chat.stay_only')}
                  </button>
                </div>
                <div role="group" aria-label={t('page.mood_chips')} className="flex flex-wrap gap-2">
                  {MOOD_KEYS.map(key => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={chip === key}
                      onClick={() => pickChip(key)}
                      disabled={working}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${chip === key
                        ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`}
                    >
                      {moodLabel(key)}
                    </button>
                  ))}
                </div>

                <section aria-label={t('chat.conversation')} className="flex flex-col gap-2" data-testid="mood-chat">
                  {lines.length === 0 && !pending && (
                    <p className="text-sm text-[var(--muted)]">{t('chat.hello')}</p>
                  )}
                  {lines.slice(-20).map((line, i) => (
                    line.who === 'you' ? (
                      <p key={i} className="self-end max-w-[85%] rounded-2xl bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--text)]">
                        <span className="sr-only">{t('chat.you')}: </span>{line.text}
                      </p>
                    ) : (
                      <div key={i} className="max-w-[95%] rounded-2xl border border-[var(--border)] px-3 py-2" style={CARD_STYLE}>
                        <p className="text-sm text-[var(--text)]">
                          <span className="mr-1 font-semibold text-[var(--accent)]">{t('chat.buddy')}</span>
                          {line.text}
                        </p>
                        <BuddySteps steps={line.steps ?? []} testId="mood-steps" />
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
                    <p className="self-end max-w-[85%] rounded-2xl bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--text)]">{pending.text}</p>
                  )}
                  {status && (
                    <p role="status" className="flex items-center gap-1.5 text-xs text-[var(--muted)]" data-testid="mood-status">
                      <Headphones size={13} aria-hidden="true" className={reduceMotion ? '' : 'animate-pulse'} />
                      {statusText(status)}
                    </p>
                  )}
                  {status && <BuddySteps steps={liveSteps(slot)} testId="mood-live-steps" />}
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
                    <Btn onClick={openRecord}>{t('chat.show_record')}</Btn>
                  </Banner>
                )}
                {stuck && pending && (
                  <Banner testId="mood-stuck" title={t('chat.stuck_title')} icon={<TriangleAlert size={14} aria-hidden="true" />}>
                    <Btn primary onClick={stopAndRetry}>{t('chat.stop_restart')}</Btn>
                    <Btn onClick={() => setStuck(false)}>{t('chat.wait')}</Btn>
                    <Btn onClick={openRecord}>{t('chat.show_record')}</Btn>
                  </Banner>
                )}
                {offline && (
                  <Banner testId="mood-offline" title={t('chat.offline_title')} icon={<WifiOff size={14} aria-hidden="true" />}>
                    <Btn primary onClick={() => void readNow()}>{t('chat.reconnect')}</Btn>
                  </Banner>
                )}

                {lastParsed?.question && !pending && (
                  <form onSubmit={submitAnswer} className="rounded-2xl border border-[var(--accent)] p-3" style={CARD_STYLE} data-testid="mood-question">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)]">
                      <MessageCircleQuestion size={14} aria-hidden="true" />
                      {t('page.question_label')}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text)]">{lastParsed.question}</p>
                    <div className="mt-2 flex gap-2">
                      <input
                        aria-label={t('page.answer_placeholder')}
                        value={answer}
                        onChange={e => setAnswer(e.target.value)}
                        maxLength={300}
                        placeholder={t('page.answer_placeholder')}
                        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      />
                      <Btn type="submit" primary disabled={working || !answer.trim()}>{t('page.send_answer')}</Btn>
                    </div>
                  </form>
                )}

                {!pending && ((lastParsed?.followUps.length ?? 0) > 0 || remember) && (
                  <div role="group" aria-label={t('chat.follow_ups')} className="flex flex-wrap gap-2" data-testid="mood-follow-ups">
                    {lastParsed!.followUps.map(f => (
                      <Btn key={f} disabled={working} onClick={() => send('follow', f)}>{f}</Btn>
                    ))}
                    {remember && (
                      <Btn
                        disabled={working}
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

                <form onSubmit={submitMood} className="flex flex-col gap-2">
                  <label id="mood-input-label" htmlFor="mood-input" className="sr-only">{t('page.mood_label')}</label>
                  <div className="flex gap-2">
                    <input
                      id="mood-input"
                      aria-labelledby="mood-input-label"
                      value={text}
                      onChange={e => setText(e.target.value)}
                      maxLength={200}
                      placeholder={t('chat.placeholder')}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    />
                    {pending ? (
                      <Btn type="button" onClick={stop} disabled={pending.stopped}>
                        <Square size={14} aria-hidden="true" />
                        {t('chat.stop')}
                      </Btn>
                    ) : (
                      <Btn type="submit" primary disabled={working || (!text.trim() && !chip)}>
                        <Send size={14} aria-hidden="true" />
                        {t('chat.send')}
                      </Btn>
                    )}
                  </div>
                  <ErrorNotice message={errorText} />
                  {(error === 'unreadable' || error === 'all_dropped') && lastAskRef.current && !working && (
                    <Btn type="button" onClick={retry}>{t('page.retry')}</Btn>
                  )}
                  {notice && <p className="text-xs text-[var(--muted)]">{notice}</p>}
                </form>

                <FullRecord
                  slotKey={slotKey}
                  open={recordOpen}
                  onToggle={open => saveSettings({ record_open: open })}
                  onSend={message => moodApi.ask(message)}
                />
              </div>

              <div className="mm-player flex min-w-0 flex-col gap-4" data-testid="mood-player-column">
                {!current && unready}
                {browserMode && slotKey && (
                  <BrowserView
                    open={viewOpen}
                    onToggle={open => saveSettings({ view_open: open })}
                    operating={status?.phase === 'playing'}
                    live={HostView ? <HostView slot={slotKey} aria-label={t('view.title')} /> : null}
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
                      onLike={() => giveFeedback(current, current.feedback === 'liked' ? '' : 'liked')}
                      onSkip={() => giveFeedback(current, 'skipped')}
                      onMore={() => moreLike(current)}
                    />
                  ) : (
                    <EmptyState icon={<Play size={28} />} title={t('page.empty_title')} subtitle={t('page.empty_body')} />
                  )}

                  {queue.length > 1 && (
                    <section aria-label={t('page.queue')} className="mm-upnext">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('page.queue')}</h3>
                      <ul className="flex flex-col gap-1.5" data-testid="mood-queue" tabIndex={0} aria-label={t('page.queue')}>
                        {queue.map(p => (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => playPick(p)}
                              aria-current={current?.id === p.id ? 'true' : undefined}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${current?.id === p.id
                                ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                                : 'border-[var(--border)] hover:bg-[var(--bg-hover)]'} ${p.feedback === 'skipped' ? 'opacity-50' : ''}`}
                              style={current?.id === p.id ? undefined : CARD_STYLE}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-[var(--text)]">{p.title}</span>
                                <span className="block truncate text-xs text-[var(--muted)]">{p.artist}</span>
                              </span>
                              <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
                                {p.source === 'youtube' ? t('page.source_youtube') : t('page.source_bilibili')}
                              </span>
                            </button>
                          </li>
                        ))}
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
