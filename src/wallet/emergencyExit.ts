// The switch of everything an emergency exit adds to the app. Off, the drawer has no row, the Home draws
// no card for funds outside the balance, no route opens, no pass runs, and nothing talks to the chain
// hosts or derives the fee key. On once the two measures nothing else can give were taken on the real
// SDK on Android: connect and a quote with the three operators blocked, and a real package accepted by
// a public chain host and confirmed. What is still unmeasured is in docs/emergency-exit.md.
export const EMERGENCY_EXIT_LIVE = true

// What the suite forced, or null for the shipped value.
let forced: boolean | null = null

export function emergencyExitLive(): boolean {
  return forced ?? EMERGENCY_EXIT_LIVE
}

// For the suite alone: forces the switch either way, and null hands it back. __DEV__ is false in a release
// bundle and Metro writes NODE_ENV into every bundle it builds, so outside Jest the switch stays what it
// ships as, whatever is asked.
export function __setEmergencyExitLiveForTests(on: boolean | null): void {
  forced = __DEV__ && process.env.NODE_ENV === 'test' ? on : null
}
