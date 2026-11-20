import { waitForChange, DEFAULT_SETTLE_WATCH } from '../src/wallet/settleWatch'

// The clock is injected, so these measure the rule and not the wall.
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
  }
}

describe('waitForChange', () => {
  it('stops as soon as the value moves', async () => {
    const { sleep, waits } = fakeSleep()
    const reads = [10, 10, 42, 99]
    let i = 0
    const changed = await waitForChange(async () => reads[i++]!, 10, sleep, { attempts: 6, delayMs: 500 })

    expect(changed).toBe(true)
    expect(i).toBe(3)
    expect(waits).toEqual([500, 500, 500])
  })

  // The caller shows a success animation on the strength of this answer, so "we stopped waiting"
  // must never be reported as "the money arrived".
  it('reports not changed when the attempts run out', async () => {
    const { sleep, waits } = fakeSleep()
    const changed = await waitForChange(async () => 10, 10, sleep, { attempts: 3, delayMs: 200 })

    expect(changed).toBe(false)
    expect(waits).toHaveLength(3)
  })

  // It waits before the first read on purpose: the caller has just been told the swap was accepted,
  // and the balance at that instant is by definition the one from before it.
  it('waits before looking, never reading the balance it already has', async () => {
    const order: string[] = []
    await waitForChange(
      async () => {
        order.push('read')
        return 5
      },
      1,
      async () => {
        order.push('sleep')
      },
      { attempts: 2, delayMs: 100 },
    )
    expect(order[0]).toBe('sleep')
  })

  // A read that throws is a network blip. Ending the wait on one would drop the screen back to the
  // form with the old number, which is the exact failure this exists to prevent.
  it('survives a read that throws and keeps waiting', async () => {
    const { sleep } = fakeSleep()
    const reads: (() => number)[] = [
      () => {
        throw new Error('offline')
      },
      () => 7,
    ]
    let i = 0
    const changed = await waitForChange(async () => reads[i++]!(), 3, sleep, { attempts: 4, delayMs: 10 })

    expect(changed).toBe(true)
  })

  it('a value that moves and moves back still counts as movement', async () => {
    const { sleep } = fakeSleep()
    const reads = [9, 3]
    let i = 0
    expect(await waitForChange(async () => reads[i++]!, 3, sleep, { attempts: 4, delayMs: 10 })).toBe(true)
  })

  // Half a minute covers the swap the screen waits on, and bounds what a swap that never lands costs.
  it('the default waits long enough for a swap and no longer', () => {
    const total = (DEFAULT_SETTLE_WATCH.attempts * DEFAULT_SETTLE_WATCH.delayMs) / 1000
    expect(total).toBeGreaterThanOrEqual(20)
    expect(total).toBeLessThanOrEqual(45)
  })
})
