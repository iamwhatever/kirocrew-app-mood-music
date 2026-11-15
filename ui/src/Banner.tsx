/** A notice the person must see, with the buttons that move it on (design §1.8). */
import type { ReactNode } from 'react'
import { CARD_STYLE } from './cardStyle'

export default function Banner({ title, body, icon, children, testId }: {
  title: string
  body?: ReactNode
  icon?: ReactNode
  children?: ReactNode
  testId: string
}) {
  return (
    <section role="alert" className="rounded-2xl border border-[var(--accent)] p-3" style={CARD_STYLE} data-testid={testId}>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
        {icon}
        {title}
      </p>
      {body && <div className="mt-1 text-sm text-[var(--text)]">{body}</div>}
      {children && <div className="mt-2 flex flex-wrap gap-2">{children}</div>}
    </section>
  )
}
