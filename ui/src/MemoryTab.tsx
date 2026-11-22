/**
 * The Memory tab (design §2.4): what the music buddy knows about the person.
 *
 * Their own notes come first and can be added, edited, pinned and deleted.
 * Songs and mood words the app recorded are listed by kind, each deletable
 * and pinnable; one the backend marks stale is greyed and labelled, and one
 * button clears every stale item after a confirm. Nothing here is removed
 * without the person pressing a button.
 *
 * A dislike (a song, or a few words like "太吵的电子") is added here by hand.
 * The taste profile the backend folds from likes, skips and dislikes is shown
 * at the top: each line with the songs it came from, editable (an edited line
 * is the person's and no later fold replaces it), deletable, and re-runnable.
 * A kind nearly full, or full of the person's own and pinned items, says so.
 */
import { useState, type FormEvent } from 'react'
import { Brain, Pin, PinOff, RefreshCw, Trash2 } from 'lucide-react'
import { activeLocale } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { MemoryItem, MemoryKind, MemoryRoom, MoodApi, ProfileLine, TasteProfile, TasteStatus } from './api'

/** The longest note and worded dislike the backend takes (`routes.py`). */
const NOTE_MAX = 200
const DISLIKE_MAX = 100
const TITLE_MAX = 200
/** The longest profile line (`store.PROFILE_LINE_CHARS`). */
const LINE_MAX = 120
/** A kind this full (share of its cap) is "nearly full". */
export const NEAR_FULL = 0.9
/** A long list shows this many until the person asks for all of them. */
export const LIST_PREVIEW = 20

const GROUPS: readonly { kind: Exclude<MemoryKind, 'note'>; label: string }[] = [
  { kind: 'dislike', label: 'memory.dislikes' },
  { kind: 'liked', label: 'memory.liked' },
  { kind: 'skipped', label: 'memory.skipped' },
  { kind: 'known', label: 'memory.known' },
  { kind: 'mood', label: 'memory.moods' },
]

const KINDS: readonly MemoryKind[] = ['note', 'dislike', 'liked', 'skipped', 'known', 'mood']
const kindName = (kind: string) => (KINDS.includes(kind as MemoryKind) ? t(`memory.kind_${kind}`) : kind)

const errText = (e: unknown) => {
  const body = (e as { body?: unknown })?.body
  if (typeof body === 'string' && body.includes('memory_full')) {
    let kind = ''
    try { kind = String((JSON.parse(body) as { kind?: unknown }).kind ?? '') } catch { /* an older backend's body */ }
    return kind ? t('memory.error_full_kind', { kind: kindName(kind) }) : t('memory.error_full')
  }
  return t('memory.error', { code: e instanceof Error ? e.message : 'unknown' })
}

export interface RoomNotice { kind: MemoryKind; level: 'full' | 'near_own' | 'near'; count: number; cap: number }

/**
 * The kinds to warn about: full of the person's own and pinned items (adding
 * fails), nearly full of them, or nearly full (the oldest app items make room).
 */
export function roomNotices(room: MemoryRoom | undefined): RoomNotice[] {
  const out: RoomNotice[] = []
  for (const kind of KINDS) {
    const r = room?.[kind]
    if (!r || r.cap <= 0) continue
    const near = r.cap * NEAR_FULL
    if (r.own >= r.cap) out.push({ kind, level: 'full', count: r.count, cap: r.cap })
    else if (r.own >= near) out.push({ kind, level: 'near_own', count: r.count, cap: r.cap })
    else if (r.count >= near) out.push({ kind, level: 'near', count: r.count, cap: r.cap })
  }
  return out
}

type AddKind = 'note' | 'dislike_text' | 'dislike_song'

/** "3 days ago" in the host's language. */
export function ago(seconds: number, now = Date.now()): string {
  const days = Math.round((seconds * 1000 - now) / 86_400_000)
  const fmt = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' })
  if (Math.abs(days) >= 60) return fmt.format(Math.round(days / 30), 'month')
  return fmt.format(days, 'day')
}

const label = (m: { title?: string; artist?: string; text?: string }) =>
  (m.title ? (m.artist ? `${m.title} — ${m.artist}` : m.title) : m.text ?? '')

export default function MemoryTab({ memory, api, onChanged, profile = null, room, taste }: {
  memory: MemoryItem[]
  api: MoodApi
  onChanged: () => Promise<void>
  profile?: TasteProfile | null
  room?: MemoryRoom
  taste?: TasteStatus
}) {
  const [addKind, setAddKind] = useState<AddKind>('note')
  const [draft, setDraft] = useState('')
  const [artist, setArtist] = useState('')
  const [lineEdit, setLineEdit] = useState<{ id: string; text: string } | null>(null)
  const [confirmProfile, setConfirmProfile] = useState(false)
  const [runNote, setRunNote] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await onChanged()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    const item = addKind === 'note' ? { kind: 'note' as const, text, origin: 'user' as const }
      : addKind === 'dislike_text' ? { kind: 'dislike' as const, text, origin: 'user' as const }
        : { kind: 'dislike' as const, title: text, ...(artist.trim() ? { artist: artist.trim() } : {}), origin: 'user' as const }
    void act(async () => { await api.addMemory(item); setDraft(''); setArtist('') })
  }

  const saveLine = (e: FormEvent) => {
    e.preventDefault()
    if (!lineEdit || !lineEdit.text.trim()) return
    const { id, text } = lineEdit
    void act(async () => { await api.editProfileLine(id, text.trim()); setLineEdit(null) })
  }

  const runAgain = () => void act(async () => {
    const { started } = await api.runProfile()
    setRunNote(started ? t('profile.started') : t('profile.not_started'))
  })

  const saveEdit = (e: FormEvent) => {
    e.preventDefault()
    if (!editing || !editing.text.trim()) return
    const { id, text } = editing
    void act(async () => { await api.updateMemory(id, { text: text.trim() }); setEditing(null) })
  }

  const notes = memory.filter(m => m.kind === 'note')
  const staleCount = memory.filter(m => m.stale).length
  const notices = roomNotices(room)
  const draftMax = addKind === 'note' ? NOTE_MAX : addKind === 'dislike_text' ? DISLIKE_MAX : TITLE_MAX

  const profileSide = (side: 'likes' | 'dislikes', lines: ProfileLine[]) => lines.length > 0 && (
    <div>
      <h4 className="mt-2 text-xs font-medium text-[var(--muted)]">{t(`profile.${side}`)}</h4>
      <ul className="mt-1 flex flex-col gap-1.5" data-testid={`profile-${side}`}>
        {lines.map(ln => (
          <li key={ln.id} className="flex items-start gap-2">
            {lineEdit?.id === ln.id ? (
              <form onSubmit={saveLine} className="flex min-w-0 flex-1 gap-2">
                <input
                  aria-label={t('profile.edit_label')}
                  value={lineEdit.text}
                  onChange={e => setLineEdit({ id: ln.id, text: e.target.value })}
                  maxLength={LINE_MAX}
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                />
                <Btn type="submit" primary disabled={busy || !lineEdit.text.trim()}>{t('memory.save')}</Btn>
                <Btn type="button" onClick={() => setLineEdit(null)}>{t('memory.cancel')}</Btn>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--text)]">{ln.text}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {[
                      ln.sources.length > 0 ? t('profile.from', { songs: ln.sources.map(label).join('; ') }) : '',
                      ln.origin === 'user' ? t('profile.by_you') : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Btn type="button" disabled={busy} aria-label={t('profile.edit_line', { line: ln.text })}
                  onClick={() => setLineEdit({ id: ln.id, text: ln.text })}>
                  {t('memory.edit')}
                </Btn>
                <Btn type="button" disabled={busy} aria-label={t('profile.delete_line', { line: ln.text })}
                  onClick={() => void act(() => api.deleteProfileLine(ln.id))}>
                  <Trash2 size={13} aria-hidden="true" />
                </Btn>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )

  const actions = (m: MemoryItem) => (
    <span className="flex shrink-0 gap-1">
      <Btn
        type="button"
        disabled={busy}
        aria-pressed={m.pinned}
        aria-label={m.pinned ? t('memory.unpin', { item: label(m) }) : t('memory.pin', { item: label(m) })}
        onClick={() => void act(() => api.updateMemory(m.id, { pinned: !m.pinned }))}
      >
        {m.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
      </Btn>
      <Btn
        type="button"
        disabled={busy}
        aria-label={t('memory.delete', { item: label(m) })}
        onClick={() => void act(() => api.deleteMemory(m.id))}
      >
        <Trash2 size={13} aria-hidden="true" />
      </Btn>
    </span>
  )

  return (
    <div className="flex flex-col gap-4" data-testid="mood-memory">
      <form onSubmit={add} className="rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
        <label htmlFor="memory-add" className="text-sm font-medium text-[var(--text)]">{t('memory.add_label')}</label>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            aria-label={t('memory.add_kind')}
            value={addKind}
            onChange={e => setAddKind(e.target.value as AddKind)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <option value="note">{t('memory.add_note')}</option>
            <option value="dislike_text">{t('memory.add_dislike_text')}</option>
            <option value="dislike_song">{t('memory.add_dislike_song')}</option>
          </select>
          <input
            id="memory-add"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            maxLength={draftMax}
            aria-describedby={addKind === 'dislike_song' ? undefined : 'memory-add-hint'}
            placeholder={addKind === 'note' ? t('memory.add_placeholder')
              : addKind === 'dislike_text' ? t('memory.dislike_placeholder') : t('memory.title_placeholder')}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
          {addKind === 'dislike_song' && (
            <input
              aria-label={t('memory.artist_label')}
              value={artist}
              onChange={e => setArtist(e.target.value)}
              maxLength={TITLE_MAX}
              placeholder={t('memory.artist_label')}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          )}
          <Btn type="submit" primary disabled={busy || !draft.trim()}>{t('memory.add')}</Btn>
        </div>
        {addKind !== 'dislike_song' && (
          <p id="memory-add-hint" className="mt-1 text-xs text-[var(--muted)]">
            {t('memory.chars_left', { count: draftMax - draft.length })}
          </p>
        )}
        <ErrorNotice className="mt-2" message={error} />
        {notices.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="memory-room" role="status">
            {notices.map(n => (
              <li key={n.kind} className={`text-xs ${n.level === 'full' ? 'font-medium text-[var(--danger,var(--text))]' : 'text-[var(--muted)]'}`}>
                {t(`memory.room_${n.level}`, { kind: kindName(n.kind), count: n.count, cap: n.cap })}
              </li>
            ))}
          </ul>
        )}
      </form>

      <section aria-labelledby="memory-profile" className="rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE} data-testid="memory-profile">
        <h3 id="memory-profile" className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('profile.title')}</h3>
        {profile && (profile.likes.length > 0 || profile.dislikes.length > 0) ? (
          <>
            {profileSide('likes', profile.likes)}
            {profileSide('dislikes', profile.dislikes)}
            <p className="mt-2 text-xs text-[var(--muted)]" data-testid="profile-meta">
              {t('profile.meta', { folded: profile.folded, pruned: profile.pruned, when: ago(profile.updated_at) })}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--muted)]">
            {t('profile.empty', { every: taste?.every ?? 20, pending: taste?.pending ?? 0 })}
          </p>
        )}
        {taste?.running ? (
          <p className="mt-1 text-xs text-[var(--muted)]" role="status">{t('profile.running')}</p>
        ) : taste?.error ? (
          <p className="mt-1 text-xs text-[var(--muted)]" role="status">{t(`profile.error_${taste.error === 'no_model' ? 'no_model' : 'bad_output'}`)}</p>
        ) : profile && taste ? (
          <p className="mt-1 text-xs text-[var(--muted)]">{t('profile.pending', { pending: taste.pending, every: taste.every })}</p>
        ) : null}
        {runNote && <p className="mt-1 text-xs text-[var(--muted)]" role="status">{runNote}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Btn type="button" disabled={busy || taste?.running} onClick={runAgain}>
            <RefreshCw size={13} aria-hidden="true" className="mr-1 inline" />
            {profile ? t('profile.run') : t('profile.run_first')}
          </Btn>
          {profile && (confirmProfile ? (
            <>
              <span className="text-sm text-[var(--text)]" role="status">{t('profile.delete_confirm')}</span>
              <Btn type="button" danger disabled={busy} onClick={() => void act(async () => { await api.deleteProfile(); setConfirmProfile(false) })}>
                {t('profile.delete_yes')}
              </Btn>
              <Btn type="button" onClick={() => setConfirmProfile(false)}>{t('memory.cancel')}</Btn>
            </>
          ) : (
            <Btn type="button" disabled={busy} onClick={() => setConfirmProfile(true)}>{t('profile.delete')}</Btn>
          ))}
        </div>
      </section>

      {memory.length === 0 ? (
        <EmptyState icon={<Brain size={28} />} title={t('memory.empty_title')} subtitle={t('memory.empty_body')} />
      ) : (
        <>
          <section aria-labelledby="memory-notes" className="rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
            <h3 id="memory-notes" className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('memory.notes')}</h3>
            {notes.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">{t('memory.notes_empty')}</p>}
            <ul className="mt-2 flex flex-col gap-1.5">
              {notes.map(m => (
                <li key={m.id} className="flex items-center gap-2">
                  {editing?.id === m.id ? (
                    <form onSubmit={saveEdit} className="flex min-w-0 flex-1 gap-2">
                      <input
                        aria-label={t('memory.edit_label')}
                        value={editing.text}
                        onChange={e => setEditing({ id: m.id, text: e.target.value })}
                        maxLength={NOTE_MAX}
                        autoFocus
                        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      />
                      <Btn type="submit" primary disabled={busy || !editing.text.trim()}>{t('memory.save')}</Btn>
                      <Btn type="button" onClick={() => setEditing(null)}>{t('memory.cancel')}</Btn>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 text-sm text-[var(--text)]">
                        {m.pinned && <Pin size={12} className="mr-1 inline text-[var(--accent)]" aria-label={t('memory.pinned')} />}
                        {m.text}
                      </span>
                      <Btn type="button" disabled={busy} onClick={() => setEditing({ id: m.id, text: m.text ?? '' })}>
                        {t('memory.edit')}
                      </Btn>
                      {actions(m)}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {GROUPS.map(({ kind, label: groupLabel }) => {
            const items = memory.filter(m => m.kind === kind)
            if (items.length === 0) return null
            const shown = open[kind] ? items : items.slice(0, LIST_PREVIEW)
            return (
              <section key={kind} aria-labelledby={`memory-${kind}`} className="rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
                <h3 id={`memory-${kind}`} className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                  {t(groupLabel, { count: items.length })}
                </h3>
                <ul className="mt-2 flex flex-col gap-1.5" data-testid={`memory-list-${kind}`}>
                  {shown.map(m => (
                    <li key={m.id} className={`flex items-center gap-2 ${m.stale ? 'opacity-55' : ''}`}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[var(--text)]">
                          {m.pinned && <Pin size={12} className="mr-1 inline text-[var(--accent)]" aria-label={t('memory.pinned')} />}
                          {label(m)}
                        </span>
                        <span className="block text-xs text-[var(--muted)]">
                          {m.stale ? `${t('memory.stale')} · ` : ''}{ago(m.last_used_at)}
                          {m.origin === 'user' ? ` · ${t('memory.by_you')}` : ''}
                        </span>
                      </span>
                      {actions(m)}
                    </li>
                  ))}
                </ul>
                {items.length > LIST_PREVIEW && (
                  <Btn type="button" className="mt-2" onClick={() => setOpen(o => ({ ...o, [kind]: !o[kind] }))}>
                    {open[kind] ? t('memory.show_less') : t('memory.show_all', { count: items.length })}
                  </Btn>
                )}
              </section>
            )
          })}

          {staleCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {confirmClear ? (
                <>
                  <span className="text-sm text-[var(--text)]" role="status">{t('memory.clear_confirm', { count: staleCount })}</span>
                  <Btn type="button" danger disabled={busy} onClick={() => void act(async () => { await api.clearStale(); setConfirmClear(false) })}>
                    {t('memory.clear_yes')}
                  </Btn>
                  <Btn type="button" onClick={() => setConfirmClear(false)}>{t('memory.cancel')}</Btn>
                </>
              ) : (
                <Btn type="button" disabled={busy} onClick={() => setConfirmClear(true)}>
                  {t('memory.clear_stale', { count: staleCount })}
                </Btn>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
