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
 * Anything that needs the person shows here with a button (design §1.8): a
 * tool approval (allow once / don't), a missing chat-control grant, a failed
 * turn, a turn that went quiet, a lost connection, and a reply with nothing
 * playable left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Headphones, MessageCircleQuestion, Play, Send, ShieldCheck, Square, TriangleAlert, Waves, WifiOff } from 'lucide-react'
import { useAppApi, useChatLauncher } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice, PageHeader, SegmentedControl } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { createMoodApi, grantCause, latestReply, type GrantCause, type MoodState, type QueuedPick, type Verdict } from './api'
import Banner from './Banner'
import FullRecord from './FullRecord'
import MemoryTab from './MemoryTab'
import MomentsTab from './MomentsTab'
import MoodBackdrop from './MoodBackdrop'
import { MOOD_KEYS, moodLookFor, type MoodKey, type MoodLook } from './moods'
import NowPlaying from './NowPlaying'
import { buildRequest, memorySummary, type ExploreLevel } from './request.prompt'
import { parseDjReply, replySource } from './replyParse'
import { usePrefersReducedMotion } from './reducedMotion'
import { CARD_STYLE } from './cardStyle'
import SongCard from './SongCard'
import { activityKey, buddyStatus, conversation, pendingApproval, turnError, type BuddyStatus } from './turnState'

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '')

type Tab = 'listen' | 'moments' | 'memory'
type Kind = 'mood' | 'answer' | 'more' | 'follow'

/** Poll cadence while the buddy works. */
export const POLL_MS = 1000
/** No new activity for this long: the page says the buddy may be stuck (design §1.8). */
export const STUCK_MS = 2 * 60_000
/** Failed reads for this long: the page says it cannot reach Kiro Crew. */
export const OFFLINE_MS = 10_000
/** Played this long, a song counts as known (design §0.6). */
export const KNOWN_AFTER_MS = 30_000

interface Pending {
  momentId: string
  baseline: string
  /** Memory items the request carried, marked used if its picks land. */
  memoryIds: string[]
  text: string
  stopped?: boolean
}

const MOOD_LABELS = {
  calm: 'page.mood_calm',
  sad: 'page.mood_sad',
  happy: 'page.mood_happy',
  missing: 'page.mood_missing',
  fired: 'page.mood_fired',
} as const satisfies Record<MoodKey, string>

const moodLabel = (key: MoodKey) => t(MOOD_LABELS[key])

const songKey = (title = '', artist = '') => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`

function statusText(s: BuddyStatus): string {
  switch (s.phase) {
    case 'searching': return t('chat.status_searching', { count: s.searches })
    case 'reading': return t('chat.status_reading', { count: s.pages })
    case 'writing': return t('chat.status_writing')
    case 'checking': return t('chat.status_checking')
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
  const [tab, setTab] = useState<Tab>('listen')
  const [state, setState] = useState<MoodState | undefined>()
  // Kept in state so the full record repaints when the slot opens.
  const [slotKey, setSlotKey] = useState<string | null>(null)
  const [stayOnly, setStayOnly] = useState(false)
  const [slot, setSlot] = useState<import('./api').SlotData | undefined>()
  const [text, setText] = useState('')
  const [chip, setChip] = useState<MoodKey | null>(null)
  const [answer, setAnswer] = useState('')
  const [look, setLook] = useState<MoodLook>('neutral')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [autoplay, setAutoplay] = useState(false)
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
      // Someone who talked to the buddy before sees that conversation again.
      if (s.last_source) {
        const { key } = await moodApi.openSlot()
        if (!live) return
        slotRef.current = key
        setSlotKey(key)
        setSlot(await moodApi.getSlot(key).catch(() => undefined))
      }
    }).catch(e => { if (live) setError(errMessage(e) || 'load_failed') })
    return () => { live = false }
  }, [moodApi])

  const queue = state?.queue ?? []
  const explore: ExploreLevel = state?.settings?.explore ?? 'balanced'
  const recordOpen = state?.settings?.record_open ?? false

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
  const ask = useCallback(async (message: string, shown: string, memoryIds: string[]) => {
    const known = slotRef.current ?? (await moodApi.openSlot()).key
    // The reply already in the slot, so the poll waits for a NEW one.
    const before = await moodApi.getSlot(known).catch(() => undefined)
    lastAskRef.current = message
    lastShownRef.current = shown
    const key = await moodApi.ask(message)
    slotRef.current = key
    setSlotKey(key)
    setPending({ momentId: momentRef.current, baseline: replySource(latestReply(before)), memoryIds, text: shown })
  }, [moodApi])

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

  /** Record the mood and ask the buddy for songs. */
  const startMood = (mood: string, nextLook: MoodLook) => {
    if (!mood || pending || busy) return
    setLook(nextLook)
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
      if (!parsed) { setError('unreadable'); return }
      const tagLook = moodLookFor(parsed.moodTags)
      if (!chipRef.current && tagLook !== 'neutral') setLook(tagLook)
      if (parsed.picks.length === 0) {
        if (!parsed.question) {
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
        setAutoplay(false)
      } catch (e) {
        setError(errMessage(e) || 'unknown')
      } finally {
        setChecking(false)
      }
    }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [pending, moodApi])

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
        setAutoplay(true)
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
    setAutoplay(true)
  }

  // A YouTube song that stays on the player for 30 s after the person pressed
  // play counts as heard. shortcut: the embed's own play/pause state is not
  // read (that needs the IFrame API's postMessage channel); upgrade if a pause
  // should stop the clock.
  useEffect(() => {
    if (!current || !autoplay || current.source !== 'youtube') return
    if (knownSongs.has(songKey(current.title, current.artist))) return
    const pick = current
    const timer = setTimeout(() => { markKnown(pick, 'app'); markUsed() }, KNOWN_AFTER_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, autoplay])

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

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="mood-music-page">
      <MoodBackdrop look={look} moving={moving} />
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

        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {tab === 'memory' ? (
            <div className="mx-auto max-w-5xl">
              <MemoryTab memory={state?.memory ?? []} api={moodApi} onChanged={refresh} />
            </div>
          ) : tab === 'moments' ? <div className="mx-auto max-w-5xl"><MomentsTab moments={state?.moments ?? []} /></div> : (
            <div className="mx-auto grid max-w-5xl items-start gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))' }}>
              <div className="flex min-w-0 flex-col gap-3">
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

              <div className="flex min-w-0 flex-col gap-4">
                {current ? (
                  <NowPlaying
                    pick={current}
                    autoplay={autoplay}
                    busy={working}
                    onLike={() => giveFeedback(current, current.feedback === 'liked' ? '' : 'liked')}
                    onSkip={() => giveFeedback(current, 'skipped')}
                    onMore={() => moreLike(current)}
                  />
                ) : (
                  <EmptyState icon={<Play size={28} />} title={t('page.empty_title')} subtitle={t('page.empty_body')} />
                )}

                {queue.length > 1 && (
                  <section aria-label={t('page.queue')}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('page.queue')}</h3>
                    <ul className="flex flex-col gap-1.5" data-testid="mood-queue">
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
          )}
        </div>
      </div>
    </div>
  )
}
