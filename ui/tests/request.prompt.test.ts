import { describe, expect, it } from 'vitest'
import { buildRequest, REPLY_FORMAT } from '../src/request.prompt'
import { parseDjReply } from '../src/replyParse'

describe('buildRequest', () => {
  it('carries the exact reply format, whose example the page can read', () => {
    const msg = buildRequest({ kind: 'mood', text: 'calm', state: undefined })
    expect(msg.endsWith(REPLY_FORMAT)).toBe(true)
    for (const field of ['"mood_tags"', '"picks"', '"source"', '"url"', '"question"']) expect(REPLY_FORMAT).toContain(field)
    const example = parseDjReply(REPLY_FORMAT)
    expect(example?.moodTags).toEqual(['想念', '温柔'])
    expect(example?.picks).toHaveLength(1)
    expect(example?.dropped).toBe(0)
    expect(example?.picks[0]).toMatchObject({ tier: 'explore', arc: 'stay', evidence: { url: 'https://example.com/review' } })
    expect(example?.followUps).toHaveLength(2)
  })

  it('names the explore mix and the arc', () => {
    expect(buildRequest({ kind: 'mood', text: 'x', state: undefined })).toContain('Explore level: balanced (1 anchor, 4 explore, 0 deep)')
    const more = buildRequest({ kind: 'mood', text: 'x', state: undefined, explore: 'explore', stayOnly: true })
    expect(more).toContain('Explore level: explore (0 anchor, 4 explore, 1 deep)')
    expect(more).toContain('Arc: stay only')
  })
})
