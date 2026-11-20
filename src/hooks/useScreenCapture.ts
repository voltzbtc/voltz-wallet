import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, AppState } from 'react-native'
import { useTranslation } from 'react-i18next'
import { captureWatched, onCapturedChange, onScreenshot, readCaptured } from '../wallet/screenCapture'
import { useUnderLock } from '../components/UnderLock'

// `checking` draws no word, since a screen opened with a recording already running would otherwise
// put them in it before the first read answers.
export type CapturePhase = 'checking' | 'shown' | 'captured'

export type ScreenCapture = {
  phase: CapturePhase
  // A screenshot taken with words on screen, for as long as this screen stays open.
  screenshot: boolean
}

// What a phrase screen may draw. `wordsOnScreen` says whether the screen holds words at all, so a
// screenshot of a PIN pad or of a hidden grid asks nobody to delete anything.
export function useScreenCapture(wordsOnScreen: boolean): ScreenCapture {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<CapturePhase>(() => (captureWatched() ? 'checking' : 'shown'))
  const [screenshot, setScreenshot] = useState(false)
  // A screenshot under the lock caught the lock, not the words.
  const underLock = useUnderLock()
  const latest = useRef({ phase, wordsOnScreen, underLock, line: '' })
  latest.current = { phase, wordsOnScreen, underLock, line: t('backup.screenshotTaken') }

  useEffect(() => {
    if (!captureWatched()) {
      return
    }
    let alive = true
    // A change heard after a read was asked for is newer than that read's answer.
    let turn = 0
    const read = () => {
      const asked = ++turn
      // A failed read counts as captured: the words stay off, and the next return to the app reads again.
      readCaptured().then(
        captured => alive && asked === turn && setPhase(captured ? 'captured' : 'shown'),
        () => alive && asked === turn && setPhase('captured'),
      )
    }
    const offChange = onCapturedChange(captured => {
      turn += 1
      setPhase(captured ? 'captured' : 'shown')
    })
    const offScreenshot = onScreenshot(() => {
      const { phase: now, wordsOnScreen: holdsWords, underLock: locked, line } = latest.current
      if (now === 'shown' && holdsWords && !locked) {
        setScreenshot(true)
        AccessibilityInfo.announceForAccessibility(line)
      }
    })
    // A recording can start with the app away, where a notification may not reach it.
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        read()
      }
    })
    read()
    return () => {
      alive = false
      offChange()
      offScreenshot()
      appState.remove()
    }
  }, [])

  return { phase, screenshot }
}
