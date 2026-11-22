/**
 * Saved playlists (`backend/playlists.py`): the person's own named lists.
 *
 * A list is made two ways: the queue on screen, saved in one press
 * ({@link SaveQueueButton}, also in the queue's header), or songs the person
 * liked, all of them or the ones ticked, filtered by a mood word when the app
 * knows which moods a song came with. The Playlists tab lists them: open one to
 * see its songs and remove one, rename it, delete it (after a confirm), or play
 * it. Playing a list replaces the queue (the page does that, `onPlay`).
 *
 * Names and titles are the person's data: they are drawn as text here and never
 * go into a message to the buddy.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ChevronRight, ListMusic, Pencil, Play, Save, Trash2, X } from 'lucide-react'
import { activeLocale } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { MoodApi, MoodState, NewPlaylistSong, Playlists, QueuedPick } from './api'
import type { PickSource } from './replyParse'

export const NAME_MAX = 80
/** The backend's caps, until the first read says otherwise. */
const LIMITS = { lists: 50, songs: 200 }

const key = (title = '', artist = '') => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`

/** A liked song, with the site it plays on and the mood words it came with. */
export interface LikedSong extends NewPlaylistSong {
  key: string
}

/**
 * Every liked song in memory, newest first. A song still in the queue keeps its
 * link. Its mood words are the tags its pick carried (feedback) and the moods of
 * the moments it was picked for. With no link, it plays on the site that last
 * worked (`play_steps`), else YouTube: the buddy searches that site for it.
 */
export function likedSongs(state: MoodState | undefined): LikedSong[] {
  if (!state) return []
  const steps = state.play_steps ?? {}
  const site: PickSource = (steps.bilibili?.updated_at ?? -1) > (steps.youtube?.updated_at ?? -1) ? 'bilibili' : 'youtube'
  const queued = new Map(state.queue.map(p => [key(p.title, p.artist), p]))
  const tags = new Map<string, Set<string>>()
  const addTags = (k: string, words: string[]) => {
    const set = tags.get(k) ?? new Set<string>()
    for (const w of words) if (w.trim()) set.add(w.trim())
    tags.set(k, set)
  }
  for (const f of state.feedback) addTags(key(f.title, f.artist), f.tags ?? [])
  for (const m of state.moments) for (const s of m.songs ?? []) addTags(key(s.title, s.artist), m.tags ?? [])
  const out: LikedSong[] = []
  const seen = new Set<string>()
  for (const m of state.memory) {
    if (m.kind !== 'liked' || !m.title) continue
    const k = key(m.title, m.artist)
    if (seen.has(k)) continue
    seen.add(k)
    const q = queued.get(k)
    out.push({
      key: k,
      title: m.title,
      artist: m.artist ?? '',
      tags: [...(tags.get(k) ?? [])].slice(0, 8),
      source: q?.source ?? site,
      ...(q?.video_id ? { video_id: q.video_id } : {}),
      ...(q?.url ? { url: q.url } : {}),
    })
  }
  return out
}

/** "平静 · Nov 22": the newest moment's mood words and today's date. */
export function defaultName(moodTags: string[], now = new Date()): string {
  const date = new Intl.DateTimeFormat(activeLocale(), { month: 'short', day: 'numeric' }).format(now)
  const words = moodTags.filter(w => w.trim()).slice(0, 2).join(' · ')
  return `${words || t('playlists.default_name')} · ${date}`.slice(0, NAME_MAX)
}

/** A queued pick as a song to save: its queue id and feedback stay behind. */
export function fromQueue(p: QueuedPick): NewPlaylistSong {
  return {
    title: p.title, artist: p.artist, why: p.why, tags: p.tags, source: p.source,
    ...(p.video_id ? { video_id: p.video_id } : {}), ...(p.url ? { url: p.url } : {}),
  }
}

function errText(e: unknown, limits = LIMITS): string {
  const body = (e as { body?: unknown })?.body
  if (typeof body === 'string') {
    if (body.includes('playlists_full')) return t('playlists.error_full', { count: limits.lists })
    if (body.includes('too_many_songs')) return t('playlists.too_many', { count: limits.songs })
  }
  return t('playlists.error', { code: e instanceof Error ? e.message : 'unknown' })
}

/** Save the queue on screen as a list, in one press, under the default name. */
export function SaveQueueButton({ api, queue, moodTags, onSaved }: {
  api: MoodApi
  queue: QueuedPick[]
  moodTags: string[]
  onSaved?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async () => {
    setBusy(true)
    setSaid(null)
    const name = defaultName(moodTags)
    try {
      await api.createPlaylist(name, queue.map(fromQueue))
      setSaid({ ok: true, text: t('playlists.saved', { name }) })
      onSaved?.()
    } catch (e) {
      setSaid({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 normal-case tracking-normal">
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || queue.length === 0}
        className="mm-press inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        data-testid="mood-save-queue"
      >
        <Save size={12} aria-hidden="true" />
        {t('playlists.save_queue')}
      </button>
      {said && (
        <span role="status" className={`text-[11px] font-normal ${said.ok ? 'text-[var(--muted)]' : 'text-[var(--danger,var(--accent))]'}`} data-testid="mood-save-queue-status">
          {said.text}
        </span>
      )}
    </span>
  )
}

export default function PlaylistsTab({ api, state, busy, onPlay }: {
  api: MoodApi
  state: MoodState | undefined
  /** The buddy is working: a list cannot replace the queue under its turn. */
  busy: boolean
  onPlay: (id: string) => Promise<void>
}) {
  const [data, setData] = useState<Playlists | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [mood, setMood] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const moodTags = state?.moments?.[0]?.tags ?? []
  const [name, setName] = useState('')

  const limits = data?.limits ?? LIMITS
  const load = useCallback(async () => { setData(await api.playlists()) }, [api])
  useEffect(() => { void load().catch(e => setError(errText(e))) }, [load])

  const act = async (work: () => Promise<unknown>) => {
    setWorking(true)
    setError(null)
    try {
      await work()
      await load()
    } catch (e) {
      setError(errText(e, limits))
    } finally {
      setWorking(false)
    }
  }

  const liked = useMemo(() => likedSongs(state), [state])
  const pruned = state?.profile?.pruned ?? 0
  const moods = useMemo(() => [...new Set(liked.flatMap(s => s.tags))], [liked])
  const shown = mood ? liked.filter(s => s.tags.includes(mood)) : liked
  const chosen = liked.filter(s => picked.has(s.key))
  const lists = data?.lists ?? []
  const full = lists.length >= limits.lists
  const tooMany = chosen.length > limits.songs

  const toggle = (k: string) => setPicked(p => {
    const next = new Set(p)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })

  const create = (e: FormEvent) => {
    e.preventDefault()
    if (!chosen.length || tooMany || full) return
    const listName = name.trim() || defaultName(mood ? [mood] : moodTags)
    void act(async () => {
      await api.createPlaylist(listName, chosen.map(({ key: _k, ...song }) => song))
      setPicked(new Set())
      setName('')
    })
  }

  const saveRename = (e: FormEvent) => {
    e.preventDefault()
    if (!renaming || !renaming.name.trim()) return
    const { id, name: next } = renaming
    void act(async () => { await api.renamePlaylist(id, next.trim()); setRenaming(null) })
  }

  const heading = 'text-xs font-semibold uppercase tracking-wide text-[var(--muted)]'
  const chipClass = (on: boolean) => `mm-press rounded-full border px-3 py-1 text-xs transition-colors ${on
    ? 'border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]'
    : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]'}`
  const inputClass = 'min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

  return (
    <div className="flex flex-col gap-4" data-testid="mood-playlists">
      <section aria-labelledby="pl-save" className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
        <h3 id="pl-save" className={heading}>{t('playlists.save_title')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <SaveQueueButton api={api} queue={state?.queue ?? []} moodTags={moodTags} onSaved={() => void load()} />
          <span className="text-xs text-[var(--muted)]">{t('playlists.queue_count', { count: state?.queue.length ?? 0 })}</span>
        </div>
        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={data?.then_buddy ?? false}
            disabled={!data || working}
            onChange={e => { const on = e.target.checked; void act(() => api.setPlaylistThenBuddy(on)) }}
            data-testid="pl-then-buddy"
          />
          <span>
            {t('playlists.then_buddy')}
            <span className="block text-xs text-[var(--muted)]">{t('playlists.then_buddy_hint')}</span>
          </span>
        </label>
        {full && <p role="status" className="text-xs text-[var(--accent)]" data-testid="pl-full">{t('playlists.error_full', { count: limits.lists })}</p>}
        <ErrorNotice message={error} />
      </section>

      <form onSubmit={create} aria-labelledby="pl-liked" className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE} data-testid="pl-from-liked">
        <h3 id="pl-liked" className={heading}>{t('playlists.liked_title', { count: liked.length })}</h3>
        {/* A taste-profile fold (0.2.13) removes older app-recorded likes: only what is left can go in a list. */}
        {pruned > 0 && (
          <p role="note" className="text-xs text-[var(--muted)]" data-testid="pl-liked-folded">
            {t('playlists.liked_folded', { count: liked.length })}
          </p>
        )}
        {liked.length === 0 ? (
          pruned > 0 ? null : <p className="text-sm text-[var(--muted)]">{t('playlists.liked_empty')}</p>
        ) : (
          <>
            {moods.length > 0 && (
              <div role="group" aria-label={t('playlists.filter')} className="flex flex-wrap gap-2">
                <button type="button" aria-pressed={mood === null} onClick={() => setMood(null)} className={chipClass(mood === null)}>{t('playlists.all_moods')}</button>
                {moods.map(m => (
                  <button key={m} type="button" aria-pressed={mood === m} onClick={() => setMood(mood === m ? null : m)} className={chipClass(mood === m)}>{m}</button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Btn type="button" onClick={() => setPicked(p => new Set([...p, ...shown.map(s => s.key)]))}>{t('playlists.pick_shown', { count: shown.length })}</Btn>
              <Btn type="button" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>{t('playlists.pick_none')}</Btn>
            </div>
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1" data-testid="pl-liked-list">
              {shown.map(s => (
                <li key={s.key}>
                  <label className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-[var(--text)] hover:bg-[var(--bg-hover)]">
                    <input type="checkbox" checked={picked.has(s.key)} onChange={() => toggle(s.key)} />
                    <span className="min-w-0 flex-1 truncate">{s.artist ? `${s.title} — ${s.artist}` : s.title}</span>
                    {s.tags.length > 0 && <span className="shrink-0 text-[11px] text-[var(--muted)]">{s.tags.slice(0, 2).join(' · ')}</span>}
                  </label>
                </li>
              ))}
            </ul>
            <label htmlFor="pl-name" className="sr-only">{t('playlists.name_label')}</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="pl-name"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={NAME_MAX}
                placeholder={defaultName(mood ? [mood] : moodTags)}
                className={inputClass}
              />
              <Btn type="submit" primary disabled={working || !chosen.length || tooMany || full}>
                {t('playlists.create', { count: chosen.length })}
              </Btn>
            </div>
            {tooMany && <p role="status" className="text-xs text-[var(--accent)]" data-testid="pl-too-many">{t('playlists.too_many', { count: limits.songs })}</p>}
          </>
        )}
      </form>

      <section aria-labelledby="pl-lists" className="flex flex-col gap-3">
        <h3 id="pl-lists" className={heading}>{t('playlists.lists_title', { count: lists.length, max: limits.lists })}</h3>
        {data && lists.length === 0 && (
          <EmptyState icon={<ListMusic size={28} />} title={t('playlists.empty_title')} subtitle={t('playlists.empty_body')} />
        )}
        <ul className="flex flex-col gap-2" data-testid="pl-lists">
          {lists.map(p => {
            const isOpen = open === p.id
            const playing = data?.active?.id === p.id && state?.last_source?.startsWith(`playlist:${p.id}:`)
            return (
              <li key={p.id} className="rounded-2xl border border-[var(--border)] p-3" style={CARD_STYLE} data-testid="pl-list">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={t(isOpen ? 'playlists.close' : 'playlists.open', { name: p.name })}
                    onClick={() => setOpen(isOpen ? null : p.id)}
                    className="mm-press rounded-full p-1 text-[var(--muted)] hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <ChevronRight size={14} aria-hidden="true" className="mm-chevron" data-open={isOpen} />
                  </button>
                  {renaming?.id === p.id ? (
                    <form onSubmit={saveRename} className="flex min-w-0 flex-1 gap-2">
                      <input
                        aria-label={t('playlists.name_label')}
                        value={renaming.name}
                        onChange={e => setRenaming({ id: p.id, name: e.target.value })}
                        maxLength={NAME_MAX}
                        className={inputClass}
                        autoFocus
                      />
                      <Btn type="submit" primary disabled={working || !renaming.name.trim()}>{t('playlists.save')}</Btn>
                      <Btn type="button" onClick={() => setRenaming(null)}>{t('playlists.cancel')}</Btn>
                    </form>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--text)]">{p.name}</span>
                      <span className="block text-xs text-[var(--muted)]">
                        {t('playlists.song_count', { count: p.songs.length })}
                        {playing && <span className="ml-2 font-semibold text-[var(--accent)]" data-testid="pl-playing">{t('playlists.playing')}</span>}
                      </span>
                    </span>
                  )}
                  {renaming?.id !== p.id && (
                    <span className="flex shrink-0 flex-wrap gap-1">
                      <Btn
                        type="button"
                        primary
                        disabled={busy || working || p.songs.length === 0}
                        aria-label={t('playlists.play', { name: p.name })}
                        onClick={() => void act(() => onPlay(p.id))}
                      >
                        <Play size={13} aria-hidden="true" />
                        {t('playlists.play_short')}
                      </Btn>
                      <Btn type="button" disabled={working} aria-label={t('playlists.rename', { name: p.name })} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                        <Pencil size={13} aria-hidden="true" />
                      </Btn>
                      <Btn type="button" disabled={working} aria-label={t('playlists.delete', { name: p.name })} onClick={() => setConfirmDelete(p.id)}>
                        <Trash2 size={13} aria-hidden="true" />
                      </Btn>
                    </span>
                  )}
                </div>
                {confirmDelete === p.id && (
                  <div role="alertdialog" aria-label={t('playlists.delete_confirm', { name: p.name })} className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2">
                    <span className="flex-1 text-sm text-[var(--text)]">{t('playlists.delete_confirm', { name: p.name })}</span>
                    <Btn type="button" primary onClick={() => { setConfirmDelete(null); void act(() => api.deletePlaylist(p.id)) }}>{t('playlists.delete_yes')}</Btn>
                    <Btn type="button" onClick={() => setConfirmDelete(null)}>{t('playlists.cancel')}</Btn>
                  </div>
                )}
                {isOpen && (
                  <ol className="mt-2 flex flex-col gap-1" data-testid="pl-songs">
                    {p.songs.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-[var(--text)]">
                        <span className="w-6 shrink-0 text-right text-xs tabular-nums text-[var(--muted)]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{s.artist ? `${s.title} — ${s.artist}` : s.title}</span>
                        <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
                          {s.source === 'youtube' ? t('page.source_youtube') : t('page.source_bilibili')}
                        </span>
                        <Btn type="button" disabled={working} aria-label={t('playlists.remove_song', { song: s.title })} onClick={() => void act(() => api.removePlaylistSong(p.id, s.id))}>
                          <X size={13} aria-hidden="true" />
                        </Btn>
                      </li>
                    ))}
                    {p.songs.length === 0 && <li className="px-2 text-sm text-[var(--muted)]">{t('playlists.no_songs')}</li>}
                  </ol>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
