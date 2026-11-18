import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetStubMedia, resetStubSdk } from './stubs/app-sdk'

afterEach(() => {
  cleanup()
  resetStubSdk()
  resetStubMedia()
  // The page keeps where the person was in sessionStorage; each test starts fresh.
  window.sessionStorage.clear()
})
