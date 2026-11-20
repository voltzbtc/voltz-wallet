import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { useHomeExit, type HomeExit } from '../src/hooks/useHomeExit'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { runExitPass, type PassOutcome } from '../src/wallet/exitPass'
import { loadExitPlan, type ExitPlan } from '../src/wallet/exitPlan'
import { planOf } from './support/exitFixtures'

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    ...jest.requireActual('@react-navigation/native'),
    useFocusEffect: (effect: () => void | (() => void)) => react.useEffect(effect, [effect]),
  }
})
jest.mock('../src/wallet/exitPass', () => ({
  ...jest.requireActual('../src/wallet/exitPass'),
  runExitPass: jest.fn(),
}))
jest.mock('../src/wallet/exitPlan', () => ({
  ...jest.requireActual('../src/wallet/exitPlan'),
  loadExitPlan: jest.fn(),
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Every value the hook hands Home, render by render, so a value shown for one render is seen.
let shown: HomeExit[] = []
const onPassEnd = () => undefined

function Probe({ walletId }: { walletId: string | null }): null {
  shown.push(useHomeExit(walletId, onPassEnd))
  return null
}

const reads = new Map<string, ReturnType<typeof deferred<ExitPlan | null>>>()

beforeEach(() => {
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  shown = []
  reads.clear()
  jest.mocked(loadExitPlan).mockImplementation(walletId => {
    const read = deferred<ExitPlan | null>()
    reads.set(walletId, read)
    return read.promise
  })
  jest
    .mocked(runExitPass)
    .mockImplementation(async walletId => ({ kind: 'offline', plan: planOf({ walletId }) }) as PassOutcome)
})

afterEach(() => __setEmergencyExitLiveForTests(null))

async function render(walletId: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe walletId={walletId} />)
  })
  return tree
}

async function switchTo(tree: ReactTestRenderer.ReactTestRenderer, walletId: string): Promise<void> {
  await ReactTestRenderer.act(async () => tree.update(<Probe walletId={walletId} />))
}

async function answer(walletId: string, settle: (read: ReturnType<typeof deferred<ExitPlan | null>>) => void) {
  await ReactTestRenderer.act(async () => settle(reads.get(walletId)!))
}

// A wallet with an exit under way, read and followed.
async function underWay(walletId: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  const tree = await render(walletId)
  await answer(walletId, read => read.resolve(planOf({ walletId })))
  expect(shown.at(-1)).toBe('underWay')
  return tree
}

describe("after a switch, the card never shows the previous wallet's exit", () => {
  test('while the new wallet is read, not for one render', async () => {
    const tree = await underWay('a')
    shown = []
    await switchTo(tree, 'b')
    expect(reads.has('b')).toBe(true)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.every(value => value === 'none')).toBe(true)
  })

  test("and once the new wallet's plan answers, says what it holds", async () => {
    const tree = await underWay('a')
    await switchTo(tree, 'b')
    await answer('b', read => read.resolve(null))
    expect(shown.at(-1)).toBe('none')
    await switchTo(tree, 'a')
    expect(shown.at(-1)).toBe('none')
    await answer('a', read => read.resolve(planOf({ walletId: 'a' })))
    expect(shown.at(-1)).toBe('underWay')
  })

  // A plan the platform will not read may be a live one.
  test("a new wallet's read that fails counts as under way, for that wallet", async () => {
    const tree = await render('a')
    await answer('a', read => read.resolve(null))
    await switchTo(tree, 'b')
    expect(shown.at(-1)).toBe('none')
    await answer('b', read => read.reject(new Error('EACCES')))
    expect(shown.at(-1)).toBe('underWay')
  })

  test("a read that never answers keeps the card empty, never the previous wallet's", async () => {
    const tree = await underWay('a')
    shown = []
    await switchTo(tree, 'b')
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(shown.every(value => value === 'none')).toBe(true)
  })

  test('a read of the wallet left that answers after the switch back lands nowhere', async () => {
    const tree = await render('a')
    await answer('a', read => read.resolve(null))
    await switchTo(tree, 'b')
    const left = reads.get('b')!
    await switchTo(tree, 'a')
    await ReactTestRenderer.act(async () => left.resolve(planOf({ walletId: 'b' })))
    expect(shown.at(-1)).toBe('none')
    await answer('a', read => read.resolve(null))
    expect(shown.at(-1)).toBe('none')
  })
})
