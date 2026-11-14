// The message the page sends the DJ agent — MODEL-FACING TEXT ONLY.
//
// `*.prompt.ts` is the repo's declared boundary for agent-read text: the agent
// acts on these words, so translating them would change what it does. They are
// left out of the i18n gate on that basis (`eslint.i18n.config.js`); every
// label the person reads lives in the catalogs instead.
import type { MoodState } from './api'

const TASTE_ITEMS = 12

/**
 * The message the page sends the DJ. The taste summary is the app's own record
 * of what the person liked and skipped, marked as data for the agent.
 */
export function buildRequest(opts: { kind: 'mood' | 'answer' | 'more'; text: string; state: MoodState | undefined }): string {
  const { kind, text, state } = opts
  const fmt = (f: { title: string; artist: string }) => `"${f.title}"${f.artist ? ` - ${f.artist}` : ''}`
  const liked = (state?.feedback ?? []).filter(f => f.verdict === 'liked').slice(0, TASTE_ITEMS).map(fmt)
  const skipped = (state?.feedback ?? []).filter(f => f.verdict === 'skipped').slice(0, TASTE_ITEMS).map(fmt)
  const recent = (state?.moments ?? []).slice(0, 5).map(m => m.mood)
  const head = kind === 'answer' ? 'Answer to your question' : kind === 'more' ? 'More like this song' : 'Mood'
  return [
    '[Mood Music]',
    `${head}: ${text}`,
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
  'End your reply with ONE fenced block tagged mood-music holding plain JSON, with exactly these field names:',
  '- "mood_tags": 2 to 4 short words for the feeling, in the person\'s language.',
  '- "picks": 3 to 6 songs, each {"title", "artist", "source", "url", "why", "tags"}.',
  '- "source" is "youtube" or "bilibili". A youtube "url" is https://www.youtube.com/watch?v=<11-char id> or https://youtu.be/<id>; a bilibili "url" is https on www.bilibili.com, m.bilibili.com or b23.tv.',
  'Example:',
  '```mood-music',
  '{"mood_tags": ["想念", "温柔"], "picks": [{"title": "Song", "artist": "Artist", "source": "youtube", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "why": "One short line.", "tags": []}]}',
  '```',
  'To ask one question instead, the block is {"question": "..."} with no picks.',
].join('\n')
