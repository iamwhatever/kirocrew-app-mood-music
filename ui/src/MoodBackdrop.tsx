/**
 * The page's mood backdrop: two soft glows that drift slowly behind the content.
 *
 * Each glow's hue comes from `moods.ts` and is mixed into the theme's `--bg`, so
 * light and dark both read. The drift is a CSS animation: it stops when the
 * person pauses it (the page owns that toggle) and under
 * `prefers-reduced-motion`, where the page passes `moving={false}`. The styles
 * are inline because the host's stylesheet only carries the classes its own
 * source uses.
 */
import type { CSSProperties } from 'react'
import { moodTheme, type MoodLook } from './moods'

const KEYFRAMES = `
@keyframes mood-music-drift-a { 0%,100% { transform: translate(0,0) } 50% { transform: translate(60px,40px) } }
@keyframes mood-music-drift-b { 0%,100% { transform: translate(0,0) } 50% { transform: translate(-50px,-30px) } }
`

export default function MoodBackdrop({ look, moving }: { look: MoodLook; moving: boolean }) {
  const theme = moodTheme(look)
  const glow = (index: 0 | 1, place: CSSProperties): CSSProperties => ({
    position: 'absolute',
    borderRadius: '9999px',
    filter: 'blur(64px)',
    background: `radial-gradient(closest-side, color-mix(in oklab, hsl(${theme.hues[index]} 85% 60%) ${theme.strength}%, var(--bg)), transparent)`,
    transition: moving ? 'background 1s ease' : undefined,
    animation: moving ? `mood-music-drift-${index ? 'b' : 'a'} ${theme.driftSeconds}s ease-in-out infinite` : 'none',
    ...place,
  })

  return (
    <div
      aria-hidden="true"
      data-testid="mood-backdrop"
      data-look={look}
      data-moving={moving ? 'true' : 'false'}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', background: 'var(--bg)' }}
    >
      <style>{KEYFRAMES}</style>
      <div data-testid="mood-glow" data-hue={theme.hues[0]} style={glow(0, { left: '-15%', top: '-20%', width: '70%', height: '75%' })} />
      <div data-testid="mood-glow" data-hue={theme.hues[1]} style={glow(1, { right: '-10%', bottom: '-25%', width: '65%', height: '80%' })} />
    </div>
  )
}
