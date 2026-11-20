import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Platform, RefreshControl, ScrollView } from 'react-native'
import { usePullRefresh } from '../src/hooks/usePullRefresh'
import { SYNC_WAIT_MS } from '../src/wallet/spark'
import { space } from '../src/theme'

jest.mock('../src/wallet/spark', () => ({ SYNC_WAIT_MS: 12_000 }))
jest.mock('../src/wallet/dollarMode', () => ({
  useAccent: () => ({ accent: '#123456', gradient: ['#000000', '#000000'] }),
}))

let action: jest.Mock<Promise<void>, []>

function Host({ enabled }: { enabled?: boolean }): React.JSX.Element {
  const control = usePullRefresh(action, enabled)
  return <ScrollView refreshControl={control} />
}

function renderHost(enabled?: boolean): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Host enabled={enabled} />)
  })
  return tree
}

const control = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findByType(ScrollView).props.refreshControl as
    | React.ReactElement<React.ComponentProps<typeof RefreshControl>>
    | undefined

async function pull(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree)?.props.onRefresh?.()
  })
}

async function advance(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

function hanging(): { promise: Promise<void>; resolve: () => void; reject: (cause: Error) => void } {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  jest.useFakeTimers()
  action = jest.fn(async () => undefined)
})

afterEach(() => {
  jest.useRealTimers()
  Platform.OS = 'ios'
})

test('spins while the action runs and closes when it answers', async () => {
  const out = hanging()
  action.mockReturnValue(out.promise)
  const tree = renderHost()
  expect(control(tree)?.props.refreshing).toBe(false)

  await pull(tree)
  expect(control(tree)?.props.refreshing).toBe(true)

  await ReactTestRenderer.act(async () => {
    out.resolve()
  })
  expect(control(tree)?.props.refreshing).toBe(false)
})

test('closes when the action fails, with nothing thrown', async () => {
  const out = hanging()
  action.mockReturnValue(out.promise)
  const tree = renderHost()
  await pull(tree)

  await ReactTestRenderer.act(async () => {
    out.reject(new Error('read failed'))
  })

  expect(control(tree)?.props.refreshing).toBe(false)
})

test('never outlasts SYNC_WAIT_MS, whatever the action is waiting on', async () => {
  action.mockReturnValue(new Promise(() => undefined))
  const tree = renderHost()
  await pull(tree)

  await advance(SYNC_WAIT_MS - 1)
  expect(control(tree)?.props.refreshing).toBe(true)

  await advance(1)
  expect(control(tree)?.props.refreshing).toBe(false)
})

test('a second gesture while it spins starts nothing', async () => {
  action.mockReturnValue(new Promise(() => undefined))
  const tree = renderHost()
  await pull(tree)
  await pull(tree)

  expect(action).toHaveBeenCalledTimes(1)
})

test('an answer after the limit does not close the next pull', async () => {
  const first = hanging()
  action.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => undefined))
  const tree = renderHost()
  await pull(tree)
  await advance(SYNC_WAIT_MS)
  await pull(tree)
  expect(control(tree)?.props.refreshing).toBe(true)

  await ReactTestRenderer.act(async () => {
    first.resolve()
  })

  expect(control(tree)?.props.refreshing).toBe(true)
})

test('runs the action of the latest render', async () => {
  const tree = renderHost()
  const later = jest.fn(async () => undefined)
  action = later
  ReactTestRenderer.act(() => {
    tree.update(<Host />)
  })

  await pull(tree)

  expect(later).toHaveBeenCalledTimes(1)
})

test('takes the accent on both platforms', () => {
  const props = control(renderHost())?.props

  expect(props?.tintColor).toBe('#123456')
  expect(props?.colors).toEqual(['#123456'])
})

// The disc rests over the first line of the screen, and the first line starts at the screen's margin.
test('on Android the bare arc rests in the margin above the content', () => {
  Platform.OS = 'android'
  const props = control(renderHost())?.props
  const restsAt = Number(props?.progressViewOffset) + 64 - 40

  expect(props?.progressBackgroundColor).toBe('transparent')
  expect(restsAt + 40 / 2).toBe(space.xl / 2)
})

test('on iOS the content moves for the spinner, so it takes no offset', () => {
  expect(control(renderHost())?.props.progressViewOffset).toBeUndefined()
})

test('off on iOS, the control is not there', () => {
  expect(control(renderHost(false))).toBeUndefined()
})

// ScrollView wraps itself in the control on Android, so losing it would remount the whole scroll.
test('off on Android, the control stays and is disabled', () => {
  Platform.OS = 'android'

  expect(control(renderHost(false))?.props.enabled).toBe(false)
})

test('going away with a pull in flight leaves no timer behind', async () => {
  action.mockReturnValue(new Promise(() => undefined))
  const tree = renderHost()
  await pull(tree)
  const cleared = jest.spyOn(global, 'clearTimeout')

  ReactTestRenderer.act(() => {
    tree.unmount()
  })

  expect(cleared).toHaveBeenCalled()
  cleared.mockRestore()
})
