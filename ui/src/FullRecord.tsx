/**
 * "Show the full record" (design §1.9): the buddy's whole slot in Kiro Crew's
 * own transcript, with tool names, search words, URLs, the raw block and the
 * memory summary the page added. Collapsed by default; the page remembers
 * whether the person left it open.
 *
 * `ChatEmbed` is read off a namespace import, so a host without it still loads
 * the bundle; there the record is reached through "Open in full chat" alone.
 */
import * as sdk from '@kirocrew/app-sdk'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Btn } from '@kirocrew/app-sdk/ui'
import { t } from './i18n'
import { DJ_AGENT } from './api'

export default function FullRecord({ slotKey, open, onToggle, onSend }: {
  slotKey: string | null
  open: boolean
  onToggle: (open: boolean) => void
  onSend: (message: string) => Promise<unknown>
}) {
  const { openChat } = sdk.useChatLauncher()
  const Embed = sdk.ChatEmbed
  if (!slotKey) return null
  return (
    <section id="mood-full-record" className="flex flex-col gap-2" data-testid="mood-full-record">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mood-full-record-body"
          onClick={() => onToggle(!open)}
          className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        >
          <ChevronRight size={13} aria-hidden="true" className={open ? 'rotate-90' : ''} />
          {t('chat.show_record')}
        </button>
        <Btn type="button" onClick={() => openChat({ slotKey })}>
          <ExternalLink size={13} aria-hidden="true" />
          {t('chat.open_full')}
        </Btn>
      </div>
      {open && Embed && (
        <div id="mood-full-record-body" style={{ height: 420 }}>
          <Embed slotKey={slotKey} agent={DJ_AGENT} startAtBottom onSend={onSend} />
        </div>
      )}
    </section>
  )
}
