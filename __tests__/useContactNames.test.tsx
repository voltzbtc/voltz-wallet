import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { useContactNames } from '../src/hooks/useContactNames'
import { sparkListContacts, sparkListHistory } from '../src/wallet/spark'

jest.mock('../src/wallet/spark', () => ({
  sparkListContacts: jest.fn(),
  sparkListHistory: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    mockEvents.connected = cb
    return () => undefined
  },
}))

const mockEvents: { connected?: () => void; switched?: () => void; focus?: (on: boolean) => void } = {}
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockEvents.switched = cb
    return () => undefined
  },
}))

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useFocusEffect: (cb: () => void) => {
      const [on, setOn] = react.useState(true)
      mockEvents.focus = setOn
      react.useEffect(() => (on ? cb() : undefined), [cb, on])
    },
  }
})

const contact = (name: string, address: string) => ({ id: name, name, address })
const list = jest.mocked(sparkListContacts)

function Probe(): React.JSX.Element {
  const names = useContactNames()
  return <Text>{JSON.stringify([...names])}</Text>
}

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  return tree
}

const held = (tree: ReactTestRenderer.ReactTestRenderer): [string, string][] =>
  JSON.parse(String(tree.root.findByType(Text).props.children))

const act = (fn: () => void) => ReactTestRenderer.act(async () => fn())

beforeEach(() => {
  jest.clearAllMocks()
  list.mockResolvedValue([contact('Maria', 'maria@usevoltz.app')])
})

test('maps each address, trimmed and in lowercase, to its name', async () => {
  list.mockResolvedValue([contact('Maria', ' Maria@Usevoltz.App ')])

  expect(held(await mount())).toEqual([['maria@usevoltz.app', 'Maria']])
})

test('a rename shows on the next focus, with no payment read', async () => {
  const tree = await mount()
  list.mockResolvedValue([contact('Mia', 'maria@usevoltz.app')])

  await act(() => mockEvents.focus?.(false))
  await act(() => mockEvents.focus?.(true))

  expect(held(tree)).toEqual([['maria@usevoltz.app', 'Mia']])
  expect(sparkListHistory).not.toHaveBeenCalled()
})

test('a read that fails leaves the map empty and raises nothing', async () => {
  list.mockRejectedValue(new Error('no connection'))

  expect(held(await mount())).toEqual([])
})

test('a new connection reads again, for a first read that came before the SDK was up', async () => {
  list.mockRejectedValueOnce(new Error('no connection'))
  const tree = await mount()
  expect(held(tree)).toEqual([])

  await act(() => mockEvents.connected?.())

  expect(held(tree)).toEqual([['maria@usevoltz.app', 'Maria']])
})

// Contacts belong to a wallet, and the tab stays mounted across a switch.
describe('a wallet switch', () => {
  test('clears the map at once and asks nothing of an SDK still on the previous wallet', async () => {
    const tree = await mount()
    list.mockClear()

    await act(() => mockEvents.switched?.())

    expect(held(tree)).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  test('drops an answer for the previous wallet that lands after it', async () => {
    let answer: (value: ReturnType<typeof contact>[]) => void = () => undefined
    list.mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    const tree = await mount()

    await act(() => mockEvents.switched?.())
    await act(() => answer([contact('Old', 'old@usevoltz.app')]))

    expect(held(tree)).toEqual([])
  })

  test('the new connection fills it for the new wallet', async () => {
    const tree = await mount()
    await act(() => mockEvents.switched?.())
    list.mockResolvedValue([contact('Ana', 'ana@usevoltz.app')])

    await act(() => mockEvents.connected?.())

    expect(held(tree)).toEqual([['ana@usevoltz.app', 'Ana']])
  })
})
