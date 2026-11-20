import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Image, StyleSheet } from 'react-native'
import i18n from '../src/i18n'
import { AdjustWalletPhotoScreen } from '../src/screens/AdjustWalletPhotoScreen'
import { GradientButton } from '../src/components/GradientButton'
import { discardPickedImage } from '../src/wallet/walletImage'
import { space } from '../src/theme'

// The adjust step hands Edit wallet a crop on Use and nothing else. Any other way out drops the
// picker's copy, so the wallet's photo, crop and colour stay as they were, which Edit wallet holds by
// changing nothing until a photo comes back.

const mockGoBack = jest.fn()
const mockPopTo = jest.fn()
let mockParams = { uri: 'file:///cache/picked.jpg', width: 1000, height: 1000 }

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, popTo: mockPopTo }),
  useRoute: () => ({ params: mockParams }),
}))
jest.mock('../src/wallet/walletImage', () => ({ discardPickedImage: jest.fn(async () => undefined) }))

// The mocked window is 320 wide, so the circle is 320 less the gutters, centred on a stage 320 wide.
const DIAMETER = 320 - space.xl * 2
// Where the stage sits on the page, and so the circle's centre there.
const STAGE_TOP = 100
const CENTRE = { x: 160, y: STAGE_TOP + (DIAMETER + space.xl * 2) / 2 }

let tree: ReactTestRenderer.ReactTestRenderer

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AdjustWalletPhotoScreen />)
  })
}

const stage = () => tree.root.find(n => n.props.testID === 'adjust-stage' && typeof n.props.onResponderGrant === 'function')

function event(touches: { x: number; y: number }[]) {
  const pages = touches.map(t => ({ pageX: t.x, pageY: t.y }))
  return {
    nativeEvent: {
      touches: pages,
      pageX: pages[0].pageX,
      pageY: pages[0].pageY,
      locationX: pages[0].pageX,
      locationY: pages[0].pageY - STAGE_TOP,
    },
  }
}

async function gesture(...frames: { x: number; y: number }[][]): Promise<void> {
  await ReactTestRenderer.act(async () => {
    stage().props.onResponderGrant(event(frames[0]))
    for (const frame of frames.slice(1)) {
      stage().props.onResponderMove(event(frame))
    }
    stage().props.onResponderRelease(event(frames[frames.length - 1]))
  })
}

async function press(label: string): Promise<void> {
  const button = tree.root.findAllByType(GradientButton).find(b => b.props.label === label)!
  await ReactTestRenderer.act(async () => button.props.onPress())
}

function used() {
  expect(mockPopTo).toHaveBeenCalledTimes(1)
  const [name, params, options] = mockPopTo.mock.calls[0]
  expect(name).toBe('EditWallet')
  expect(options).toEqual({ merge: true })
  return params.photo
}

const near = (crop: Record<string, number>, expected: Record<string, number>) => {
  for (const key of Object.keys(expected)) {
    expect(crop[key]).toBeCloseTo(expected[key], 6)
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = { uri: 'file:///cache/picked.jpg', width: 1000, height: 1000 }
})

describe('leaving', () => {
  test('Cancel discards the picker copy and hands nothing back', async () => {
    await render()
    await press(i18n.t('editWallet.cancel'))
    expect(discardPickedImage).toHaveBeenCalledWith('file:///cache/picked.jpg')
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    expect(mockPopTo).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => tree.unmount())
    expect(discardPickedImage).toHaveBeenCalledTimes(1)
  })

  test('going back by the header or a swipe discards the picker copy too', async () => {
    await render()
    await ReactTestRenderer.act(async () => tree.unmount())
    expect(discardPickedImage).toHaveBeenCalledWith('file:///cache/picked.jpg')
    expect(mockPopTo).not.toHaveBeenCalled()
  })

  test('Use hands the photo and its crop back and keeps the copy for the save', async () => {
    await render()
    await press(i18n.t('adjustPhoto.use'))
    expect(used()).toEqual({ uri: 'file:///cache/picked.jpg', crop: { x: 0, y: 0, w: 1, h: 1 } })
    await ReactTestRenderer.act(async () => tree.unmount())
    expect(discardPickedImage).not.toHaveBeenCalled()
  })
})

describe('the gestures', () => {
  test('untouched, a landscape photo gives its middle square', async () => {
    mockParams = { ...mockParams, width: 2000, height: 1000 }
    await render()
    await press(i18n.t('adjustPhoto.use'))
    near(used().crop, { x: 0.25, y: 0, w: 0.5, h: 1 })
  })

  test('a drag moves the photo, and past its edge it stops there', async () => {
    mockParams = { ...mockParams, width: 2000, height: 1000 }
    await render()
    // A quarter of a diameter to the right shows more of the photo's left.
    await gesture([CENTRE], [{ x: CENTRE.x + DIAMETER / 4, y: CENTRE.y }])
    await gesture([CENTRE], [{ x: CENTRE.x + DIAMETER * 5, y: CENTRE.y + DIAMETER * 5 }])
    await press(i18n.t('adjustPhoto.use'))
    near(used().crop, { x: 0, y: 0, w: 0.5, h: 1 })
  })

  test('a pinch zooms around the fingers and draws the photo at its zoomed size', async () => {
    await render()
    await gesture(
      [
        { x: CENTRE.x - 50, y: CENTRE.y },
        { x: CENTRE.x + 50, y: CENTRE.y },
      ],
      [
        { x: CENTRE.x - 100, y: CENTRE.y },
        { x: CENTRE.x + 100, y: CENTRE.y },
      ],
    )
    const photo = StyleSheet.flatten(tree.root.findByType(Image).props.style)
    expect(photo.width).toBeCloseTo(DIAMETER * 2, 6)
    await press(i18n.t('adjustPhoto.use'))
    near(used().crop, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })

  test('a pinch in below zoom 1 leaves the circle covered', async () => {
    await render()
    await gesture(
      [
        { x: CENTRE.x - 100, y: CENTRE.y },
        { x: CENTRE.x + 100, y: CENTRE.y },
      ],
      [
        { x: CENTRE.x - 10, y: CENTRE.y + 30 },
        { x: CENTRE.x + 10, y: CENTRE.y + 30 },
      ],
    )
    await press(i18n.t('adjustPhoto.use'))
    expect(used().crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  test('a finger lifting mid pinch carries on as a drag from where the photo is', async () => {
    await render()
    const left = { x: CENTRE.x - 50, y: CENTRE.y }
    const right = { x: CENTRE.x + 50, y: CENTRE.y }
    await gesture(
      [left, right],
      [
        { x: CENTRE.x - 100, y: CENTRE.y },
        { x: CENTRE.x + 100, y: CENTRE.y },
      ],
      [{ x: CENTRE.x + 100, y: CENTRE.y }],
      [{ x: CENTRE.x + 100, y: CENTRE.y }],
    )
    await press(i18n.t('adjustPhoto.use'))
    near(used().crop, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })
})
