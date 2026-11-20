import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState } from 'react-native'
import RNFS from 'react-native-fs'
import * as settings from '../src/wallet/settings'
import { readUpdateNotice, type UpdateNotice } from '../src/wallet/updateNotice'
import type { useUpdateNotice as Hook } from '../src/hooks/useUpdateNotice'

// Blur and focus, driven by the test as a navigator drives them.
let mockFocused = true
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]),
  }
})

const read = jest.mocked(readUpdateNotice)
const SIX_HOURS = 6 * 60 * 60 * 1000
const NORMAL: UpdateNotice = { level: 'normal', latest: '1.2.0' }

type Seen = ReturnType<typeof Hook>

// The hook's memory belongs to the process, so a fresh copy of its module is a restart of the app.
// The modules around it stay the ones the test holds.
function restart(): typeof Hook {
  let hook!: typeof Hook
  jest.isolateModules(() => {
    jest.doMock('react', () => React)
    jest.doMock('react-native', () => jest.requireActual('react-native'))
    jest.doMock('../src/wallet/settings', () => settings)
    jest.doMock('../src/wallet/updateNotice', () => ({ readUpdateNotice: read }))
    hook = require('../src/hooks/useUpdateNotice').useUpdateNotice
  })
  jest.dontMock('react')
  jest.dontMock('react-native')
  jest.dontMock('../src/wallet/settings')
  jest.dontMock('../src/wallet/updateNotice')
  return hook
}

type Mounted = {
  seen: () => Seen
  tree: ReactTestRenderer.ReactTestRenderer
  setFocused: (focused: boolean) => void
}

function mount(hook: typeof Hook): Mounted {
  const latest: { current: Seen | null } = { current: null }
  function Probe(): null {
    latest.current = hook()
    return null
  }
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  return {
    seen: () => latest.current as Seen,
    tree,
    setFocused: focused => {
      mockFocused = focused
      ReactTestRenderer.act(() => tree.update(<Probe />))
    },
  }
}

// Fake timers draw a frame every 16 ms, as a display does.
const settle = () =>
  ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(20)
  })

// Each return to the foreground reaches every listener a mounted hook left on AppState.
function foreground(): Promise<void> {
  const listeners = jest.mocked(AppState.addEventListener).mock.calls.map(call => call[1])
  return ReactTestRenderer.act(async () => {
    listeners.forEach(listener => listener('active'))
    await jest.advanceTimersByTimeAsync(0)
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-11-05T12:00:00Z'))
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  read.mockReset()
  read.mockResolvedValue(null)
  jest.mocked(AppState.addEventListener).mockClear()
  mockFocused = true
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('when the read happens', () => {
  test('after the first frame, never during the render or the mount', async () => {
    mount(restart())
    expect(read).not.toHaveBeenCalled()
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('once a process, with a Home mounted again reading nothing and keeping the answer', async () => {
    read.mockResolvedValue(NORMAL)
    const hook = restart()
    const first = mount(hook)
    await settle()
    expect(first.seen().notice).toEqual(NORMAL)
    ReactTestRenderer.act(() => first.tree.unmount())

    const second = mount(hook)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(second.seen().notice).toEqual(NORMAL)
  })

  test('a mount left before its first frame reads nothing', async () => {
    const { tree } = mount(restart())
    ReactTestRenderer.act(() => tree.unmount())
    await settle()
    expect(read).not.toHaveBeenCalled()
  })

  test('not again on a return before six hours', async () => {
    mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS - 1_000)
    await foreground()
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('again on a return after six hours, and the new answer replaces the old', async () => {
    read.mockResolvedValueOnce(NORMAL).mockResolvedValueOnce({ level: 'critical' })
    const { seen } = mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS)
    await foreground()
    expect(read).toHaveBeenCalledTimes(2)
    expect(seen().notice).toEqual({ level: 'critical' })
  })

  test('a re-read with no answer takes the banner down, since an old answer says nothing of today', async () => {
    read.mockResolvedValueOnce(NORMAL).mockResolvedValueOnce(null)
    const { seen } = mount(restart())
    await settle()
    expect(seen().notice).toEqual(NORMAL)
    jest.setSystemTime(Date.now() + SIX_HOURS)
    await foreground()
    expect(seen().notice).toBeNull()
  })

  test('a return to anything but active reads nothing', async () => {
    mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS)
    const listeners = jest.mocked(AppState.addEventListener).mock.calls.map(call => call[1])
    await ReactTestRenderer.act(async () => {
      listeners.forEach(listener => listener('background'))
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('nothing is kept across a restart: an answer from before says nothing to the next process', async () => {
    read.mockResolvedValueOnce(NORMAL).mockResolvedValueOnce(null)
    const { seen, tree } = mount(restart())
    await settle()
    expect(seen().notice).toEqual(NORMAL)
    ReactTestRenderer.act(() => tree.unmount())

    const again = mount(restart())
    await settle()
    expect(again.seen().notice).toBeNull()
  })
})

describe('a read in flight', () => {
  test('shows nothing until it answers', async () => {
    const answer = deferred<UpdateNotice | null>()
    read.mockReturnValue(answer.promise)
    const { seen } = mount(restart())
    await settle()
    expect(seen().notice).toBeNull()
    await ReactTestRenderer.act(async () => answer.resolve(NORMAL))
    expect(seen().notice).toEqual(NORMAL)
  })

  test('landing after a touch moves nothing on the screen, and shows on the next focus', async () => {
    const answer = deferred<UpdateNotice | null>()
    read.mockReturnValue(answer.promise)
    const { seen, setFocused } = mount(restart())
    await settle()
    ReactTestRenderer.act(() => seen().noteTouch())
    await ReactTestRenderer.act(async () => answer.resolve({ level: 'critical' }))
    expect(seen().notice).toBeNull()

    setFocused(false)
    expect(seen().notice).toBeNull()
    setFocused(true)
    expect(seen().notice).toEqual({ level: 'critical' })
  })

  test('landing with the screen blurred lights the state behind it', async () => {
    const answer = deferred<UpdateNotice | null>()
    read.mockReturnValue(answer.promise)
    const { seen, setFocused } = mount(restart())
    await settle()
    ReactTestRenderer.act(() => seen().noteTouch())
    setFocused(false)
    await ReactTestRenderer.act(async () => answer.resolve({ level: 'critical' }))
    expect(seen().notice).toEqual({ level: 'critical' })
  })

  test('a read that outlives its Home lands in the Home mounted since', async () => {
    const pending = deferred<UpdateNotice | null>()
    read.mockReturnValue(pending.promise)
    const hook = restart()
    const first = mount(hook)
    await settle()
    ReactTestRenderer.act(() => first.tree.unmount())

    const second = mount(hook)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => {
      pending.resolve(NORMAL)
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(second.seen().notice).toEqual(NORMAL)
  })

  test('a touch on the Home that left holds nothing back in the one mounted since', async () => {
    const pending = deferred<UpdateNotice | null>()
    read.mockReturnValue(pending.promise)
    const hook = restart()
    const first = mount(hook)
    await settle()
    ReactTestRenderer.act(() => first.seen().noteTouch())
    ReactTestRenderer.act(() => first.tree.unmount())

    const second = mount(hook)
    await settle()
    await ReactTestRenderer.act(async () => {
      pending.resolve(NORMAL)
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(second.seen().notice).toEqual(NORMAL)
  })

  test('a touch before the read began holds nothing back', async () => {
    read.mockResolvedValueOnce(null).mockResolvedValueOnce(NORMAL)
    const { seen } = mount(restart())
    await settle()
    ReactTestRenderer.act(() => seen().noteTouch())
    jest.setSystemTime(Date.now() + SIX_HOURS)
    await foreground()
    expect(seen().notice).toEqual(NORMAL)
  })
})

describe('dismissing', () => {
  test('hides the normal banner, and the next process stays quiet about that version', async () => {
    read.mockResolvedValue(NORMAL)
    const first = mount(restart())
    await settle()
    await ReactTestRenderer.act(async () => first.seen().dismiss())
    expect(first.seen().notice).toBeNull()
    ReactTestRenderer.act(() => first.tree.unmount())

    const second = mount(restart())
    await settle()
    expect(second.seen().notice).toBeNull()
    expect(await settings.loadDismissedUpdate()).toBe('1.2.0')
  })

  test('the next version comes back', async () => {
    read.mockResolvedValue(NORMAL)
    const first = mount(restart())
    await settle()
    await ReactTestRenderer.act(async () => first.seen().dismiss())
    ReactTestRenderer.act(() => first.tree.unmount())

    read.mockResolvedValue({ level: 'normal', latest: '1.3.0' })
    const second = mount(restart())
    await settle()
    expect(second.seen().notice).toEqual({ level: 'normal', latest: '1.3.0' })
  })

  test('answers for the banner on screen, even when a read held back by a touch knows otherwise', async () => {
    read.mockResolvedValue(NORMAL)
    const home = mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS + 1000)
    const pending = deferred<UpdateNotice | null>()
    read.mockReturnValue(pending.promise)
    await foreground()
    ReactTestRenderer.act(() => home.seen().noteTouch())
    await ReactTestRenderer.act(async () => {
      pending.resolve(null)
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(home.seen().notice).toEqual(NORMAL)

    ReactTestRenderer.act(() => home.seen().dismiss())
    await settle()

    expect(home.seen().notice).toBeNull()
    expect(await settings.loadDismissedUpdate()).toBe('1.2.0')
  })

  test('a newer version held back by a touch comes up as the dismissed one goes, and needs its own dismissal', async () => {
    read.mockResolvedValue(NORMAL)
    const home = mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS + 1000)
    const pending = deferred<UpdateNotice | null>()
    read.mockReturnValue(pending.promise)
    await foreground()
    ReactTestRenderer.act(() => home.seen().noteTouch())
    await ReactTestRenderer.act(async () => {
      pending.resolve({ level: 'normal', latest: '1.3.0' })
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(home.seen().notice).toEqual(NORMAL)

    ReactTestRenderer.act(() => home.seen().dismiss())
    await settle()
    expect(home.seen().notice).toEqual({ level: 'normal', latest: '1.3.0' })
    expect(await settings.loadDismissedUpdate()).toBe('1.2.0')

    ReactTestRenderer.act(() => home.seen().dismiss())
    await settle()
    expect(home.seen().notice).toBeNull()
    expect(await settings.loadDismissedUpdate()).toBe('1.3.0')
  })

  test('a critical notice held back by a touch stays up past the dismissal of the normal one', async () => {
    read.mockResolvedValue(NORMAL)
    const home = mount(restart())
    await settle()
    jest.setSystemTime(Date.now() + SIX_HOURS + 1000)
    const pending = deferred<UpdateNotice | null>()
    read.mockReturnValue(pending.promise)
    await foreground()
    ReactTestRenderer.act(() => home.seen().noteTouch())
    await ReactTestRenderer.act(async () => {
      pending.resolve({ level: 'critical' })
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(home.seen().notice).toEqual(NORMAL)

    ReactTestRenderer.act(() => home.seen().dismiss())
    await settle()
    expect(home.seen().notice).toEqual({ level: 'critical' })
  })

  test('the critical banner has no dismissal, even for a version dismissed before', async () => {
    await settings.saveDismissedUpdate('1.2.0')
    read.mockResolvedValue({ level: 'critical' })
    const { seen } = mount(restart())
    await settle()
    await ReactTestRenderer.act(async () => seen().dismiss())
    expect(seen().notice).toEqual({ level: 'critical' })
    expect(await settings.loadDismissedUpdate()).toBe('1.2.0')
  })

  test('a save that fails hides it for the session and it returns in the next', async () => {
    read.mockResolvedValue(NORMAL)
    const first = mount(restart())
    await settle()
    jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'))
    await ReactTestRenderer.act(async () => first.seen().dismiss())
    expect(first.seen().notice).toBeNull()

    jest.setSystemTime(Date.now() + SIX_HOURS)
    await foreground()
    expect(read).toHaveBeenCalledTimes(2)
    expect(first.seen().notice).toBeNull()
    ReactTestRenderer.act(() => first.tree.unmount())

    const second = mount(restart())
    await settle()
    expect(second.seen().notice).toEqual(NORMAL)
  })

  test('a dismissal unread because the file is torn shows the banner, never stops it', async () => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/settings.json`, '{"dismissed', 'utf8')
    read.mockResolvedValue(NORMAL)
    const { seen } = mount(restart())
    await settle()
    expect(seen().notice).toEqual(NORMAL)
  })
})
