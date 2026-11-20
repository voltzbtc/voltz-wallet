import { savedWalletName, walletEditChanged, type WalletEditState } from '../src/wallet/walletEdit'

const DEFAULT = 'Wallet'
const read: WalletEditState = { name: 'Daily', color: null, imagePath: null, imageCrop: null }
const changed = (now: Partial<WalletEditState>, from: WalletEditState = read) =>
  walletEditChanged(from, { ...from, ...now }, DEFAULT)

describe('the name as a save writes it', () => {
  test('is trimmed', () => {
    expect(savedWalletName('  Daily  ', DEFAULT)).toBe('Daily')
  })

  test('is no name of its own for the default name and for an empty field', () => {
    expect(savedWalletName(DEFAULT, DEFAULT)).toBe('')
    expect(savedWalletName(` ${DEFAULT} `, DEFAULT)).toBe('')
    expect(savedWalletName('', DEFAULT)).toBe('')
    expect(savedWalletName('   ', DEFAULT)).toBe('')
  })

  test('keeps a name that only starts like the default one', () => {
    expect(savedWalletName(`${DEFAULT} 2`, DEFAULT)).toBe(`${DEFAULT} 2`)
  })
})

describe('a change', () => {
  test('is nothing when the screen holds what was read', () => {
    expect(changed({})).toBe(false)
  })

  test('is a name that saves differently, and not one that only gains spaces', () => {
    expect(changed({ name: 'Savings' })).toBe(true)
    expect(changed({ name: 'Daily ' })).toBe(false)
    expect(changed({ name: '' })).toBe(true)
  })

  test('is not emptying a field that showed the default name', () => {
    const unnamed = { ...read, name: DEFAULT }
    expect(changed({ name: '' }, unnamed)).toBe(false)
    expect(changed({ name: 'Savings' }, unnamed)).toBe(true)
  })

  test('is a colour chosen, changed or taken back to none', () => {
    expect(changed({ color: '#FF7A00' })).toBe(true)
    const coloured = { ...read, color: '#FF7A00' }
    expect(changed({ color: '#E5484D' }, coloured)).toBe(true)
    expect(changed({ color: null }, coloured)).toBe(true)
    expect(changed({ color: '#FF7A00' }, coloured)).toBe(false)
  })

  test('is a photo picked, replaced or removed', () => {
    expect(changed({ imagePath: 'file:///picked.jpg' })).toBe(true)
    const withPhoto = { ...read, imagePath: '/avatars/a.jpg' }
    expect(changed({ imagePath: 'file:///picked.jpg' }, withPhoto)).toBe(true)
    expect(changed({ imagePath: null }, withPhoto)).toBe(true)
    expect(changed({ imagePath: '/avatars/a.jpg' }, withPhoto)).toBe(false)
  })

  // Every save without a photo writes the path empty, so a read of '' is a wallet with no photo.
  test('is not a photo taken off a wallet whose read path was empty', () => {
    const savedEmpty = { ...read, imagePath: '' }
    expect(changed({ imagePath: null }, savedEmpty)).toBe(false)
    expect(changed({ imagePath: '' })).toBe(false)
    expect(changed({ imagePath: '  ' }, savedEmpty)).toBe(false)
    expect(changed({ imagePath: 'file:///picked.jpg' }, savedEmpty)).toBe(true)
  })

  test('is the square of the photo moved, and not the same square read again', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 }
    const cropped = { ...read, imagePath: '/avatars/a.jpg', imageCrop: crop }
    expect(changed({ imageCrop: { ...crop, x: 0 } }, cropped)).toBe(true)
    expect(changed({ imageCrop: null }, cropped)).toBe(true)
    expect(changed({ imageCrop: { ...crop } }, cropped)).toBe(false)
    expect(changed({ imageCrop: crop }, { ...cropped, imageCrop: null })).toBe(true)
  })
})
