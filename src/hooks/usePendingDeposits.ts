import { useCallback, useEffect, useRef, useState } from 'react'
import { sparkListUnclaimedDeposits, type SparkDeposit } from '../wallet/spark'
import { depositsRereadLimitMs } from '../components/UnclaimedDepositsCard'
import { onActiveWalletChanged } from '../wallet/wallet'

// The deposits a list shows above its rows, read on their own so the list never waits for them. A read
// in flight keeps what is on screen, so a refresh does not blink. One that fails or passes the limit
// clears them: an old row would keep saying money is on its way after it landed.
//
// `standing` is what the last read to end says of the list: `unread` until one ends on this wallet, and
// `failed` when no row means only that nothing answered, so no row is not yet proof of no deposit.
export type DepositsStanding = 'unread' | 'read' | 'failed'

export function usePendingDeposits(): {
  deposits: SparkDeposit[]
  standing: DepositsStanding
  read: () => void
} {
  const [deposits, setDeposits] = useState<SparkDeposit[]>([])
  const [standing, setStanding] = useState<DepositsStanding>('unread')
  // Only the last read started may land, and a wallet switch or an unmount counts as a newer one.
  const latest = useRef(0)

  const read = useCallback(() => {
    const mine = ++latest.current
    const land = (list: SparkDeposit[], ended: DepositsStanding) => {
      if (mine === latest.current) {
        setDeposits(list)
        setStanding(ended)
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deposits read past its limit')), depositsRereadLimitMs())
    })
    Promise.race([Promise.resolve().then(() => sparkListUnclaimedDeposits()), limit])
      .then(
        list => land(list, 'read'),
        () => land([], 'failed'),
      )
      .finally(() => clearTimeout(timer))
  }, [])

  useEffect(
    () =>
      onActiveWalletChanged(() => {
        latest.current += 1
        setDeposits([])
        setStanding('unread')
      }),
    [],
  )
  useEffect(
    () => () => {
      latest.current += 1
    },
    [],
  )

  return { deposits, standing, read }
}
