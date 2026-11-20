import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import RNFS from 'react-native-fs'
import { useBtcDayChange } from '../src/hooks/useBtcDayChange'
import { fetchBtcPriceSeries, periodChange } from '../src/wallet/price'

// jest.setup.js keeps every other suite off the network with a stand-in for this hook.
jest.unmock('../src/hooks/useBtcDayChange')

const SPOT = 420_000
const FIVE_MINUTES = 5 * 60 * 1000
const HOUR = 3_600_000
const START = new Date('2026-11-05T12:00:00Z').getTime()

type FsMock = typeof RNFS & { __reset: () => void }

// A day of candles from `open` to `close`, as Kraken answers, ending now.
function kraken(now: number, open: number, close: number) {
  const candle = (ms: number, value: number) => [ms / 1000, '1', '2', '0', String(value), '1', '1', 1]
  return {
    ok: true,
    json: async () => ({
      error: [],
      result: { XXBTZUSD: [candle(now - 24 * HOUR, open), candle(now - 60_000, close)], last: 1 },
    }),
  }
}

let seen: number | null = null
function Strip({ readAt }: { readAt: number }): null {
  seen = useBtcDayChange(SPOT, readAt)
  return null
}

// What the asset screen's 1D chart states, through the calls that screen makes.
async function chart(): Promise<number> {
  return periodChange((await fetchBtcPriceSeries('1D', SPOT)) ?? []).pct
}

async function settle(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(0)
  })
}

function answers(open: number, close: number): void {
  ;(global as unknown as { fetch: unknown }).fetch = jest.fn(async () => kraken(Date.now(), open, close))
}

let tree: ReactTestRenderer.ReactTestRenderer
async function mount(readAt: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Strip readAt={readAt} />)
  })
  await settle()
}

beforeEach(() => {
  ;(RNFS as FsMock).__reset()
  jest.useFakeTimers()
  jest.setSystemTime(START)
})

afterEach(() => {
  ReactTestRenderer.act(() => tree.unmount())
  jest.useRealTimers()
})

test('the strip and the chart state one figure on one series', async () => {
  answers(100, 95)
  await mount(START)

  expect(seen).toBeCloseTo(await chart())
  expect(seen).toBeCloseTo(-5)
})

test('a newer series the chart fetched reaches the strip, at the same price', async () => {
  answers(100, 95)
  await mount(START)

  jest.setSystemTime(START + FIVE_MINUTES)
  answers(100, 94)
  const stated = await chart()
  await settle()

  expect(stated).toBeCloseTo(-6)
  expect(seen).toBeCloseTo(stated)
})

test('a price read past the life of the series reads a new one, so a tap opens on the same figure', async () => {
  answers(100, 95)
  await mount(START)

  jest.setSystemTime(START + FIVE_MINUTES)
  answers(100, 94)
  await ReactTestRenderer.act(async () => {
    tree.update(<Strip readAt={START + FIVE_MINUTES} />)
  })
  await settle()

  expect(seen).toBeCloseTo(-6)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(await chart()).toBeCloseTo(seen as number)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})
