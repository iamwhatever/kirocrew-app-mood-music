/**
 * The page's mood backdrop: one scene (`moods.ts`) painted behind the content.
 *
 * Every style is built here from the scene's bounded numbers and names; the
 * scene never carries CSS. Each hue is mixed into the theme's `--bg`, so light
 * and dark both read. Four patterns, all CSS: drifting glows, slow waves, a few
 * floating particles, an aurora band. Motion is CSS animation on `transform`
 * only, with no per-frame script. It stops when the person pauses it, under
 * `prefers-reduced-motion`, and while the page is hidden.
 *
 * A new scene (or the queue moving along the arc) fades in over the old one in
 * {@link FADE_MS}; the old layer is dropped after. Under reduced motion it is
 * swapped at once. The styles are inline because the host's stylesheet only
 * carries the classes its own source uses.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { mixPercent, type Motion, type Lightness, type Saturation, type Scene, type SceneArc } from './moods'

/** The crossfade between two scenes. */
export const FADE_MS = 2200

const SAT: Record<Saturation, number> = { soft: 45, medium: 70, vivid: 90 }
const LIGHT: Record<Lightness, number> = { deep: 42, medium: 55, bright: 66 }
/** Animation durations are multiplied by this: a calm scene moves slower. */
const SPEED: Record<Motion, number> = { slow: 1.7, medium: 1, lively: 0.55 }
const ARC_STEP: Record<SceneArc, number> = { stay: 0, turn: 0.5, lift: 1 }

const KEYFRAMES = `
@keyframes mm-drift-a { 0%,100% { transform: translate(0,0) scale(1) } 50% { transform: translate(8%,6%) scale(1.08) } }
@keyframes mm-drift-b { 0%,100% { transform: translate(0,0) scale(1) } 50% { transform: translate(-7%,-5%) scale(1.05) } }
@keyframes mm-drift-c { 0%,100% { transform: translate(0,0) } 50% { transform: translate(5%,-8%) } }
@keyframes mm-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes mm-rise { 0% { transform: translateY(0); opacity: 0 } 15% { opacity: 1 } 85% { opacity: 1 } 100% { transform: translateY(-60vh); opacity: 0 } }
@keyframes mm-sway { 0%,100% { transform: translateX(-6%) skewY(-8deg) } 50% { transform: translateX(6%) skewY(-4deg) } }
@keyframes mm-fade-in { from { opacity: 0 } to { opacity: 1 } }
`

/** Where along the arc the scene is: the further of its own hint and the song playing. */
export function arcStep(scene: Scene, playing?: SceneArc): number {
  return Math.max(ARC_STEP[scene.arc], playing ? ARC_STEP[playing] : 0)
}

/** *from* moved the share *t* of the short way round the colour wheel toward *to*. */
export function mixHue(from: number, to: number, t: number): number {
  const d = ((to - from + 540) % 360) - 180
  return Math.round((from + d * t + 360) % 360)
}

/** The hues painted at arc step *step*: each drifts halfway toward the lift (last) hue by the end. */
export function paintedHues(scene: Scene, step: number): number[] {
  const lift = scene.hues[scene.hues.length - 1]
  const out = scene.hues.map(h => mixHue(h, lift, step * 0.5))
  return out.length === 2 ? [...out, out[0]] : out
}

/** Fixed spots for the particles, so a render never moves them. */
const SPOTS = [
  [8, 92, 0], [18, 80, 3], [27, 96, 7], [36, 86, 1], [45, 99, 5], [54, 84, 9], [63, 94, 2],
  [72, 82, 6], [81, 97, 4], [90, 88, 8], [13, 70, 10], [58, 72, 11], [77, 66, 12], [40, 64, 13],
] as const

interface Layer { id: number; scene: Scene; step: number }

function SceneLayer({ scene, step, moving, fading }: { scene: Scene; step: number; moving: boolean; fading: boolean }) {
  const hues = paintedHues(scene, step)
  const mix = mixPercent(scene.strength)
  const color = (h: number, extra = 0) =>
    `color-mix(in oklab, hsl(${h} ${SAT[scene.saturation]}% ${LIGHT[scene.lightness]}%) ${Math.min(80, mix + extra)}%, var(--bg))`
  const speed = SPEED[scene.motion]
  const anim = (name: string, seconds: number, delay = 0) =>
    (moving ? `${name} ${(seconds * speed).toFixed(1)}s ${delay ? `-${delay}s ` : ''}ease-in-out infinite` : 'none')
  const glow = (i: number, place: CSSProperties, name: string, seconds: number): ReactNode => (
    <div
      key={`g${i}`}
      data-testid="mood-glow"
      data-hue={hues[i]}
      style={{
        position: 'absolute', borderRadius: '9999px', filter: 'blur(60px)',
        background: `radial-gradient(closest-side, ${color(hues[i])}, transparent)`,
        animation: anim(name, seconds), willChange: moving ? 'transform' : undefined, ...place,
      }}
    />
  )
  const glows = [
    glow(0, { left: '-15%', top: '-20%', width: '70%', height: '75%' }, 'mm-drift-a', 24),
    glow(1, { right: '-10%', bottom: '-25%', width: '65%', height: '80%' }, 'mm-drift-b', 30),
    glow(2, { left: '30%', top: '25%', width: '45%', height: '50%' }, 'mm-drift-c', 36),
  ]
  let pattern: ReactNode = null
  if (scene.pattern === 'waves') {
    pattern = [0, 1, 2].map(i => (
      <div
        key={`w${i}`}
        data-testid="mood-wave"
        style={{
          position: 'absolute', left: '-40%', width: '180%', aspectRatio: '1 / 1', top: `${58 + i * 7}%`,
          borderRadius: `${40 + i * 3}%`, background: color(hues[i], -6), opacity: 0.55,
          animation: anim('mm-spin', 60 + i * 18), animationTimingFunction: 'linear',
        }}
      />
    ))
  } else if (scene.pattern === 'particles') {
    pattern = SPOTS.map(([x, y, delay], i) => (
      <div
        key={`p${i}`}
        data-testid="mood-particle"
        style={{
          position: 'absolute', left: `${x}%`, top: `${y}%`, width: i % 3 ? 10 : 16, height: i % 3 ? 10 : 16,
          borderRadius: '9999px', background: color(hues[i % hues.length], 18), filter: 'blur(1px)',
          opacity: moving ? undefined : 0.7, animation: anim('mm-rise', 16 + (i % 5) * 3, delay),
        }}
      />
    ))
  } else if (scene.pattern === 'aurora') {
    pattern = [0, 1, 2].map(i => (
      <div
        key={`a${i}`}
        data-testid="mood-aurora"
        style={{
          position: 'absolute', left: '-20%', width: '140%', top: `${8 + i * 14}%`, height: '22%', filter: 'blur(40px)',
          background: `linear-gradient(90deg, transparent, ${color(hues[i], 6)}, ${color(hues[(i + 1) % hues.length], 6)}, transparent)`,
          animation: anim('mm-sway', 22 + i * 6, i * 4),
        }}
      />
    ))
  }
  return (
    <div
      data-testid="mood-scene"
      data-pattern={scene.pattern}
      style={{
        position: 'absolute', inset: 0, background: 'var(--bg)',
        animation: fading ? `mm-fade-in ${FADE_MS}ms ease forwards` : undefined,
      }}
    >
      {glows}
      {pattern}
    </div>
  )
}

/** Whether the page is visible, following `visibilitychange`. */
function usePageVisible(): boolean {
  const read = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const [visible, setVisible] = useState(read)
  useEffect(() => {
    const on = () => setVisible(read())
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

export default function MoodBackdrop({ scene, playing, moving, reduced }: {
  scene: Scene
  /** The arc of the song playing, so the scene drifts toward its lift hue across the queue. */
  playing?: SceneArc
  moving: boolean
  reduced: boolean
}) {
  const visible = usePageVisible()
  const live = moving && visible && !reduced
  const step = arcStep(scene, playing)
  const key = JSON.stringify([scene.hues, scene.saturation, scene.lightness, scene.strength, scene.motion, scene.pattern, step])
  const nextId = useRef(1)
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, scene, step }])
  const shown = useRef(key)

  useEffect(() => {
    if (shown.current === key) return
    shown.current = key
    const id = nextId.current++
    if (reduced) {
      setLayers([{ id, scene, step }])
      return
    }
    setLayers(ls => [...ls.slice(-1), { id, scene, step }])
    const timer = setTimeout(() => setLayers(ls => ls.filter(l => l.id >= id)), FADE_MS + 100)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced])

  return (
    <div
      aria-hidden="true"
      data-testid="mood-backdrop"
      data-look={scene.source}
      data-pattern={scene.pattern}
      data-hues={scene.hues.join(',')}
      data-moving={live ? 'true' : 'false'}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', background: 'var(--bg)' }}
    >
      <style>{KEYFRAMES}</style>
      {layers.map((l, i) => (
        <SceneLayer key={l.id} scene={l.scene} step={l.step} moving={live} fading={i > 0 && !reduced} />
      ))}
    </div>
  )
}
