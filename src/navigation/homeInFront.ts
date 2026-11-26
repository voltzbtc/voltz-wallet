// Whether Home's tab is the route in front with the drawer closed, read from the root navigation state:
// the root stack's Main on top, its drawer closed, and the tabs on Home. A nested state not yet built
// counts as not in front.

type Route = { name: string; state?: NavState }
type NavState = {
  index?: number
  routes: Route[]
  history?: unknown[]
  default?: string
}

function focused(state: NavState | undefined): Route | undefined {
  return state ? state.routes[state.index ?? 0] : undefined
}

// The drawer router keeps its status in history (getDrawerStatusFromState in @react-navigation/drawer).
function drawerOpen(state: NavState): boolean {
  const entries = (state.history ?? []) as { type?: string; status?: string }[]
  const last = [...entries].reverse().find(entry => entry.type === 'drawer')
  return (last?.status ?? state.default ?? 'closed') !== 'closed'
}

export function homeInFront(root: NavState | undefined): boolean {
  const main = focused(root)
  if (main?.name !== 'Main' || !main.state) {
    return false
  }
  if (drawerOpen(main.state)) {
    return false
  }
  const tabs = focused(main.state)
  return tabs?.name === 'Tabs' && focused(tabs.state)?.name === 'Home'
}
