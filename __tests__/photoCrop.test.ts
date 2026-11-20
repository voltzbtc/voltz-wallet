import {
  CENTRED,
  MAX_ZOOM,
  clampView,
  coverSize,
  cropFrame,
  cropRect,
  moveView,
  readCrop,
  sameCrop,
  usablePhotoSize,
  type CropView,
} from '../src/wallet/photoCrop'

const near = (actual: Record<string, number>, expected: Record<string, number>): void => {
  for (const key of Object.keys(expected)) {
    expect(actual[key]).toBeCloseTo(expected[key], 9)
  }
}

describe('coverSize', () => {
  test('puts the shorter side across the circle', () => {
    expect(coverSize(1000, 1000)).toEqual({ width: 1, height: 1 })
    expect(coverSize(2000, 1000)).toEqual({ width: 2, height: 1 })
    expect(coverSize(768, 1024)).toEqual({ width: 1, height: 1024 / 768 })
  })
})

describe('cropRect', () => {
  test('a square photo, centred, is the whole photo', () => {
    near(cropRect(CENTRED, 1000, 1000), { x: 0, y: 0, w: 1, h: 1 })
  })

  test('a landscape photo, centred, is its middle square', () => {
    near(cropRect(CENTRED, 2000, 1000), { x: 0.25, y: 0, w: 0.5, h: 1 })
  })

  test('a portrait photo, centred, is its middle square', () => {
    near(cropRect(CENTRED, 1000, 2000), { x: 0, y: 0.25, w: 1, h: 0.5 })
  })

  test('is square in the source pixels whatever the shape', () => {
    for (const [width, height] of [
      [1024, 768],
      [768, 1024],
      [1000, 1000],
      [4000, 300],
    ]) {
      const crop = cropRect({ zoom: 1.7, x: 0.05, y: -0.05 }, width, height)
      expect(crop.w * width).toBeCloseTo(crop.h * height, 6)
    }
  })

  test('at the largest zoom spans a third of the shorter side', () => {
    near(cropRect({ zoom: MAX_ZOOM, x: 0, y: 0 }, 1000, 1000), { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 })
  })

  test('past the largest zoom is held at it', () => {
    near(cropRect({ zoom: 10, x: 0, y: 0 }, 1000, 1000), { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 })
  })

  test('a photo dragged past its edge stops at the edge, on every side', () => {
    near(cropRect({ zoom: 1, x: 10, y: 0 }, 2000, 1000), { x: 0, y: 0, w: 0.5, h: 1 })
    near(cropRect({ zoom: 1, x: -10, y: 0 }, 2000, 1000), { x: 0.5, y: 0, w: 0.5, h: 1 })
    near(cropRect({ zoom: 1, x: 0, y: 10 }, 1000, 2000), { x: 0, y: 0, w: 1, h: 0.5 })
    near(cropRect({ zoom: 1, x: 0, y: -10 }, 1000, 2000), { x: 0, y: 0.5, w: 1, h: 0.5 })
  })

  test('whatever the view, the crop is one readCrop accepts', () => {
    const views: CropView[] = [
      { zoom: 3, x: 5, y: -5 },
      { zoom: 0.2, x: -1, y: 1 },
      { zoom: Number.NaN, x: Number.NaN, y: Number.POSITIVE_INFINITY },
      { zoom: 2.5, x: 0.3333333, y: -0.777777 },
    ]
    for (const view of views) {
      for (const [width, height] of [
        [1024, 683],
        [683, 1024],
        [999, 999],
      ]) {
        expect(readCrop(cropRect(view, width, height))).not.toBeNull()
      }
    }
  })
})

describe('clampView', () => {
  test('a pinch out below zoom 1 comes back to cover the circle', () => {
    expect(clampView({ zoom: 0.4, x: 0.3, y: 0 }, 1000, 1000)).toEqual({ zoom: 1, x: 0, y: 0 })
  })

  test('leaves the photo room to move along its longer side only', () => {
    expect(clampView({ zoom: 1, x: 0.9, y: 0.9 }, 2000, 1000)).toEqual({ zoom: 1, x: 0.5, y: 0 })
  })

  test('takes a view that is not numbers as the centred one', () => {
    expect(clampView({ zoom: Number.NaN, x: Number.NaN, y: Number.NaN }, 1000, 1000)).toEqual(CENTRED)
  })
})

describe('moveView', () => {
  test('a drag moves the photo by the distance the finger went', () => {
    const view = moveView({ zoom: 2, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0.2, y: -0.1 }, 1, 1000, 1000)
    near(view, { zoom: 2, x: 0.2, y: -0.1 })
  })

  test('a pinch keeps the point under the fingers under them', () => {
    const focal = { x: 0.25, y: 0 }
    const view = moveView(CENTRED, focal, focal, 2, 1000, 1000)
    near(view, { zoom: 2, x: -0.25, y: 0 })
    // The fingers sat over the source's x 0.75 at zoom 1, a quarter diameter right of the centre, and
    // a quarter diameter right of the centre at zoom 2 is that same point.
    const crop = cropRect(view, 1000, 1000)
    expect(crop.x + crop.w / 2 + 0.25 * crop.w).toBeCloseTo(0.75, 9)
  })

  test('a pinch past the largest zoom stops zooming', () => {
    expect(moveView(CENTRED, { x: 0, y: 0 }, { x: 0, y: 0 }, 9, 1000, 1000).zoom).toBe(MAX_ZOOM)
  })

  test('a pinch in below zoom 1 stays covering the circle', () => {
    expect(moveView({ zoom: 1.5, x: 0.2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.1, 1000, 1000)).toEqual(CENTRED)
  })

  test('a factor that is not a number moves without zooming', () => {
    near(moveView({ zoom: 2, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0.1, y: 0 }, Number.NaN, 1000, 1000), {
      zoom: 2,
      x: 0.1,
      y: 0,
    })
  })
})

describe('readCrop', () => {
  test('takes a crop inside the image', () => {
    expect(readCrop({ x: 0.25, y: 0, w: 0.5, h: 1 })).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 })
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  test('takes a crop ending on the edge by a floating point hair', () => {
    expect(readCrop({ x: 0.7, y: 0, w: 0.30000000000000004, h: 1 })).not.toBeNull()
  })

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'x'],
    ['a number', 1],
    ['an array', [0, 0, 1, 1]],
    ['a field missing', { x: 0, y: 0, w: 1 }],
    ['a field as text', { x: '0', y: 0, w: 1, h: 1 }],
    ['a field not a number', { x: Number.NaN, y: 0, w: 1, h: 1 }],
    ['a field infinite', { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 }],
    ['a field below 0', { x: -0.1, y: 0, w: 0.5, h: 0.5 }],
    ['a field above 1', { x: 0, y: 0, w: 1.5, h: 1 }],
    ['a zero width', { x: 0, y: 0, w: 0, h: 1 }],
    ['a zero height', { x: 0, y: 0, w: 1, h: 0 }],
    ['x and w past the edge', { x: 0.6, y: 0, w: 0.5, h: 1 }],
    ['y and h past the edge', { x: 0, y: 0.6, w: 1, h: 0.5 }],
  ])('refuses %s', (_name, value) => {
    expect(readCrop(value)).toBeNull()
  })

  test('drops what else the stored object carries', () => {
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1, extra: 'x' })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('sameCrop', () => {
  test('compares by value, and no crop only equals no crop', () => {
    expect(sameCrop({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(sameCrop({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0.1, w: 1, h: 1 })).toBe(false)
    expect(sameCrop(null, null)).toBe(true)
    expect(sameCrop(null, { x: 0, y: 0, w: 1, h: 1 })).toBe(false)
    expect(sameCrop({ x: 0, y: 0, w: 1, h: 1 }, null)).toBe(false)
  })
})

describe('usablePhotoSize', () => {
  test('needs two positive finite sides', () => {
    expect(usablePhotoSize(1024, 768)).toBe(true)
    expect(usablePhotoSize(0, 768)).toBe(false)
    expect(usablePhotoSize(1024, undefined)).toBe(false)
    expect(usablePhotoSize(-1, 768)).toBe(false)
    expect(usablePhotoSize(Number.NaN, 768)).toBe(false)
  })
})

describe('cropFrame', () => {
  test('draws the crop across the disc', () => {
    near(cropFrame({ x: 0.25, y: 0, w: 0.5, h: 1 }, 100), {
      width: 200,
      height: 100,
      left: -50,
      top: 0,
      translateX: 0,
      translateY: 0,
    })
  })

  test('puts the photo where the adjust circle showed it, at any size', () => {
    const [width, height] = [2000, 1000]
    const view = clampView({ zoom: 1.5, x: 0.1, y: -0.2 }, width, height)
    for (const size of [44, 96, 300]) {
      const frame = cropFrame(cropRect(view, width, height), size)
      const drawn = coverSize(width, height)
      // Under the adjust circle the photo is drawn at its cover size times the zoom, centred on the
      // circle's centre plus the view's offset.
      expect(frame.width).toBeCloseTo(drawn.width * view.zoom * size, 6)
      expect(frame.height).toBeCloseTo(drawn.height * view.zoom * size, 6)
      expect(frame.left + frame.translateX).toBeCloseTo(size / 2 + view.x * size - frame.width / 2, 6)
      expect(frame.top + frame.translateY).toBeCloseTo(size / 2 + view.y * size - frame.height / 2, 6)
    }
  })
})
