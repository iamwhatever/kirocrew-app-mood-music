/**
 * The mood chips, and the scene the page's backdrop paints.
 *
 * A scene is bounded parameters only: two or three hues, a saturation and a
 * lightness band, a strength, a motion speed, one pattern from a fixed set, and
 * an arc hint. The DJ may send one in its reply (`replyParse.ts`), so
 * {@link parseScene} treats it as untrusted: anything outside these bounds is
 * dropped whole and the page keeps the scene it has. No CSS, HTML or URL from
 * the model ever reaches the page; `MoodBackdrop` builds every style from
 * these numbers and names.
 *
 * The backdrop never paints a hue straight: it mixes each one into the theme's
 * own `--bg`, so the same scene reads soft on a light theme and deep on a dark
 * one, and text keeps the theme's `--text` contrast.
 */

export const MOOD_KEYS = ['calm', 'sad', 'happy', 'missing', 'fired'] as const
export type MoodKey = (typeof MOOD_KEYS)[number]
/** `neutral` is the resting look: no chip picked and nothing recognised. */
export type MoodLook = MoodKey | 'neutral'

export const PATTERNS = ['glows', 'waves', 'particles', 'aurora'] as const
export type Pattern = (typeof PATTERNS)[number]
export const MOTIONS = ['slow', 'medium', 'lively'] as const
export type Motion = (typeof MOTIONS)[number]
export const SATURATIONS = ['soft', 'medium', 'vivid'] as const
export type Saturation = (typeof SATURATIONS)[number]
export const LIGHTNESSES = ['deep', 'medium', 'bright'] as const
export type Lightness = (typeof LIGHTNESSES)[number]
export const SCENE_ARCS = ['stay', 'turn', 'lift'] as const
export type SceneArc = (typeof SCENE_ARCS)[number]

export interface Scene {
  /** Two or three hues (0-359): stay first, the lift hue last. */
  hues: number[]
  saturation: Saturation
  lightness: Lightness
  /** 0-1: how much colour is mixed into `--bg` (see {@link mixPercent}). */
  strength: number
  motion: Motion
  pattern: Pattern
  /** Where along stay -> turn -> lift the scene starts. */
  arc: SceneArc
  /** A chip preset's key, or `dj` for a scene the buddy chose. */
  source: MoodLook | 'dj'
}

/** Strength 0-1 maps onto this much colour in `--bg`, in percent: always visible, never loud. */
export const MIX_RANGE = [24, 58] as const

export function mixPercent(strength: number): number {
  return Math.round(MIX_RANGE[0] + (MIX_RANGE[1] - MIX_RANGE[0]) * clamp01(strength))
}

const PRESETS: Record<MoodLook, Omit<Scene, 'source'>> = {
  calm: { hues: [178, 196, 150], saturation: 'medium', lightness: 'medium', strength: 0.55, motion: 'slow', pattern: 'waves', arc: 'stay' },
  sad: { hues: [222, 244, 205], saturation: 'medium', lightness: 'deep', strength: 0.6, motion: 'slow', pattern: 'glows', arc: 'stay' },
  happy: { hues: [44, 18, 335], saturation: 'vivid', lightness: 'bright', strength: 0.7, motion: 'lively', pattern: 'particles', arc: 'stay' },
  missing: { hues: [338, 20, 268], saturation: 'medium', lightness: 'medium', strength: 0.6, motion: 'slow', pattern: 'aurora', arc: 'stay' },
  fired: { hues: [6, 28, 350], saturation: 'vivid', lightness: 'medium', strength: 0.8, motion: 'lively', pattern: 'glows', arc: 'stay' },
  neutral: { hues: [212, 240], saturation: 'soft', lightness: 'medium', strength: 0.25, motion: 'medium', pattern: 'glows', arc: 'stay' },
}

export function isMoodKey(value: unknown): value is MoodKey {
  return typeof value === 'string' && (MOOD_KEYS as readonly string[]).includes(value)
}

/** The preset scene for a chip; anything else (an unknown chip, free text) is the neutral one. */
export function presetScene(look: unknown): Scene {
  const key: MoodLook = isMoodKey(look) ? look : 'neutral'
  const p = PRESETS[key]
  return { ...p, hues: [...p.hues], source: key }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined) return fallback
  return allowed.includes(value as T) ? (value as T) : null
}

/**
 * A scene from untrusted input (the DJ's block, or the saved page view), or
 * null when it does not fit the bounds. Hues must be two or three finite
 * numbers and are wrapped into 0-359; strength is clamped to 0-1; every name
 * must be one of its fixed set (an absent one takes the middle value). Unknown
 * fields are ignored.
 */
export function parseScene(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.hues) || r.hues.length < 2 || r.hues.length > 3) return null
  if (!r.hues.every(h => typeof h === 'number' && Number.isFinite(h))) return null
  const hues = (r.hues as number[]).map(h => ((Math.round(h) % 360) + 360) % 360)
  if (r.strength !== undefined && (typeof r.strength !== 'number' || !Number.isFinite(r.strength))) return null
  const saturation = oneOf(r.saturation, SATURATIONS, 'medium')
  const lightness = oneOf(r.lightness, LIGHTNESSES, 'medium')
  const motion = oneOf(r.motion, MOTIONS, 'medium')
  const pattern = oneOf(r.pattern, PATTERNS, 'glows')
  const arc = oneOf(r.arc, SCENE_ARCS, 'stay')
  if (!saturation || !lightness || !motion || !pattern || !arc) return null
  const strength = typeof r.strength === 'number' ? clamp01(r.strength) : 0.6
  const source = r.source === 'dj' || r.source === 'neutral' || isMoodKey(r.source) ? r.source : 'dj'
  return { hues, saturation, lightness, strength, motion, pattern, arc, source }
}

/** Whether two scenes paint the same. */
export function sameScene(a: Scene, b: Scene): boolean {
  return JSON.stringify({ ...a, source: '' }) === JSON.stringify({ ...b, source: '' })
}

/** Words that place free text, or the agent's mood tags, on one of the chips. */
const WORDS: Record<MoodKey, readonly string[]> = {
  calm: ['平静', '安静', '放松', 'calm', 'peaceful', 'relaxed', 'chill'],
  sad: ['难过', '伤心', '悲伤', '失落', 'sad', 'down', 'heartbroken', 'blue'],
  happy: ['开心', '快乐', '高兴', '愉快', 'happy', 'joy', 'cheerful'],
  missing: ['想念', '思念', '怀念', 'miss', 'missing', 'nostalgic', 'longing'],
  fired: ['燃', '热血', '激动', '兴奋', 'hype', 'pumped', 'energetic'],
}

/** The chip a mood text or tag list reads as, or neutral when none fits. */
export function moodLookFor(texts: readonly string[]): MoodLook {
  const hay = texts.join(' ').toLowerCase()
  if (!hay.trim()) return 'neutral'
  for (const key of MOOD_KEYS) {
    if (WORDS[key].some(w => hay.includes(w))) return key
  }
  return 'neutral'
}
