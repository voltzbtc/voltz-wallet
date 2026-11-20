import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { loadDismissedUpdate, saveDismissedUpdate } from '../wallet/settings'
import { readUpdateNotice, type UpdateNotice } from '../wallet/updateNotice'

const READ_AGAIN_AFTER_MS = 6 * 60 * 60 * 1000

// Memory of this process alone, so a Home mounted again keeps the answer without a second read, and
// a restart starts from nothing.
let lastReadAt: number | null = null
let heard: UpdateNotice | null = null
// Apart from the saved dismissal, so a save that failed still hides the banner for this session.
let dismissedNow: string | null = null
let dismissedSaved: string | null = null
// One touch for the whole process, since a read can begin in one mounted Home and land in another.
let touched = false
// Every Home mounted, since a read outlives the one that began it and its answer belongs to whichever
// is there when it lands.
const landings = new Set<() => void>()

function visible(): UpdateNotice | null {
  if (heard?.level === 'normal' && (heard.latest === dismissedNow || heard.latest === dismissedSaved)) {
    return null
  }
  return heard
}

function due(): boolean {
  return lastReadAt === null || Date.now() - lastReadAt >= READ_AGAIN_AFTER_MS
}

async function read(): Promise<void> {
  lastReadAt = Date.now()
  touched = false
  const answer = await readUpdateNotice()
  if (answer?.level === 'normal') {
    dismissedSaved = await loadDismissedUpdate()
  }
  heard = answer
  landings.forEach(land => land())
}

type UpdateNoticeState = {
  notice: UpdateNotice | null
  dismiss: () => void
  // A touch on the screen that shows the banner, so an answer landing after it waits for the next
  // focus instead of moving what the finger is on.
  noteTouch: () => void
}

// The only writer of the banner's state. Home draws without it and never waits for it.
export function useUpdateNotice(): UpdateNoticeState {
  const [notice, setNotice] = useState<UpdateNotice | null>(visible)
  const focused = useRef(false)

  useEffect(() => {
    const land = () => {
      if (!(focused.current && touched)) {
        setNotice(visible())
      }
    }
    landings.add(land)
    let timer: ReturnType<typeof setTimeout> | undefined
    // Past the first frame: the frame callback runs before it paints, and the timer after it. The
    // signature check is pure JS, and its cost on Hermes must not land on the screen's first draw.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (due()) {
          read()
        }
      }, 0)
    })
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && due()) {
        read()
      }
    })
    return () => {
      landings.delete(land)
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      sub.remove()
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      focused.current = true
      touched = false
      setNotice(visible())
      return () => {
        focused.current = false
      }
    }, []),
  )

  // Goes by the banner on screen, since a read held back by a touch can leave `heard` on another answer.
  const dismiss = useCallback(() => {
    if (notice?.level !== 'normal') {
      return
    }
    dismissedNow = notice.latest
    setNotice(visible())
    saveDismissedUpdate(notice.latest).catch(() => undefined)
  }, [notice])

  const noteTouch = useCallback(() => {
    touched = true
  }, [])

  return { notice, dismiss, noteTouch }
}
