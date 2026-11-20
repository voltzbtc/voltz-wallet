import { answerWithin } from './answerWithin'
import { emergencyExitLive } from './emergencyExit'
import { isLivePlan, loadExitPlan } from './exitPlan'
import { getActiveWalletId } from './walletRegistry'

// Why a spend stays shut: an exit alive, or a plan that could not be read, which may be one.
export type SendHold = 'none' | 'exit' | 'unread'

// A local file read, so a wait this long is a platform that will not answer.
const SEND_HOLD_WAIT_MS = 5_000

const holdOf = (walletId: string): Promise<SendHold> =>
  loadExitPlan(walletId).then(
    (plan): SendHold => (isLivePlan(plan) ? 'exit' : 'none'),
    (): SendHold => 'unread',
  )

async function holdOfEach(ids: readonly (string | null)[]): Promise<SendHold> {
  let hold: SendHold = 'none'
  for (const id of new Set(ids)) {
    if (id === null) {
      continue
    }
    const each = await holdOf(id)
    if (each === 'exit') {
      return 'exit'
    }
    if (each === 'unread') {
      hold = 'unread'
    }
  }
  return hold
}

// A read that fails or never answers holds the spend, as it holds a removal.
async function heldWithin(asked: () => Promise<SendHold>): Promise<SendHold> {
  if (!emergencyExitLive()) {
    return 'none'
  }
  const answer = asked().catch((): SendHold => 'unread')
  return (await answerWithin(answer, SEND_HOLD_WAIT_MS)) ?? 'unread'
}

// A send can spend the sat leaves an exit under way is taking on-chain, and a plan does not record which
// selection made it, so neither a prepare nor a confirm goes on while any plan is alive. The connected
// wallet is the one that signs, and a switch without reconnecting leaves it apart from the active one,
// so both are asked. The caller hands the connected id in, since spark.ts reads this module.
export function exitHoldOnSend(connectedWalletId: string | null): Promise<SendHold> {
  return heldWithin(async () => holdOfEach([await getActiveWalletId(), connectedWalletId]))
}

// The signing wallet alone, which is what spark.ts asks before every spend it signs.
export function exitHoldOnSigner(walletId: string | null): Promise<SendHold> {
  return heldWithin(() => holdOfEach([walletId]))
}
