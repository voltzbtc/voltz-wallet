import { Camera } from 'react-native-vision-camera'
import { launchCamera, launchImageLibrary } from 'react-native-image-picker'
import { pickWalletImage, takeWalletPhoto } from '../src/wallet/walletImage'

// A wallet photo never asks for the photo library: the system pickers need no permission, and iOS asks
// for one only when the picker is told to include extra data. CAMERA is asked for Take photo alone,
// before the camera opens, and a refusal opens nothing.

jest.mock('react-native-image-picker', () => ({ launchImageLibrary: jest.fn(), launchCamera: jest.fn() }))
jest.mock('react-native-vision-camera', () => ({
  Camera: { getCameraPermissionStatus: jest.fn(), requestCameraPermission: jest.fn() },
}))

const status = jest.mocked(Camera.getCameraPermissionStatus)
const request = jest.mocked(Camera.requestCameraPermission)
const camera = jest.mocked(launchCamera)
const library = jest.mocked(launchImageLibrary)

const PHOTO = { assets: [{ uri: 'file:///cache/rn_image_picker_lib_temp_1.jpg', width: 1024, height: 768 }] }

beforeEach(() => {
  jest.clearAllMocks()
  status.mockReturnValue('not-determined')
  request.mockResolvedValue('granted')
  camera.mockResolvedValue(PHOTO as never)
  library.mockResolvedValue(PHOTO as never)
})

describe('Choose photo', () => {
  test('hands back the photo with the size the picker reported', async () => {
    expect(await pickWalletImage()).toEqual({
      kind: 'image',
      uri: 'file:///cache/rn_image_picker_lib_temp_1.jpg',
      width: 1024,
      height: 768,
    })
  })

  test('asks for no permission, and asks the picker for nothing that needs one', async () => {
    await pickWalletImage()
    expect(status).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(camera).not.toHaveBeenCalled()
    const options = library.mock.calls[0][0]
    expect(options).toMatchObject({ mediaType: 'photo', selectionLimit: 1, maxWidth: 1024, maxHeight: 1024 })
    expect(options).not.toHaveProperty('includeExtra')
  })

  test('cancelled is its own answer', async () => {
    library.mockResolvedValueOnce({ didCancel: true } as never)
    expect(await pickWalletImage()).toEqual({ kind: 'cancelled' })
  })

  // The library asks for no permission, so the settings line a camera refusal shows would point at
  // nothing the person can allow.
  test('a permission error from the library is a failure, not a refusal', async () => {
    library.mockResolvedValueOnce({ errorCode: 'permission' } as never)
    expect(await pickWalletImage()).toEqual({ kind: 'failed' })
  })

  test('a picker that fails, answers with no photo or throws is a failure', async () => {
    library.mockResolvedValueOnce({ errorCode: 'others', errorMessage: 'x' } as never)
    expect(await pickWalletImage()).toEqual({ kind: 'failed' })
    library.mockResolvedValueOnce({ assets: [] } as never)
    expect(await pickWalletImage()).toEqual({ kind: 'failed' })
    library.mockRejectedValueOnce(new Error('no native module'))
    expect(await pickWalletImage()).toEqual({ kind: 'failed' })
  })
})

describe('Take photo', () => {
  test('granted already, opens the camera without asking', async () => {
    status.mockReturnValue('granted')
    expect(await takeWalletPhoto()).toMatchObject({ kind: 'image', width: 1024, height: 768 })
    expect(request).not.toHaveBeenCalled()
    const options = camera.mock.calls[0][0]
    expect(options).toMatchObject({ mediaType: 'photo', maxWidth: 1024, maxHeight: 1024, saveToPhotos: false })
    expect(options).not.toHaveProperty('includeExtra')
  })

  test('asks CAMERA first, and opens the camera once it is granted', async () => {
    expect(await takeWalletPhoto()).toMatchObject({ kind: 'image' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(camera.mock.invocationCallOrder[0])
    expect(library).not.toHaveBeenCalled()
  })

  test.each(['not-determined', 'denied', 'restricted'] as const)(
    'refused from %s, opens nothing and says so',
    async from => {
      status.mockReturnValue(from)
      request.mockResolvedValue('denied')
      expect(await takeWalletPhoto()).toEqual({ kind: 'denied' })
      expect(camera).not.toHaveBeenCalled()
      expect(library).not.toHaveBeenCalled()
    },
  )

  test('cancelled is its own answer', async () => {
    camera.mockResolvedValueOnce({ didCancel: true } as never)
    expect(await takeWalletPhoto()).toEqual({ kind: 'cancelled' })
  })

  test('a device with no camera, as the iOS simulator answers, is told apart', async () => {
    camera.mockResolvedValueOnce({ errorCode: 'camera_unavailable' } as never)
    expect(await takeWalletPhoto()).toEqual({ kind: 'unavailable' })
  })

  test('a permission the picker itself was refused reads as refused', async () => {
    camera.mockResolvedValueOnce({ errorCode: 'permission' } as never)
    expect(await takeWalletPhoto()).toEqual({ kind: 'denied' })
  })

  test('a camera that fails or a permission check that throws is a failure', async () => {
    camera.mockResolvedValueOnce({ errorCode: 'others' } as never)
    expect(await takeWalletPhoto()).toEqual({ kind: 'failed' })
    request.mockRejectedValueOnce(new Error('no native module'))
    expect(await takeWalletPhoto()).toEqual({ kind: 'failed' })
  })
})
