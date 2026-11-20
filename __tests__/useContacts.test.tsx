import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { useContacts } from '../src/hooks/useContacts'
import { sparkListContacts, type SparkContact } from '../src/wallet/spark'

const mockEvents: { connected?: () => void; switched?: () => void; focus?: () => void } = {}

jest.mock('../src/wallet/spark', () => ({
  sparkListContacts: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    mockEvents.connected = cb
    return () => undefined
  },
}))
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockEvents.switched = cb
    return () => undefined
  },
}))
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    mockEvents.focus = cb
    require('react').useEffect(() => cb(), [cb])
  },
}))

const MARIA: SparkContact = { id: 'c1', name: 'Maria', address: 'maria@usevoltz.app' }
const list = jest.mocked(sparkListContacts)

function Probe(): React.JSX.Element {
  return <Text>{JSON.stringify(useContacts())}</Text>
}

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  return tree
}

const held = (tree: ReactTestRenderer.ReactTestRenderer) =>
  JSON.parse(String(tree.root.findByType(Text).props.children))

const act = (fn: () => void) => ReactTestRenderer.act(async () => fn())

beforeEach(() => {
  list.mockReset()
  list.mockResolvedValue([MARIA])
})

test('says the read answered, with nothing in the list too', async () => {
  list.mockResolvedValue([])
  expect(held(await mount())).toEqual({ contacts: [], answered: true })
})

test('before any answer it claims nothing', async () => {
  list.mockReturnValue(new Promise(() => undefined))
  expect(held(await mount())).toEqual({ contacts: [], answered: false })
})

test('a read that failed is not an empty list that answered', async () => {
  list.mockRejectedValue(new Error('no connection'))
  expect(held(await mount())).toEqual({ contacts: [], answered: false })
})

test('a later failure keeps the names and stops vouching for the list', async () => {
  const tree = await mount()
  list.mockRejectedValue(new Error('no connection'))
  await act(() => mockEvents.focus?.())
  expect(held(tree)).toEqual({ contacts: [MARIA], answered: false })
})

test('a new connection reads again and answers', async () => {
  list.mockRejectedValueOnce(new Error('not connected'))
  const tree = await mount()
  await act(() => mockEvents.connected?.())
  expect(held(tree)).toEqual({ contacts: [MARIA], answered: true })
})

test('a focus between a switch and its connection reads nothing, and the connection reads', async () => {
  const tree = await mount()
  await act(() => mockEvents.switched?.())
  list.mockClear()
  list.mockResolvedValue([MARIA])

  await act(() => mockEvents.focus?.())
  expect(list).not.toHaveBeenCalled()
  expect(held(tree)).toEqual({ contacts: [], answered: false })

  await act(() => mockEvents.connected?.())
  expect(list).toHaveBeenCalledTimes(1)
  expect(held(tree)).toEqual({ contacts: [MARIA], answered: true })
})

test('a wallet switch clears the list, and an answer for the previous wallet stays out', async () => {
  let answer!: (contacts: SparkContact[]) => void
  const tree = await mount()
  list.mockReturnValue(new Promise(resolve => (answer = resolve)))
  await act(() => mockEvents.focus?.())
  await act(() => mockEvents.switched?.())
  expect(held(tree)).toEqual({ contacts: [], answered: false })

  await act(() => answer([MARIA]))
  expect(held(tree)).toEqual({ contacts: [], answered: false })
})
