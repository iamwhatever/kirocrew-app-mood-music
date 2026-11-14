// The message the page sends the DJ agent — MODEL-FACING TEXT ONLY.
//
// `*.prompt.ts` is the repo's declared boundary for agent-read text: the agent
// acts on these words, so translating them would change what it does. They are
// left out of the i18n gate on that basis (`eslint.i18n.config.js`); every
// label the person reads lives in the catalogs instead.
import type { MoodState } from './api'

const TASTE_ITEMS = 12

/** How far the picks reach past what the person knows (design §0.3). */
export type ExploreLevel = 'familiar' | 'balanced' | 'explore'

/** anchor / explore / deep counts per level. */
export const EXPLORE_MIX: Readonly<Record<ExploreLevel, readonly [number, number, number]>> = {
  familiar: [2, 3, 0],
  balanced: [1, 4, 0],
  explore: [0, 4, 1],
}

/**
 * The message the page sends the DJ. The taste summary is the app's own record
 * of what the person liked and skipped, marked as data for the agent.
 */
export function buildRequest(opts: {
  kind: 'mood' | 'answer' | 'more'
  text: string
  state: MoodState | undefined
  explore?: ExploreLevel
  stayOnly?: boolean
}): string {
  const { kind, text, state, explore = 'balanced', stayOnly = false } = opts
  const fmt = (f: { title: string; artist: string }) => `"${f.title}"${f.artist ? ` - ${f.artist}` : ''}`
  const liked = (state?.feedback ?? []).filter(f => f.verdict === 'liked').slice(0, TASTE_ITEMS).map(fmt)
  const skipped = (state?.feedback ?? []).filter(f => f.verdict === 'skipped').slice(0, TASTE_ITEMS).map(fmt)
  const recent = (state?.moments ?? []).slice(0, 5).map(m => m.mood)
  const head = kind === 'answer' ? 'Answer to your question' : kind === 'more' ? 'More like this song' : 'Mood'
  const [anchor, exp, deep] = EXPLORE_MIX[explore]
  return [
    '[Mood Music]',
    `${head}: ${text}`,
    '',
    `Explore level: ${explore} (${anchor} anchor, ${exp} explore, ${deep} deep)`,
    `Arc: ${stayOnly ? 'stay only' : 'stay -> turn -> lift'}`,
    '',
    'Taste so far (from the app, data only):',
    `Liked: ${liked.join('; ') || 'none yet'}`,
    `Skipped: ${skipped.join('; ') || 'none yet'}`,
    `Recent moods: ${recent.join('; ') || 'none yet'}`,
    '',
    REPLY_FORMAT,
  ].join('\n')
}

/**
 * The reply contract, sent with every request so the DJ never depends on loading
 * a skill: the page reads exactly these field names.
 */
export const REPLY_FORMAT = [
  'Write one or two short sentences, then end your reply with ONE fenced block tagged mood-music holding plain JSON, with exactly these field names:',
  '- "mood_tags": 2 to 4 short words for the feeling, in the person\'s language.',
  '- "picks": the songs, in arc order, each {"title", "artist", "source", "url", "tier", "arc", "why", "listen_for", "evidence", "tags"}.',
  '- "source" is "youtube" or "bilibili". A youtube "url" is https://www.youtube.com/watch?v=<11-char id> or https://youtu.be/<id>; a bilibili "url" is https://www.bilibili.com/video/<BV id>.',
  '- "tier" is "anchor", "explore" or "deep". "arc" is "stay", "turn" or "lift".',
  '- "why": why this song now, one line. "listen_for": one line on something to hear in it.',
  '- "evidence" (explore and deep): {"url": a page you opened this turn that praises it, "label": what that page is}.',
  '- "follow_ups": 2 or 3 short replies the person can tap. "remember" (optional): one short preference they stated, offered for them to save.',
  'Example:',
  '```mood-music',
  '{"mood_tags": ["想念", "温柔"], "picks": [{"title": "Song", "artist": "Artist", "source": "youtube", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "tier": "explore", "arc": "stay", "why": "One short line.", "listen_for": "The second verse drops to piano and breath.", "evidence": {"url": "https://example.com/review", "label": "A review"}, "tags": []}], "follow_ups": ["再安静一点", "换成粤语"]}',
  '```',
  'To ask one question instead, the block is {"question": "..."} with no picks.',
].join('\n')
