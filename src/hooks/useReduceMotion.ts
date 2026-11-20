import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

// Whether the person has asked their phone to reduce motion. It is a real accessibility setting on
// both platforms and a WCAG requirement, and for somebody with a vestibular disorder a screen that
// slides and spins causes nausea rather than mild annoyance.
//
// One hook rather than a check per animation. A primitive reads it once and every consumer inherits
// the answer, which is the only shape that stays true: a rule requiring each animation to remember is
// a rule that the next animation forgets.
//
// It follows the setting rather than reading it once at launch, because the setting is toggled in
// Settings while the app is in the background and returning to a still-spinning screen is precisely
// the case it exists for.
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    let alive = true
    // Defaults to false and stays there if the query fails. Falling the other way would silently
    // strip motion from every animation in the app on any device whose answer did not arrive.
    AccessibilityInfo.isReduceMotionEnabled()
      .then(on => alive && setReduced(on))
      .catch(() => undefined)
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      alive = false
      sub.remove()
    }
  }, [])

  return reduced
}

// The duration to actually animate for. Zero rather than skipping the animation, so state still
// arrives through the same path and nothing has to branch: a value that jumps is a value that
// changed, and every callback fires as it did before.
//
// Reduced motion is about movement, not about time. A cross-fade at full duration is fine under the
// setting and a slide is not, so this belongs on transforms and layout, and an opacity fade can keep
// its own timing.
export function motionFor(duration: number, reduced: boolean): number {
  return reduced ? 0 : duration
}
