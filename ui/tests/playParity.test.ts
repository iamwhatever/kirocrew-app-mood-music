// The page's play request and reply id, pinned to the golden file the backend's
// Python port is also checked against (`backend/play_request.py`,
// `tests/test_playback.py`): the buddy reads the same words whichever side woke it.
import { describe, expect, it } from 'vitest'
import golden from '../../tests/fixtures/play_request_golden.json'
import type { MoodState } from '../src/api'
import { replySource } from '../src/replyParse'
import { buildPlayRequest, memorySummary, type ExploreLevel, type PlaySong } from '../src/request.prompt'

describe('play request parity with the backend', () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const i = c.input
      const out = buildPlayRequest({
        song: i.song as PlaySong,
        steps: i.steps,
        why: i.why as 'start' | 'ended',
        refill: i.refill ? { moodTags: i.refill.mood_tags, queued: i.refill.queued } : null,
        state: { memory: i.memory } as unknown as MoodState,
        explore: i.explore as ExploreLevel,
        stayOnly: i.stay_only,
      })
      expect(out).toBe(c.expected)
      // The memory a refill carried, which the backend marks used once its picks land.
      expect(memorySummary(i.memory as never).ids).toEqual(c.summary_ids)
    })
  }

  it('gives a reply the same id as the backend does', () => {
    for (const s of golden.sources) expect(replySource(s.content)).toBe(s.expected)
  })
})
