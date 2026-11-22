/**
 * The buddy's browser, live, in the player column: the same picture a chat shows
 * under a `browser` tool call, so the person can watch the buddy search and open
 * a song, and take the tab over.
 *
 * The picture itself is the host's (`live`): this app never reads frames. The
 * page passes it only when the host has a live view for an app's own session;
 * otherwise the box says Kiro Crew must be updated. The status line reads the
 * buddy's turn (`operating`), which the page already derives from its slot.
 *
 * Collapsible; the page remembers whether the person left it open.
 */
import type { ReactNode } from 'react'
import { ChevronRight, MonitorPlay } from 'lucide-react'
import { t } from './i18n'

export default function BrowserView({ open, onToggle, operating, live }: {
  open: boolean
  onToggle: (open: boolean) => void
  /** The buddy's running turn is in the browser right now. */
  operating: boolean
  /** The host's live view of the buddy's tab, or null when this host has none. */
  live: ReactNode | null
}) {
  return (
    <section
      aria-label={t('view.title')}
      className={`mm-view ${open && live ? 'mm-view-open ' : ''}flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3`}
      data-testid="mood-browser-view"
    >
      <div className="flex items-center gap-2">
        <MonitorPlay size={14} aria-hidden="true" className="text-[var(--muted)]" />
        <h3 className="text-xs font-semibold text-[var(--text)]">{t('view.title')}</h3>
        <p
          role="status"
          className={`min-w-0 flex-1 truncate text-xs ${operating ? 'font-semibold text-[var(--accent)]' : 'text-[var(--muted)]'}`}
          data-testid="mood-browser-view-status"
        >
          {operating ? t('view.operating') : t('view.idle')}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mood-browser-view-body"
          onClick={() => onToggle(!open)}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
          data-testid="mood-browser-view-toggle"
        >
          <ChevronRight size={13} aria-hidden="true" className={open ? 'rotate-90' : ''} />
          {open ? t('view.hide') : t('view.show')}
        </button>
      </div>
      {open && (
        <div id="mood-browser-view-body" className={live ? 'mm-view-body' : undefined} data-testid="mood-browser-view-body">
          {live ?? <p className="text-xs text-[var(--muted)]" data-testid="mood-browser-view-old-host">{t('view.old_host')}</p>}
        </div>
      )}
    </section>
  )
}
