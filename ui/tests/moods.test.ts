import { describe, expect, it } from 'vitest'
import { MIX_RANGE, MOOD_KEYS, mixPercent, moodLookFor, parseScene, presetScene } from '../src/moods'
import { arcStep, mixHue, paintedHues } from '../src/MoodBackdrop'

const GOOD = { hues: [220, 260, 300], saturation: 'medium', lightness: 'deep', strength: 0.6, motion: 'slow', pattern: 'aurora', arc: 'stay' }

describe('chip presets', () => {
  it('gives every chip its own scene, clearly apart from the resting one', () => {
    const all = [...MOOD_KEYS, 'neutral'].map(k => presetScene(k))
    expect(new Set(all.map(s => s.hues.join(','))).size).toBe(all.length)
    const neutral = presetScene('neutral')
    for (const k of MOOD_KEYS) {
      const s = presetScene(k)
      expect(s.source).toBe(k)
      // Stronger than rest, so a chip visibly changes the page.
      expect(s.strength).toBeGreaterThan(neutral.strength + 0.2)
    }
    expect(presetScene('angry-ish')).toEqual(neutral)
    expect(presetScene(undefined)).toEqual(neutral)
  })

  it('moves a calm scene slower than a fired-up one', () => {
    expect(presetScene('calm').motion).toBe('slow')
    expect(presetScene('fired').motion).toBe('lively')
  })

  it('places free text and agent tags on a chip, or neutral', () => {
    expect(moodLookFor(['今天好想念外婆'])).toBe('missing')
    expect(moodLookFor(['Feeling PUMPED'])).toBe('fired')
    expect(moodLookFor(['温柔', '平静'])).toBe('calm')
    expect(moodLookFor([''])).toBe('neutral')
    expect(moodLookFor(['something else'])).toBe('neutral')
  })
})

describe('parseScene', () => {
  it('reads a scene inside the bounds', () => {
    expect(parseScene(GOOD)).toEqual({ ...GOOD, source: 'dj' })
  })

  it('wraps hues, rounds them, clamps strength, and fills an absent name with the middle value', () => {
    expect(parseScene({ hues: [-30, 725.4], strength: 7 })).toEqual({
      hues: [330, 5], saturation: 'medium', lightness: 'medium', strength: 1, motion: 'medium', pattern: 'glows', arc: 'stay', source: 'dj',
    })
    expect(parseScene({ hues: [1, 2], strength: -3 })?.strength).toBe(0)
  })

  it('drops the whole scene when anything is out of bounds', () => {
    for (const bad of [
      null, 'aurora', [], {}, { hues: [10] }, { hues: [1, 2, 3, 4] }, { hues: ['10', 20] }, { hues: [10, NaN] },
      { hues: [10, Infinity] }, { ...GOOD, pattern: 'url(https://evil.example/x.png)' }, { ...GOOD, pattern: 'fireworks' },
      { ...GOOD, motion: 'fast' }, { ...GOOD, saturation: 'neon' }, { ...GOOD, lightness: 1 }, { ...GOOD, strength: '0.5' },
      { ...GOOD, arc: 'party' },
    ]) expect(parseScene(bad), JSON.stringify(bad)).toBeNull()
  })

  it('ignores unknown fields, so no CSS or HTML the model adds reaches the page', () => {
    const scene = parseScene({ ...GOOD, css: 'body{display:none}', html: '<img src=x onerror=alert(1)>', url: 'https://evil.example' })
    expect(scene).toEqual({ ...GOOD, source: 'dj' })
  })
})

describe('painting', () => {
  it('maps strength onto a visible mix range', () => {
    expect(mixPercent(0)).toBe(MIX_RANGE[0])
    expect(mixPercent(1)).toBe(MIX_RANGE[1])
    expect(mixPercent(5)).toBe(MIX_RANGE[1])
  })

  it('drifts toward the lift hue along the arc, the short way round', () => {
    const scene = parseScene(GOOD)!
    expect(arcStep(scene)).toBe(0)
    expect(arcStep(scene, 'turn')).toBe(0.5)
    expect(arcStep({ ...scene, arc: 'lift' }, 'stay')).toBe(1)
    expect(paintedHues(scene, 0)).toEqual([220, 260, 300])
    expect(paintedHues(scene, 1)).toEqual([260, 280, 300])
    expect(mixHue(350, 10, 0.5)).toBe(0)
    expect(paintedHues(parseScene({ hues: [10, 50] })!, 0)).toEqual([10, 50, 10])
  })
})
