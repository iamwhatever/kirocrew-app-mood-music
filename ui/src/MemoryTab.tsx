/**
 * The Memory tab (design §2.4): what the music buddy knows about the person.
 *
 * Their own notes come first and can be added, edited, pinned and deleted.
 * Songs and mood words the app recorded are listed by kind, each deletable
 * and pinnable; one the backend marks stale is greyed and labelled, and one
 * button clears every stale item after a confirm. Nothing here is removed
 * without the person pressing a button.
 */
import { useState, type FormEvent } from 'react'
import { Brain, Pin, PinOff, Trash2 } from 'lucide-react'
import { activeLocale } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { CARD_STYLE } from './cardStyle'
import type { MemoryItem, MemoryKind, MoodApi } from './api'

const NOTE_MAX = 60
/** A long list shows this many until the person asks for all of them. */
export const LIST_PREVIEW = 20

const GROUPS: readonly { kind: Exclude<MemoryKind, 'note'>; label: string }[] = [
  { kind: 'liked', label: 'memory.liked' },
  { kind: 'skipped', label: 'memory.skipped' },
  { kind: 'known', label: 'memory.known' },
  { kind: 'mood', label: 'memory.moods' },
]

const errText = (e: unknown) => {
  const body = (e as { body?: unknown })?.body
  if (typeof body === 'string' && body.includes('memory_full')) return t('memory.error_full')
  return t('memory.error', { code: e instanceof Error ? e.message : 'unknown' })
}

/** "3 days ago" in the host's language. */
export function ago(seconds: number, now = Date.now()): string {
  const days = Math.round((seconds * 1000 - now) / 86_400_000)
  const fmt = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' })
  if (Math.abs(days) >= 60) return fmt.format(Math.round(days / 30), 'month')
  return fmt.format(days, 'day')
}

const label = (m: MemoryItem) => (m.title ? (m.artist ? `${m.title} — ${m.artist}` : m.title) : m.text ?? '')

export default function MemoryTab({ memory, api, onChanged }: {
  memory: MemoryItem[]
  api: MoodApi
  onChanged: () => Promise<void>
}) {
  const [draft, setDraft] = useState('')
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
    void act(async () => { await api.addMemory({ kind: 'note', text, origin: 'user' }); setDraft('') })
  }

  const saveEdit = (e: FormEvent) => {
    e.preventDefault()
    if (!editing || !editing.text.trim()) return
    const { id, text } = editing
    void act(async () => { await api.updateMemory(id, { text: text.trim() }); setEditing(null) })
  }

  const notes = memory.filter(m => m.kind === 'note')
  const staleCount = memory.filter(m => m.stale).length

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
        <div className="mt-2 flex gap-2">
          <input
            id="memory-add"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            maxLength={NOTE_MAX}
            placeholder={t('memory.add_placeholder')}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
          <Btn type="submit" primary disabled={busy || !draft.trim()}>{t('memory.add')}</Btn>
        </div>
        <ErrorNotice className="mt-2" message={error} />
      </form>

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
