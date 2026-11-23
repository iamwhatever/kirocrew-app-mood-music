/**
 * The sites the buddy may browse, from the host's `useBrowserSites` (App Kit
 * level 13, KiroCrew#40727): the app's declared sites plus the ones the owner
 * added, minus the ones the owner turned off or removed.
 *
 * The page reads the list and shows it in the Sites tab, where the owner edits
 * it through the host's own calls: adding a site goes through the dialog the
 * dashboard draws (`requestAdd`), never a direct post; turning off and removing
 * apply at once. The buddy only reads the list, in the play request
 * (`request.prompt.ts`); it has no tool that edits it, and Kiro Crew refuses an
 * edit from an agent's tools or the app's token.
 *
 * The hook is read off a namespace import: an older host has no such export, and
 * a named import of a missing export would fail the whole bundle.
 */
import * as sdk from '@kirocrew/app-sdk'
import type { BrowserSites } from '@kirocrew/app-sdk'

/** The level that brought `useBrowserSites` and `/api/apps/<name>/browser-sites`. */
export const SITES_SDK_LEVEL = 13

/** The host's hook when it has one; feature-checked, never the level alone. */
export function hostSitesHook(): typeof sdk.useBrowserSites {
  const level = typeof sdk.APP_SDK_LEVEL === 'number' ? sdk.APP_SDK_LEVEL : 0
  return level >= SITES_SDK_LEVEL && typeof sdk.useBrowserSites === 'function' ? sdk.useBrowserSites : undefined
}

const noSites = (): null => null

/** The site list, or null on a host too old to have it. */
export function useSites(): BrowserSites | null {
  const hook = hostSitesHook() ?? noSites
  return hook()
}

/** The sites in force for the buddy's request, or undefined when the list is not known. */
export function promptSites(sites: BrowserSites | null): readonly string[] | undefined {
  return sites?.sites ? sites.active : undefined
}
