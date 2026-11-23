/**
 * The Sites tab: where the buddy may browse, and the owner's edits to it.
 *
 * The list comes from Kiro Crew (`sites.ts`, App Kit level 13): each site says
 * whether app.json declares it (a default) or the owner added it, and whether it
 * is on, waiting for approval, turned off or removed. Every edit goes through the
 * host's own calls, never a post of this app's:
 *
 * - Add (a new site, or one turned off, removed or waiting) is `requestAdd`: Kiro
 *   Crew draws its own dialog naming the site, and changes nothing unless the
 *   owner presses Allow site. Kiro Crew checks the site (https only, no wildcard
 *   host, IP, localhost or public suffix) and its reason is shown as it gave it.
 * - Turn off and Remove only shrink the list, so they apply at once.
 *
 * On a Kiro Crew without the list the tab says to update it.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Globe, Plus, RefreshCw } from 'lucide-react'
import type { BrowserSite, BrowserSiteResult, BrowserSites } from '@kirocrew/app-sdk'
import { Btn, ErrorNotice } from '@kirocrew/app-sdk/ui'
import Banner from './Banner'
import { CARD_STYLE } from './cardStyle'
import { t } from './i18n'

type Action = 'add' | 'remove' | 'disable'

/** A refusal code Kiro Crew answers, and the line the tab leads with. */
const REFUSALS: Readonly<Record<string, string>> = {
  bad_site: 'sites.refused_bad_site',
  too_many: 'sites.refused_too_many',
  not_listed: 'sites.refused_not_listed',
  owner_only: 'sites.refused_owner',
  app_token_forbidden: 'sites.refused_owner',
  dashboard_session_required: 'sites.refused_owner',
}

interface Said {
  tone: 'ok' | 'muted' | 'error'
  text: string
  /** Kiro Crew's own reason, shown as it gave it. */
  detail?: string
}

function outcome(action: Action, site: string, result: BrowserSiteResult): Said {
  if (result.ok) {
    const key = action === 'add' ? 'sites.added' : action === 'remove' ? 'sites.removed_now' : 'sites.disabled_now'
    return { tone: 'ok', text: t(key, { site }) }
  }
  if (result.code === 'declined') return { tone: 'muted', text: t('sites.declined', { site }) }
  return {
    tone: 'error',
    text: t(REFUSALS[result.code] ?? 'sites.refused_other', { code: result.code }),
    detail: result.error || undefined,
  }
}

/** The buttons a row offers: what widens the list goes through the dialog. */
function rowActions(row: BrowserSite): { action: Action; label: string; primary?: boolean }[] {
  switch (row.status) {
    case 'approved':
      return [{ action: 'disable', label: 'sites.turn_off' }, { action: 'remove', label: 'sites.remove' }]
    case 'pending':
      return [{ action: 'add', label: 'sites.allow', primary: true }, { action: 'remove', label: 'sites.remove' }]
    case 'disabled':
      return [{ action: 'add', label: 'sites.turn_on', primary: true }, { action: 'remove', label: 'sites.remove' }]
    case 'removed':
      return [{ action: 'add', label: 'sites.add_back' }]
    default:
      return []
  }
}

const badge = 'shrink-0 rounded-full border px-2 py-0.5 text-[10px]'
const STATUS_CLASS: Readonly<Record<BrowserSite['status'], string>> = {
  approved: 'border-[var(--accent)] font-semibold text-[var(--accent)]',
  pending: 'border-[var(--border)] text-[var(--text)]',
  disabled: 'border-[var(--border)] text-[var(--muted)]',
  removed: 'border-[var(--border)] text-[var(--muted)] line-through',
}

export default function SitesTab({ sites }: { sites: BrowserSites | null }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Said | null>(null)
  const refresh = sites?.refresh

  // The owner may have changed the list on the app's page in Kiro Crew meanwhile.
  useEffect(() => { void refresh?.() }, [refresh])

  if (!sites) {
    return (
      <Banner testId="sites-old-host" icon={<RefreshCw size={14} aria-hidden="true" />} title={t('sites.old_host_title')} body={t('sites.old_host_body')} />
    )
  }

  const run = async (action: Action, site: string) => {
    setBusy(true)
    setSaid(null)
    try {
      const call = action === 'add' ? sites.requestAdd : action === 'remove' ? sites.requestRemove : sites.requestDisable
      const result = await call(site)
      setSaid(outcome(action, site, result))
      if (result.ok && action === 'add' && site === draft.trim()) setDraft('')
    } finally {
      setBusy(false)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const site = draft.trim()
    if (site) void run('add', site)
  }

  const heading = 'text-xs font-semibold uppercase tracking-wide text-[var(--muted)]'
  const rows = sites.sites ?? []
  const saidClass = said?.tone === 'error' ? 'text-[var(--danger,var(--accent))]' : said?.tone === 'ok' ? 'text-[var(--text)]' : 'text-[var(--muted)]'

  return (
    <div className="mm-sites" data-testid="mood-sites">
      <section aria-labelledby="sites-list" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 id="sites-list" className={heading}>{t('sites.list_title')}</h3>
          {sites.sites && <span className="text-xs text-[var(--muted)]" data-testid="sites-active-count">{t('sites.active_count', { count: sites.active.length })}</span>}
        </div>
        {sites.error && !sites.sites ? (
          <div className="flex flex-col gap-2" data-testid="sites-read-error">
            <ErrorNotice message={t('sites.read_error', { code: sites.error })} />
            <span><Btn type="button" disabled={sites.loading} onClick={() => void sites.refresh()}>{t('sites.retry')}</Btn></span>
          </div>
        ) : !sites.sites ? (
          <p className="text-sm text-[var(--muted)]">{t('sites.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]" data-testid="sites-empty">{t('sites.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="sites-rows">
            {rows.map(row => (
              <li key={row.site} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] px-3 py-2" data-testid="site-row" data-site={row.site} data-status={row.status}>
                <span className="flex min-w-0 items-center gap-2">
                  <Globe size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
                  <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-[var(--text)]">{row.site}</code>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                <span className={`${badge} border-[var(--border)] text-[var(--muted)]`} data-testid="site-source">
                  {row.source === 'app' ? t('sites.source_app') : t('sites.source_owner')}
                </span>
                <span className={`${badge} ${STATUS_CLASS[row.status] ?? ''}`} data-testid="site-status">{t(`sites.status_${row.status}`)}</span>
                <span className="ml-auto flex shrink-0 flex-wrap gap-1">
                  {rowActions(row).map(a => (
                    <Btn
                      key={a.action}
                      type="button"
                      primary={a.primary}
                      disabled={busy}
                      aria-label={t(`${a.label}_named`, { site: row.site })}
                      onClick={() => void run(a.action, row.site)}
                    >
                      {t(a.label)}
                    </Btn>
                  ))}
                </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex min-w-0 flex-col gap-4">
        <form onSubmit={add} aria-labelledby="sites-add" className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE} data-testid="sites-add">
          <h3 id="sites-add" className={heading}>{t('sites.add_title')}</h3>
          <label htmlFor="sites-add-input" className="text-sm text-[var(--text)]">{t('sites.add_label')}</label>
          <div className="flex flex-wrap gap-2">
            <input
              id="sites-add-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="https://music.example.com/song/*"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
            <Btn type="submit" primary disabled={busy || !draft.trim()}>
              <Plus size={13} aria-hidden="true" />
              {t('sites.add')}
            </Btn>
          </div>
          <p className="text-xs text-[var(--muted)]">{t('sites.add_rules')}</p>
          {said && (
            <div role="status" className={`text-sm ${saidClass}`} data-testid="sites-said" data-tone={said.tone}>
              <p>{said.text}</p>
              {said.detail && <p className="mt-1 break-all text-xs text-[var(--muted)]" data-testid="sites-said-detail">{t('sites.crew_said', { reason: said.detail })}</p>}
            </div>
          )}
        </form>

        <section aria-labelledby="sites-how" className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-4" style={CARD_STYLE}>
          <h3 id="sites-how" className={heading}>{t('sites.how_title')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-[var(--text)]">
            <li>{t('sites.how_buddy')}</li>
            <li>{t('sites.how_add')}</li>
            <li>{t('sites.how_new')}</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
