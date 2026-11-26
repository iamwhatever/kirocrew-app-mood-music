/**
 * Browser recipes (App Kit level 15, KiroCrew#41783): fixed clicks Kiro Crew runs
 * on the buddy's tab with no agent turn. The manifest declares them
 * (`permissions.browserRecipes`): `youtube_play` and `bilibili_play` press the
 * player's play button, and `youtube_skip_ad` is a `watch` recipe Kiro Crew runs by
 * itself while a song plays, when the "Skip ad" button shows. The page never runs
 * the skip-ad one; it only says where to turn it on.
 *
 * Every recipe is optional. It runs only while the `app_browser_sdk` Feature Preview
 * is on and after the owner approved it on the app's page, and a click is a script
 * click a site may ignore. So the page always checks the effect, and on any refusal
 * falls back to what 0.2.20 did: the media route's own play, then the buddy.
 */
import * as sdk from '@kirocrew/app-sdk'
import type { BrowserMedia, BrowserMediaState } from '@kirocrew/app-sdk'
import type { PickSource } from './replyParse'

/** The level that brought `permissions.browserRecipes` and `runRecipe`. */
export const RECIPE_SDK_LEVEL = 15
/** The play recipe of each site that has one, by the pick's `source`. */
export const PLAY_RECIPE: Partial<Record<PickSource, string>> = {
  youtube: 'youtube_play',
  bilibili: 'bilibili_play',
}
/** The watch recipe that presses YouTube's "Skip ad" while a song plays. */
export const SKIP_AD_RECIPE = 'youtube_skip_ad'
/** How long after a recipe's click the page reads whether the song plays. */
export const SETTLE_MS = 600

/**
 * What the page knows about recipes on this host: not yet asked, they work, the
 * preview is off, the owner has not approved them, the host has none, or the last
 * one ran but did not start the song.
 */
export type RecipeGate = 'unknown' | 'ok' | 'preview_off' | 'not_approved' | 'old_host' | 'failed'

/** The outcome of one try: played, or the code of why not. */
export interface RecipeTry {
  ok: boolean
  code?: string
}

type RunRecipe = NonNullable<BrowserMedia['runRecipe']>

/** The host's `runRecipe` when it has one; feature-checked, never the level alone. */
export function hostRunRecipe(media: BrowserMedia): RunRecipe | undefined {
  const level = typeof sdk.APP_SDK_LEVEL === 'number' ? sdk.APP_SDK_LEVEL : 0
  const run = media.runRecipe
  return level >= RECIPE_SDK_LEVEL && typeof run === 'function' ? run : undefined
}

/**
 * The gate a recipe answer shows. The two 403s say where to turn recipes on; a
 * missing route or permission is an old host (one before level 15 answers
 * `bad_action`); a refusal from before the recipe checks (`unknown_session`, a
 * browser turned off by policy, a failed request) says nothing; any other answer
 * came after the gateway allowed the recipe, so recipes are on, and a run that
 * did not work is `failed`.
 */
export function gateOf(answer: RecipeTry): RecipeGate {
  if (answer.ok) return 'ok'
  switch (answer.code) {
    case 'preview_off':
      return 'preview_off'
    case 'recipe_not_approved':
      return 'not_approved'
    case 'not_declared':
    case 'old_host':
    case 'bad_action':
      return 'old_host'
    case 'unknown_session':
    case 'policy_denied':
    case 'browser_error':
    case 'invalid_json':
      return 'unknown'
    default:
      return 'failed'
  }
}

/**
 * Ask the gateway whether recipes are on, while the tab has no song to touch: the
 * preview and approval checks answer before any step runs, and with no tab or no
 * player in it nothing is clicked (`no_tab`). The page calls it only when the media
 * route said `no_tab`, so it cannot pause a song or a page that is still loading.
 */
export async function probeRecipes(media: BrowserMedia): Promise<RecipeGate> {
  const run = hostRunRecipe(media)
  if (!run) return 'old_host'
  const answer = await run(PLAY_RECIPE.youtube as string).catch(() => ({ ok: false, code: 'browser_error' }))
  // A run that answered for a page with no song still says recipes are on.
  const gate = gateOf(answer)
  return gate === 'failed' ? 'ok' : gate
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Press play on the tab with the site's play recipe, and check the song really
 * plays. Only for a song that is paused and not over: the play button toggles.
 * `{ ok: false, code }` when there is no recipe for *source*, the host has none,
 * the gateway refused it, or the click had no effect (`no_effect`).
 */
export async function playByRecipe(
  media: BrowserMedia,
  source: PickSource | undefined,
  read: () => Promise<BrowserMediaState | null>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<RecipeTry> {
  const run = hostRunRecipe(media)
  if (!run) return { ok: false, code: 'old_host' }
  const name = source ? PLAY_RECIPE[source] : undefined
  if (!name) return { ok: false, code: 'no_recipe' }
  const answer = await run(name).catch(() => ({ ok: false, code: 'browser_error' }))
  if (!answer.ok) return answer
  // `ok` says the click ran, not that the site acted on it (a script click).
  await wait(SETTLE_MS)
  const now = await read().catch(() => null)
  return now && !now.paused && !now.ended ? { ok: true } : { ok: false, code: 'no_effect' }
}

/** Whether a gate means the page should say where to turn recipes on. */
export function hintFor(gate: RecipeGate): 'preview_off' | 'not_approved' | null {
  return gate === 'preview_off' || gate === 'not_approved' ? gate : null
}
