/**
 * The bundle's entry: AppHost lazy-imports this module and renders its default
 * export as the app's page. Subscribing to the host's language generation
 * repaints the page on a language switch.
 */
import { useLanguageGeneration } from '@kirocrew/app-sdk'
import MoodMusicPage from './MoodMusicPage'

export default function MoodMusicApp() {
  useLanguageGeneration()
  return <MoodMusicPage />
}
