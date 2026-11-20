import { useEffect, useState } from 'react'
import { useNavigation, type ParamListBase } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

// Past any push the platforms draw, so a transitionEnd that never comes costs a moment and not the list.
export const TRANSITION_BOUND_MS = 700

// Whether the push that opened this screen has finished. The drawer stays open beneath a pushed
// screen, and a list of SVG rows mounting during the push holds the JS thread while the frame still
// shows the menu's edge, so a screen with such a list mounts it after this says true.
export function useTransitionDone(): boolean {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>()
  const [done, setDone] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDone(true), TRANSITION_BOUND_MS)
    const off = navigation.addListener('transitionEnd', event => {
      if (!event.data.closing) {
        clearTimeout(timer)
        setDone(true)
      }
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [navigation])

  return done
}
