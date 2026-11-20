// Native module, absent in Jest. Defaults to "no NFC" so screens hide the chip; NFC tests override
// per case.
export const NfcTech = { Ndef: 'Ndef' as const }

export const Ndef = {
  TNF_WELL_KNOWN: 0x01,
  RTD_TEXT: 'T',
  RTD_URI: 'U',
  isType: jest.fn(() => false),
  uri: { decodePayload: jest.fn(() => '') },
  text: { decodePayload: jest.fn(() => '') },
}

export type NdefRecord = { tnf: number; type: number[]; payload: number[] }

// What the library rejects with when the iOS reading sheet is cancelled. Its own class, with no
// message, as the real one is.
class UserCancel extends Error {}
export const NfcError = { UserCancel }

const NfcManager = {
  start: jest.fn(async () => {}),
  isSupported: jest.fn(async () => false),
  isEnabled: jest.fn(async () => false),
  requestTechnology: jest.fn(async () => 'Ndef'),
  getTag: jest.fn(async () => null),
  cancelTechnologyRequest: jest.fn(async () => {}),
  goToNfcSetting: jest.fn(async () => true),
}

export default NfcManager
