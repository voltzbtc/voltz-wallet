import { STABLE_LOGOS, chainIconId, coinIconId } from '../src/components/stableLogos'

// Every network the provider serves for a receive, copied from its live list. A chain without a
// mark falls back to a letter, which reads as broken next to the real logos.
const SERVED_CHAINS = [
  'arbitrum', 'arc', 'avalanche', 'base', 'bsc', 'ethereum', 'hypercore', 'hyperevm', 'monad',
  'optimism', 'plasma', 'polygon', 'solana', 'tempo', 'tron',
]

test('both coins and every served network have their mark', () => {
  for (const coin of ['USDT', 'USDC']) {
    expect(STABLE_LOGOS[coinIconId(coin)]).toBeDefined()
  }
  const missing = SERVED_CHAINS.filter(slug => STABLE_LOGOS[chainIconId(slug)] === undefined)
  expect(missing).toEqual([])
})

// The fixed network row of USDB and DePix names Spark, so Spark needs its mark like any served chain.
test('Spark has its network mark', () => {
  expect(STABLE_LOGOS[chainIconId('spark')]).toBeDefined()
})
