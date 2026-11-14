import type { CSSProperties } from 'react'

/** A translucent card over the mood backdrop. Inline, because the host
 *  stylesheet carries only the classes its own source uses. */
export const CARD_STYLE: CSSProperties = {
  background: 'color-mix(in oklab, var(--card) 82%, transparent)',
  backdropFilter: 'blur(12px)',
}
