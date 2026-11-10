import { useEffect, useState } from 'react'
import type { MediaMode } from '@shared/types'

// Kept across screens so the storyboard does not flash the wrong buttons while the setting loads.
let cached: MediaMode = 'higgsfield'

export function rememberMediaMode(mode: MediaMode): void {
  cached = mode
}

/** Whether pictures and videos come from Higgsfield or are made by hand in other apps. */
export function useMediaMode(): MediaMode {
  const [mode, setMode] = useState<MediaMode>(cached)
  useEffect(() => {
    let live = true
    void window.api.settings.get().then((s) => {
      cached = s.mediaMode
      if (live) setMode(s.mediaMode)
    })
    return () => {
      live = false
    }
  }, [])
  return mode
}
