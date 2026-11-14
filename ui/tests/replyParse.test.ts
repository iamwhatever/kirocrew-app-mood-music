import { describe, expect, it } from 'vitest'
import { parseDjReply, replySource } from '../src/replyParse'
import realReply from './fixtures/reply-platform-moods.json'

const ID = 'dQw4w9WgXcQ'
const block = (data: unknown) => 'Here you go.\n```mood-music\n' + JSON.stringify(data) + '\n```\n'

describe('parseDjReply', () => {
  it('reads picks, keeps a YouTube id only, and drops bad links', () => {
    const r = parseDjReply(block({
      mood_tags: ['想念'],
      picks: [
        { title: 'A', artist: 'x', source: 'youtube', url: `https://www.youtube.com/watch?v=${ID}`, why: 'soft' },
        { title: 'B', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
        { title: 'C', source: 'youtube', url: `https://www.youtube.com/watch?v=${ID}Q` },
        { title: 'D', source: 'bilibili', url: 'https://bilibili.com.evil.com/x' },
        { title: 'E', source: 'bilibili', url: 'http://www.bilibili.com/video/BV1' },
        { title: '', source: 'youtube', video_id: ID },
      ],
    }))
    expect(r?.moodTags).toEqual(['想念'])
    expect(r?.picks).toEqual([
      { title: 'A', artist: 'x', why: 'soft', tags: [], source: 'youtube', video_id: ID },
      { title: 'B', artist: '', why: '', tags: [], source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    ])
    expect(r?.dropped).toBe(4)
  })

  it('reads a real reply that said platform and moods', () => {
    const r = parseDjReply(realReply.content)
    expect(r?.moodTags).toEqual(['怀念恋人', '温暖', '淡淡遗憾', '温柔回忆'])
    expect(r?.picks.map(p => [p.title, p.source, p.video_id])).toEqual([
      ['好久不见', 'youtube', 'UsFQ9kbpQhw'],
      ['红豆', 'youtube', '5wmfXve11rM'],
      ['后来', 'youtube', 't0igPuDjYUE'],
      ['小幸运', 'youtube', 'Kg-mW8SyNVg'],
    ])
    expect(r?.dropped).toBe(0)
  })

  it('checks a platform pick like a source pick', () => {
    const r = parseDjReply(block({
      picks: [
        { title: 'A', platform: 'youtube', url: `https://www.youtube.com/watch?v=${ID}Q` },
        { title: 'B', platform: 'bilibili', url: 'https://bilibili.com.evil.com/x' },
        { title: 'C', platform: 'spotify', url: 'https://open.spotify.com/track/x' },
      ],
    }))
    expect(r?.picks).toEqual([])
    expect(r?.dropped).toBe(3)
  })

  it('reads a question with no picks', () => {
    expect(parseDjReply(block({ question: 'Quiet or loud?' }))).toEqual({
      text: 'Here you go.', question: 'Quiet or loud?', moodTags: [], picks: [], dropped: 0, followUps: [], remember: '',
    })
  })

  it('keeps tier, arc, listen_for and https evidence, and orders picks stay -> turn -> lift', () => {
    const yt = (title: string, extra: object) => ({ title, source: 'youtube', url: `https://www.youtube.com/watch?v=${ID}`, ...extra })
    const r = parseDjReply(block({
      picks: [
        yt('Up', { arc: 'lift', tier: 'explore' }),
        yt('Here', { arc: 'stay', tier: 'anchor', listen_for: 'the breath in verse two' }),
        yt('Open', { arc: 'turn', tier: 'deep', evidence: { url: 'https://example.com/review?id=1', label: 'A review' } }),
        yt('Odd', { arc: 'sideways', tier: 'famous', evidence: { url: 'javascript:alert(1)', label: 'x' } }),
      ],
      follow_ups: ['quieter', 'in Cantonese', 'stay here', 'a fourth is cut'],
      remember: 'likes Cantonese',
    }))
    expect(r?.picks.map(p => p.title)).toEqual(['Here', 'Open', 'Up', 'Odd'])
    const [here, open, , odd] = r!.picks
    expect(odd).not.toHaveProperty('arc')
    expect(odd).not.toHaveProperty('tier')
    expect(odd).not.toHaveProperty('evidence')
    expect(here).toMatchObject({ tier: 'anchor', arc: 'stay', listen_for: 'the breath in verse two' })
    expect(open.evidence).toEqual({ url: 'https://example.com/review?id=1', label: 'A review' })
    expect(r?.followUps).toEqual(['quieter', 'in Cantonese', 'stay here'])
    expect(r?.remember).toBe('likes Cantonese')
    expect(r?.text).toBe('Here you go.')
  })

  it('uses the last block and returns null when none parses', () => {
    const two = block({ question: 'old' }) + block({ question: 'new' })
    expect(parseDjReply(two)?.question).toBe('new')
    expect(parseDjReply('no block here')).toBeNull()
    expect(parseDjReply('```mood-music\n{bad json\n```')).toBeNull()
    expect(parseDjReply(block([1, 2]))).toBeNull()
  })

  it('names a reply by its content', () => {
    expect(replySource('a')).toBe(replySource('a'))
    expect(replySource('a')).not.toBe(replySource('b'))
  })
})
