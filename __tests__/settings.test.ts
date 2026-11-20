import RNFS from 'react-native-fs'
import {
  loadNetwork,
  saveNetwork,
  validateExplorerUrl,
  loadTxExplorers,
  addTxExplorer,
  removeTxExplorer,
  selectTxExplorer,
  allTxExplorers,
  resolveTxExplorerUrl,
  TX_EXPLORER_PRESETS,
  DEFAULT_TX_EXPLORER_ID,
  loadDollarMode,
  saveDollarMode,
  loadDollarInviteSeen,
  saveDollarInviteSeen,
  forgetDollarInviteSeen,
  loadDirectionRestart,
  saveDirectionRestart,
  clearDirectionRestart,
  loadDisplayLanguage,
  saveDisplayLanguage,
  loadDismissedUpdate,
  saveDismissedUpdate,
  loadHeroUnit,
  saveHeroUnit,
} from '../src/wallet/settings'

const FILE = `${RNFS.DocumentDirectoryPath}/settings.json`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

describe('dollar mode cache', () => {
  test('is off for a wallet that never enabled it', async () => {
    expect(await loadDollarMode('w1')).toBe(false)
  })

  test('is remembered per wallet, so a switch does not inherit the other wallet accent', async () => {
    // A single shared flag would keep the previous wallet's green accent up after switching, until
    // the SDK finishes reconnecting.
    await saveDollarMode('w1', true)
    await saveDollarMode('w2', false)

    expect(await loadDollarMode('w1')).toBe(true)
    expect(await loadDollarMode('w2')).toBe(false)
  })

  test('saving one wallet leaves the others untouched', async () => {
    await saveDollarMode('w1', true)
    await saveDollarMode('w2', true)
    await saveDollarMode('w2', false)

    expect(await loadDollarMode('w1')).toBe(true)
  })
})

describe('network', () => {
  test('defaults to mainnet before anything is saved', async () => {
    expect(await loadNetwork()).toBe('mainnet')
  })

  test('persists and reloads the chosen network', async () => {
    await saveNetwork('testnet')
    expect(await loadNetwork()).toBe('testnet')
  })
})

describe('validateExplorerUrl', () => {
  test('accepts an http(s) site address, including a LAN one', () => {
    expect(validateExplorerUrl('https://mempool.space')).toBe(true)
    expect(validateExplorerUrl('http://mempool.local:3006')).toBe(true)
    expect(validateExplorerUrl('https://node.example.com/mempool')).toBe(true)
    expect(validateExplorerUrl('  https://mempool.space  ')).toBe(true)
  })

  test('plain http on a private network is valid: not everyone exposes their node', () => {
    // An explorer behind a VPN or on the LAN has no certificate and no public name, so
    // demanding https would lock out the self-hosting user this exists for.
    expect(validateExplorerUrl('http://100.101.102.103:3006')).toBe(true)
    expect(validateExplorerUrl('http://mempool.vpn.internal:3006')).toBe(true)
    expect(validateExplorerUrl('http://192.168.1.50:3002')).toBe(true)
    expect(validateExplorerUrl('http://localhost:3006')).toBe(true)
  })

  test('rejects anything that is not http(s): the value reaches Linking.openURL', () => {
    expect(validateExplorerUrl('mempool.space')).toBe(false)
    expect(validateExplorerUrl('')).toBe(false)
    // eslint-disable-next-line no-script-url -- the point of the assert is that this is rejected
    expect(validateExplorerUrl('javascript:alert(1)')).toBe(false)
    expect(validateExplorerUrl('file:///etc/passwd')).toBe(false)
    expect(validateExplorerUrl('https://')).toBe(false)
    expect(validateExplorerUrl('https:// space.com')).toBe(false)
  })
})

describe('transaction explorer', () => {
  test('starts on the default preset, with nothing custom stored', async () => {
    const config = await loadTxExplorers()
    expect(config).toEqual({ custom: [], selectedId: DEFAULT_TX_EXPLORER_ID })
    expect(resolveTxExplorerUrl(config)).toBe(TX_EXPLORER_PRESETS[0].url)
  })

  test('the picker lists the shipped entries plus the user\'s', async () => {
    const config = await addTxExplorer('https://node.example.com/mempool')
    const all = allTxExplorers(config)
    expect(all).toHaveLength(TX_EXPLORER_PRESETS.length + 1)
    expect(all[all.length - 1].url).toBe('https://node.example.com/mempool')
  })

  test('adding a self-hosted explorer selects it and resolves to its address', async () => {
    const config = await addTxExplorer('http://mempool.local:3006')
    expect(resolveTxExplorerUrl(config)).toBe('http://mempool.local:3006')
    expect(resolveTxExplorerUrl(await loadTxExplorers())).toBe('http://mempool.local:3006')
  })

  test('a trailing slash is normalized away, so the tx path never doubles up', async () => {
    const config = await addTxExplorer('https://node.example.com/mempool/')
    expect(resolveTxExplorerUrl(config)).toBe('https://node.example.com/mempool')
  })

  test('adding an address already on the list selects it instead of duplicating', async () => {
    await addTxExplorer('https://dup.example')
    const config = await addTxExplorer('https://dup.example')
    expect(config.custom).toHaveLength(1)
  })

  test('typing a preset address by hand selects the shipped entry, not a copy of it', async () => {
    const config = await addTxExplorer(TX_EXPLORER_PRESETS[0].url)
    expect(config.custom).toHaveLength(0)
    expect(config.selectedId).toBe(TX_EXPLORER_PRESETS[0].id)
  })

  test('switching back to a preset persists that choice', async () => {
    await addTxExplorer('https://node.example.com/mempool')
    const config = await selectTxExplorer(TX_EXPLORER_PRESETS[1].id)
    expect(config.selectedId).toBe(TX_EXPLORER_PRESETS[1].id)
    expect(resolveTxExplorerUrl(config)).toBe(TX_EXPLORER_PRESETS[1].url)
  })

  test('removing the selected explorer falls back to the default preset', async () => {
    const added = await addTxExplorer('https://gone.example')
    const after = await removeTxExplorer(added.custom[0].id)
    expect(after.custom).toHaveLength(0)
    expect(after.selectedId).toBe(DEFAULT_TX_EXPLORER_ID)
    expect(resolveTxExplorerUrl(after)).toBe(TX_EXPLORER_PRESETS[0].url)
  })

  test('selecting an unknown id falls back to the default instead of persisting it', async () => {
    const config = await selectTxExplorer('nope')
    expect(config.selectedId).toBe(DEFAULT_TX_EXPLORER_ID)
  })

  test('a stored selection pointing at something gone still resolves to a real explorer', () => {
    // A custom explorer removed on another device leaves a dangling id behind.
    expect(resolveTxExplorerUrl({ custom: [], selectedId: 'vanished' })).toBe(TX_EXPLORER_PRESETS[0].url)
  })
})

describe('direction restart marker', () => {
  test('is absent until written, then reads back, and clearing leaves the other settings alone', async () => {
    await saveDisplayLanguage('ar')
    expect(await loadDirectionRestart()).toBeNull()

    await saveDirectionRestart('rtl')
    expect(await loadDirectionRestart()).toBe('rtl')

    await clearDirectionRestart()
    expect(await loadDirectionRestart()).toBeNull()
    expect(await loadDisplayLanguage()).toBe('ar')
  })
})

test('the invitation value is kept per wallet and forgotten with the wallet', async () => {
  await saveDollarInviteSeen('w1', 2_000_000)
  await saveDollarInviteSeen('w2', 5)

  expect(await loadDollarInviteSeen('w1')).toBe(2_000_000)
  expect(await loadDollarInviteSeen('w3')).toBe(0)

  await forgetDollarInviteSeen('w1')

  expect(await loadDollarInviteSeen('w1')).toBe(0)
  expect(await loadDollarInviteSeen('w2')).toBe(5)
})

describe('dismissed update', () => {
  test('nothing dismissed reads as nothing', async () => {
    expect(await loadDismissedUpdate()).toBeNull()
  })

  test('holds the last version dismissed', async () => {
    await saveDismissedUpdate('1.2.0')
    await saveDismissedUpdate('1.3.0')
    expect(await loadDismissedUpdate()).toBe('1.3.0')
  })

  test('leaves the other settings as they were', async () => {
    await saveDollarMode('w1', true)
    await saveDismissedUpdate('1.2.0')
    expect(await loadDollarMode('w1')).toBe(true)
  })
})

// A tap and a save in the background can change the file at once, and each change merges onto the
// other's write rather than starting from the same file.
describe('changes made at the same time', () => {
  test('two wallets saved at once both keep their dollar mode', async () => {
    await Promise.all([saveDollarMode('w1', true), saveDollarMode('w2', true)])

    expect(await loadDollarMode('w1')).toBe(true)
    expect(await loadDollarMode('w2')).toBe(true)
  })

  test('two settings saved at once are both kept', async () => {
    await Promise.all([saveHeroUnit('sats'), saveDismissedUpdate('1.2.0')])

    expect(await loadHeroUnit()).toBe('sats')
    expect(await loadDismissedUpdate()).toBe('1.2.0')
  })

  test('two explorers added at once are both listed', async () => {
    const urls = ['https://a.example', 'https://b.example']
    await Promise.all(urls.map(addTxExplorer))

    expect((await loadTxExplorers()).custom.map(e => e.url).sort()).toEqual(urls)
  })

  test('forgetting one wallet while saving another keeps the save', async () => {
    await saveDollarInviteSeen('w1', 7)
    await Promise.all([forgetDollarInviteSeen('w1'), saveDollarInviteSeen('w2', 9)])

    expect(await loadDollarInviteSeen('w1')).toBe(0)
    expect(await loadDollarInviteSeen('w2')).toBe(9)
  })
})

describe('the file on disk', () => {
  // Every preference has a default, so a torn file costs the choices made, never the app.
  test('a torn file reads as nothing set, and the next save replaces it', async () => {
    await RNFS.writeFile(FILE, '{"dollarMode', 'utf8')

    expect(await loadDollarMode('w1')).toBe(false)
    expect(await loadNetwork()).toBe('mainnet')
    await saveDismissedUpdate('1.2.0')
    expect(await loadDismissedUpdate()).toBe('1.2.0')
  })

  test('a write cut after its copy finished is read from the copy', async () => {
    await RNFS.writeFile(`${FILE}.tmp`, JSON.stringify({ dismissedUpdate: '1.2.0' }), 'utf8')

    expect(await loadDismissedUpdate()).toBe('1.2.0')
  })

  test('forgetting a wallet with no entry writes no file', async () => {
    await forgetDollarInviteSeen('w1')

    expect(await RNFS.exists(FILE)).toBe(false)
  })
})
