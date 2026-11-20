import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type GestureResponderEvent } from 'react-native'
import { useTranslation } from 'react-i18next'
import { motion } from '../theme'
import { useAnnounce } from './useAnnounced'

type TouchHandlers = {
  onTouchStart: () => void
  onTouchEnd: (event: GestureResponderEvent) => void
  onTouchCancel: (event: GestureResponderEvent) => void
}

export type ScrollGesture = {
  onScrollBeginDrag: () => void
  onScrollEndDrag: () => void
  onMomentumScrollBegin: () => void
  onMomentumScrollEnd: () => void
}

type PullFeedback = {
  // Each new number re-enters the page through Reenter. See `answered`.
  beat: number
  // Go on the view around the page, so the beat knows when a finger is on it.
  touch: TouchHandlers
  // Go on the page's scroll view, which sends these to no parent, so the beat knows when it is moving.
  scroll: ScrollGesture
  // True from `reading` until the read's figures have landed: what a figure may fade on.
  fading: boolean
  // A read is about to go out, whether a pull asked for it or nobody did.
  reading: () => void
  // What a read came to. Only with `updated` the page re-enters: on a failed read the 'not updated'
  // mark is the answer.
  answered: (updated: boolean) => void
  // `answered` for a pull, which also tells a screen reader, since a page moving reaches only the eye.
  // `updated` means a Synced was heard and the read after it landed.
  pulled: (updated: boolean) => void
  // For a wallet switch, since what is under way belongs to the previous wallet.
  drop: () => void
}

// How a page answers a refresh once the spinner stops, which on Android floats over a screen that may
// not change at all. A beat with a finger on the page or the page still scrolling is dropped rather
// than held, since the page would move under it, and the figures it carries have landed anyway.
//
// A touch alone cannot say so: when a native scroll takes over, Android ends the touch with a cancel
// that lists no touches, under a finger that is still scrolling.
export function usePullFeedback(): PullFeedback {
  const { t } = useTranslation()
  const [beat, setBeat] = useState(0)
  const [fading, setFading] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fingerDown = useRef(false)
  const dragging = useRef(false)
  const gliding = useRef(false)

  const touch = useMemo<TouchHandlers>(() => {
    const lifted = (event: GestureResponderEvent) => {
      fingerDown.current = event.nativeEvent.touches.length > 0
    }
    return {
      // A new touch starts over: one that stops a glide leaves Android with no momentum end to send.
      onTouchStart: () => {
        fingerDown.current = true
        dragging.current = false
        gliding.current = false
      },
      onTouchEnd: lifted,
      onTouchCancel: lifted,
    }
  }, [])

  const scroll = useMemo<ScrollGesture>(
    () => ({
      onScrollBeginDrag: () => {
        dragging.current = true
        gliding.current = false
      },
      onScrollEndDrag: () => {
        dragging.current = false
      },
      onMomentumScrollBegin: () => {
        gliding.current = true
      },
      onMomentumScrollEnd: () => {
        gliding.current = false
      },
    }),
    [],
  )

  const clearFadeTimer = useCallback(() => {
    if (fadeTimer.current !== null) {
      clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
  }, [])

  const reading = useCallback(() => {
    clearFadeTimer()
    setFading(true)
  }, [clearFadeTimer])

  const answered = useCallback(
    (updated: boolean) => {
      // Past the render that carries the read's figures, which comes after this call.
      clearFadeTimer()
      fadeTimer.current = setTimeout(() => {
        fadeTimer.current = null
        setFading(false)
      }, motion.base)
      if (updated && !fingerDown.current && !dragging.current && !gliding.current) {
        setBeat(n => n + 1)
      }
    },
    [clearFadeTimer],
  )

  // Past the finger gate, which is about the page moving and not about what the pull came to. A pull
  // can answer after the app left and the lock came back, where nothing is said.
  const announce = useAnnounce()
  const pulled = useCallback(
    (updated: boolean) => {
      answered(updated)
      if (updated) {
        announce(t('home.updatedNow'))
      }
    },
    [answered, announce, t],
  )

  const drop = useCallback(() => {
    clearFadeTimer()
    setFading(false)
  }, [clearFadeTimer])

  useEffect(() => clearFadeTimer, [clearFadeTimer])

  return { beat, touch, scroll, fading, reading, answered, pulled, drop }
}
