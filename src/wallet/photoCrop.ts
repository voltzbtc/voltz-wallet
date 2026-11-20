// A wallet photo's crop: a square of the source image, square in its pixels, given as fractions of
// the image's width and height so that it holds for the photo at any size it is drawn.
export type PhotoCrop = { x: number; y: number; w: number; h: number }

// The photo under the adjust circle: its zoom, and its centre's offset from the circle's centre,
// counted in circle diameters so the same view holds at any circle size.
export type CropView = { zoom: number; x: number; y: number }

export type Point = { x: number; y: number }

// Zoom 1 is the photo just covering the circle, its shorter side across it.
export const MIN_ZOOM = 1
export const MAX_ZOOM = 3

export const CENTRED: CropView = { zoom: MIN_ZOOM, x: 0, y: 0 }

// A crop that ends on the image's edge can sum a hair above 1 in floating point.
const EDGE = 1e-9

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const fraction = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

// Whether the picker's figures describe an image the circle can be laid over.
export function usablePhotoSize(width: unknown, height: unknown): boolean {
  return [width, height].every(side => typeof side === 'number' && Number.isFinite(side) && side > 0)
}

// The crop as stored, or null for anything that is not one, which then draws the photo centred.
export function readCrop(value: unknown): PhotoCrop | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { x, y, w, h } = value as Record<string, unknown>
  if (!fraction(x) || !fraction(y) || !fraction(w) || !fraction(h)) {
    return null
  }
  if (w === 0 || h === 0 || x + w > 1 + EDGE || y + h > 1 + EDGE) {
    return null
  }
  return { x, y, w, h }
}

export function sameCrop(a: PhotoCrop | null, b: PhotoCrop | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

// The photo's size at zoom 1, in circle diameters.
export function coverSize(width: number, height: number): { width: number; height: number } {
  const short = Math.min(width, height)
  return { width: width / short, height: height / short }
}

// The nearest view that leaves no gap inside the circle: zoom within its bounds, and the photo's
// edges at or past the circle's on every side.
export function clampView(view: CropView, width: number, height: number): CropView {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM)
  const size = coverSize(width, height)
  const roomX = (size.width * zoom - 1) / 2
  const roomY = (size.height * zoom - 1) / 2
  return {
    zoom,
    x: clamp(Number.isFinite(view.x) ? view.x : 0, -roomX, roomX),
    y: clamp(Number.isFinite(view.y) ? view.y : 0, -roomY, roomY),
  }
}

// A drag, or a pinch scaled by `factor`. `from` and `to` are the fingers' midpoint when the gesture
// began and now, in diameters from the circle's centre. The point of the photo under the fingers
// stays under them, so a pinch zooms around where it happens rather than around the photo's centre.
export function moveView(
  start: CropView,
  from: Point,
  to: Point,
  factor: number,
  width: number,
  height: number,
): CropView {
  const zoom = clamp(start.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1), MIN_ZOOM, MAX_ZOOM)
  const ratio = zoom / start.zoom
  return clampView(
    { zoom, x: to.x - (from.x - start.x) * ratio, y: to.y - (from.y - start.y) * ratio },
    width,
    height,
  )
}

// The square of the source the circle shows in this view.
export function cropRect(view: CropView, width: number, height: number): PhotoCrop {
  const { zoom, x, y } = clampView(view, width, height)
  // How many source pixels one circle diameter spans.
  const side = Math.min(width, height) / zoom
  const w = Math.min(1, side / width)
  const h = Math.min(1, side / height)
  const left = (width / 2 - x * side - side / 2) / width
  const top = (height / 2 - y * side - side / 2) / height
  return { x: clamp(left, 0, 1 - w), y: clamp(top, 0, 1 - h), w, h }
}

// How a disc of `size` draws the crop: the whole photo at the scale that makes the crop span the
// disc, centred, then moved so the crop's corner meets the disc's. The move is a transform rather
// than a left offset, which a right-to-left layout would mirror.
export function cropFrame(
  crop: PhotoCrop,
  size: number,
): { width: number; height: number; left: number; top: number; translateX: number; translateY: number } {
  const width = size / crop.w
  const height = size / crop.h
  const left = (size - width) / 2
  const top = (size - height) / 2
  return { width, height, left, top, translateX: -crop.x * width - left, translateY: -crop.y * height - top }
}
