import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import { TransactionDetailSheet } from '../src/components/TransactionDetailSheet'
import { Row } from '../src/components/Row'
import { FigureRow } from '../src/components/FigureRow'
import { GradientButton } from '../src/components/GradientButton'
import { Touch } from '../src/components/Touch'
import { Txt } from '../src/components/Txt'
import type { HistoryItem } from '../src/wallet/payment'
import { formatSats } from '../src/wallet/amount'
import * as settings from '../src/wallet/settings'
import { colors } from '../src/theme'

async function render(item: HistoryItem): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<TransactionDetailSheet item={item} onClose={() => undefined} />)
  })
  return tree
}

function shown(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ')
}

const FOLD = 'Technical details'
const foldLine = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Touch).find(n => n.findAllByType(Text).some(t => t.props.children === FOLD))
async function openDetails(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => foldLine(tree)!.props.onPress())
}

// A USDT receive lands as USDB on Spark, and without its origin the history cannot say where it came from.
const RECEIVED: HistoryItem = {
  id: 'r1',
  direction: 'received',
  status: 'complete',
  amountSat: 49_990_000,
  feesSat: 0,
  timestamp: 1_700_000_300,
  method: 'spark',
  asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '49.99' },
  crossChain: { chain: 'tron', asset: 'USDT', amountIn: '50.21', txHash: 'tronhash1234567890abcdef' },
}

test('a cross-chain receive names its source and copies the funding transaction', async () => {
  const tree = await render(RECEIVED)

  expect(shown(tree)).toContain('USDT on Tron')
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === 'Transaction on Tron'))
  expect(row).toBeDefined()
  await ReactTestRenderer.act(async () => {
    row?.props.onPress()
  })
  expect(Clipboard.setString).toHaveBeenLastCalledWith('tronhash1234567890abcdef')
})

test('says Copied to a screen reader, which cannot see the value turn into it', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
  const tree = await render(RECEIVED)
  await ReactTestRenderer.act(async () => tree.root.findAllByType(Touch)[0]!.props.onPress())
  expect(announce).toHaveBeenCalledWith(i18n.t('history.detail.copied'))
  announce.mockRestore()
})

test('an ordinary receive has no source rows', async () => {
  const tree = await render({ ...RECEIVED, crossChain: undefined })
  expect(shown(tree)).not.toContain('Transaction on')
  expect(shown(tree)).not.toContain('From')
})

// A conversion moves value between the wallet's own assets, so its amount carries no sign, as in the
// list, where a minus would read as value that left the wallet.
describe('the sign on the amount', () => {
  const amountText = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const node = tree.root
      .findAllByType(Text)
      .find(n => [n.props.children].flat().some((c: unknown) => typeof c === 'string' && c.includes('USDB')))!
    return [node.props.children].flat().filter((c: unknown) => typeof c === 'string').join('')
  }
  const PLAIN = { ...RECEIVED, crossChain: undefined, asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '0.74947' } }

  test('a conversion has none', async () => {
    expect(amountText(await render({ ...PLAIN, direction: 'converted' }))).toBe('0.74947 USDB')
  })

  // The minus sign rather than a hyphen, which is shorter than the plus and reads as a dash.
  test('a receive is plus and a send is minus', async () => {
    expect(amountText(await render({ ...PLAIN, direction: 'received' }))).toBe('+0.74947 USDB')
    expect(amountText(await render({ ...PLAIN, direction: 'sent' }))).toBe('\u22120.74947 USDB')
  })
})

// The sats line above each fee row on an ordinary payment is the payment's own fee, which on a
// conversion's leg is 0 while the conversion cost its AMM fee.
describe('a conversion', () => {
  const SATS = formatSats(31_473)
  const ROUND_TRIP: HistoryItem = {
    id: 'c1',
    direction: 'converted',
    status: 'complete',
    amountSat: 31_473,
    feesSat: 0,
    timestamp: 1_700_000_300,
    method: 'spark',
    asset: null,
    conversion: {
      status: 'complete',
      automatic: true,
      from: { ticker: 'USDB', amount: '25.388955', fee: '0.050956' },
      to: { ticker: null, amount: '31473' },
    },
  }
  const figuresOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(FigureRow)
      .map(row => [
        row.props.label,
        row.findAllByType(Text).slice(1).map(n => [n.props.children].flat().join('')).join(''),
      ])

  test('says what left, what arrived and the fee in the unit of the side that charged it', async () => {
    const rows = figuresOf(await render(ROUND_TRIP))

    expect(rows).toEqual(
      expect.arrayContaining([
        ['Left', '25.388955 USDB'],
        ['Arrived', `${SATS} sats`],
        ['Conversion fee', '0.050956 USDB'],
      ]),
    )
  })

  test('is titled by where it landed and says it was automatic', async () => {
    const tree = await render(ROUND_TRIP)

    expect(tree.root.findAllByType(Txt).find(n => n.props.role === 'section')?.props.children).toBe('Conversion to bitcoin')
    expect(figuresOf(tree)).toEqual(expect.arrayContaining([['Type', 'Automatic']]))
  })

  test('a conversion the wallet asked for does not say automatic', async () => {
    const tree = await render({ ...ROUND_TRIP, conversion: { ...ROUND_TRIP.conversion!, automatic: false } })

    expect(shown(tree)).not.toContain('Automatic')
  })

  // A fee the SDK did not give has no line, and above all no zero.
  test('with no fee from the SDK there is no fee line and no zero', async () => {
    const tree = await render({
      ...ROUND_TRIP,
      conversion: { status: 'complete', automatic: false, to: { ticker: null, amount: '31473' } },
    })
    const rows = figuresOf(tree)

    expect(rows.map(([label]) => label)).not.toContain('Fee')
    expect(rows.map(([label]) => label)).not.toContain('Conversion fee')
    expect(JSON.stringify(rows)).not.toContain('0 sats')
  })

  // A note holds the SDK's quote, so nothing from it may read as what the conversion charged.
  test('a quoted fee is labelled as quoted, and is not a conversion fee', async () => {
    const tree = await render({
      ...ROUND_TRIP,
      conversion: {
        status: 'complete',
        automatic: false,
        from: { ticker: 'USDB', amount: '25.388955', quoted: true },
        to: { ticker: null, amount: '31473' },
        quotedFee: { ticker: 'USDB', amount: '0.050956' },
      },
    })
    const rows = figuresOf(tree)

    expect(rows).toContainEqual(['Quoted fee', '0.050956 USDB'])
    expect(rows).toContainEqual(['Left (quoted)', '25.388955 USDB'])
    expect(rows.map(([label]) => label)).not.toContain('Conversion fee')
    expect(rows.map(([label]) => label)).not.toContain('Left')
    expect(rows.map(([label]) => label)).not.toContain('Fee')
  })

  test('with no note the detail draws no quoted line', async () => {
    const rows = figuresOf(await render(ROUND_TRIP))

    expect(rows.map(([label]) => label)).not.toContain('Quoted fee')
    expect(rows.map(([label]) => label)).not.toContain('Left (quoted)')
    expect(rows).toContainEqual(['Left', '25.388955 USDB'])
  })

  test('an amount the SDK did not give has no line', async () => {
    const rows = figuresOf(
      await render({
        ...ROUND_TRIP,
        conversion: { status: 'complete', automatic: false, from: { ticker: null }, to: { ticker: 'USDB', amount: '25' } },
      }),
    )

    expect(rows.map(([label]) => label)).not.toContain('Left')
  })

  test('a fee on each side keeps both', async () => {
    const rows = figuresOf(
      await render({
        ...ROUND_TRIP,
        conversion: {
          status: 'complete',
          automatic: false,
          from: { ticker: null, amount: '100', fee: '2' },
          to: { ticker: 'USDB', amount: '25', fee: '0.05' },
        },
      }),
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        ['Conversion fee', '2 sats'],
        ['Conversion fee', '0.05 USDB'],
      ]),
    )
  })

  test('the total line never adds a leg to its own fee', async () => {
    const tree = await render({ ...ROUND_TRIP, feesSat: 3 })

    expect(figuresOf(tree).map(([label]) => label)).not.toContain('Total')
  })

  test('while it is pending the pill says so and only the known side has a line', async () => {
    const tree = await render({
      ...ROUND_TRIP,
      status: 'pending',
      conversion: { status: 'complete', automatic: false, to: { ticker: null, amount: '31473' } },
    })

    expect(shown(tree)).toContain('Pending')
    expect(figuresOf(tree).map(([label]) => label)).not.toContain('Left')
  })

  test.each([
    ['refundPending', 'Refund in progress'],
    ['refunded', 'Refunded'],
    ['failed', 'Failed'],
  ] as const)('a sent leg at %s says where the value stands', async (status, text) => {
    const tree = await render({
      ...ROUND_TRIP,
      status: 'failed',
      asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '25.388955' },
      conversion: { status, automatic: false, from: { ticker: 'USDB', amount: '25.388955', fee: '0.05' } },
    })

    expect(shown(tree)).toContain(text)
    expect(shown(tree)).toContain('Conversion')
    expect(shown(tree)).not.toContain('Converted')
    expect(figuresOf(tree).map(([label]) => label)).not.toContain('Arrived')
  })

  // The pill speaks for the receive, so the conversion needs its own line, and the receive's fee stays.
  test.each([
    ['pending', 'Pending'],
    ['failed', 'Failed'],
    ['complete', 'Completed'],
  ] as const)('a real receive with a %s conversion keeps its own fee and says the conversion apart', async (status, text) => {
    const tree = await render({
      ...ROUND_TRIP,
      direction: 'received',
      amountSat: 1000,
      conversion: { status, automatic: false },
    })
    const rows = figuresOf(tree)

    expect(rows).toEqual(expect.arrayContaining([['Conversion', text]]))
    expect(rows).toEqual(expect.arrayContaining([['Fee', '0 sats']]))
    expect(tree.root.findAllByType(Txt).find(n => n.props.role === 'section')?.props.children).toBe('Received')
  })

  // The Lightning send it paid for never went through, so nothing arrived anywhere for the reader.
  test('a send it funded states no arrival until the send is through', async () => {
    const funded = (status: HistoryItem['status']): HistoryItem => ({
      ...ROUND_TRIP,
      direction: 'sent',
      status,
      method: 'lightning',
    })

    expect(figuresOf(await render(funded('failed'))).map(([label]) => label)).not.toContain('Arrived')
    expect(figuresOf(await render(funded('pending'))).map(([label]) => label)).not.toContain('Arrived')
    expect(figuresOf(await render(funded('complete')))).toContainEqual(['Arrived', `${SATS} sats`])
  })

  test.each(['failed', 'refundPending', 'refunded'] as const)('a %s conversion states no fee', async status => {
    const conversion = { status, automatic: true, from: { ticker: 'USDB', amount: '12', fee: '0.02' } }
    const tree = await render({ ...ROUND_TRIP, conversion })

    expect(figuresOf(tree).map(([label]) => label)).not.toContain(i18n.t('history.detail.conversionFee'))
  })

  test('a conversion that went through keeps its fee', async () => {
    const conversion = { status: 'complete' as const, automatic: true, from: { ticker: 'USDB', amount: '12', fee: '0.02' } }
    const tree = await render({ ...ROUND_TRIP, conversion })

    expect(figuresOf(tree).map(([label]) => label)).toContain(i18n.t('history.detail.conversionFee'))
  })

  // The sats stayed in the wallet, so the sheet says the conversion ended that way and that nothing swapped.
  test.each([
    ['refunded', 'Refunded'],
    ['refundPending', 'Refund in progress'],
    ['failed', 'Failed'],
  ] as const)('a real receive whose conversion ended %s stays Received and states no sides', async (status, text) => {
    const tree = await render({
      ...ROUND_TRIP,
      direction: 'received',
      amountSat: 5000,
      conversion: {
        status,
        automatic: false,
        from: { ticker: null, amount: '5000' },
        to: { ticker: 'USDB', amount: '4.9' },
      },
    })
    const rows = figuresOf(tree)

    expect(tree.root.findAllByType(Txt).find(n => n.props.role === 'section')?.props.children).toBe('Received')
    expect(shown(tree)).toContain('Completed')
    expect(rows).toEqual(expect.arrayContaining([['Conversion', text]]))
    expect(rows.map(([label]) => label)).not.toContain('Arrived')
    expect(rows.map(([label]) => label)).not.toContain('Left')
  })
})

describe('what the fee and total lines say', () => {
  const LN: HistoryItem = {
    id: 'ln1',
    direction: 'sent',
    status: 'complete',
    amountSat: 10_000,
    feesSat: 12,
    timestamp: 1_700_000_300,
    method: 'lightning',
    asset: null,
  }
  const labels = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(FigureRow).map(row => row.props.label)

  test('a settled Bitcoin send has both', async () => {
    expect(labels(await render(LN))).toEqual(expect.arrayContaining(['Fee', 'Total']))
  })

  test('a failed payment has neither, since it charged nothing', async () => {
    const shownLabels = labels(await render({ ...LN, status: 'failed' }))

    expect(shownLabels).not.toContain('Fee')
    expect(shownLabels).not.toContain('Total')
  })

  const TOKEN: HistoryItem = { ...LN, asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '10' } }

  test('a token fee is drawn in the token, never in sats', async () => {
    const tree = await render({ ...TOKEN, asset: { ...TOKEN.asset!, fee: '0.05' } })
    const fee = tree.root.findAllByType(FigureRow).find(row => row.props.label === 'Fee')!

    expect(fee.findAllByType(Text).slice(1).map(n => [n.props.children].flat().join('')).join('')).toBe('0.05 USDB')
    expect(shown(tree)).not.toContain('sats')
  })

  test('a token with no fee from the SDK has no line, and no zero', async () => {
    expect(labels(await render(TOKEN))).not.toContain('Fee')
  })
})

// The folded proof is what keeps the first screen short, and a value copied from it has to be whole.
describe('technical details', () => {
  const PAID: HistoryItem = {
    id: 'ln1',
    direction: 'sent',
    status: 'complete',
    amountSat: 21_000,
    feesSat: 0,
    timestamp: 1_700_000_300,
    method: 'lightning',
    asset: null,
    destination: 'maria@usevoltz.app',
    invoice: `lnbc${'1'.repeat(80)}`,
    paymentHash: 'a'.repeat(64),
    preimage: 'b'.repeat(64),
    provider: 'Boltz',
  }

  test('start closed, with the destination still on the first level', async () => {
    const tree = await render(PAID)

    expect(shown(tree)).toContain('Destination')
    for (const label of ['Network', 'Payment hash', 'Proof of payment', 'Invoice', 'Provider']) {
      expect(shown(tree)).not.toContain(label)
    }
    expect(foldLine(tree)!.findAll(n => n.props.accessibilityState?.expanded === false).length).toBeGreaterThan(0)
  })

  test('one tap shows the rail, the provider and the proof', async () => {
    const tree = await render(PAID)
    await openDetails(tree)

    for (const label of ['Network', 'Provider', 'Boltz', 'Payment hash', 'Proof of payment', 'Invoice']) {
      expect(shown(tree)).toContain(label)
    }
  })

  test.each([
    ['Invoice', PAID.invoice],
    ['Proof of payment', PAID.preimage],
    ['Payment hash', PAID.paymentHash],
  ])('copying %s takes the whole value, not the cut one on screen', async (label, value) => {
    const tree = await render(PAID)
    await openDetails(tree)
    const row = tree.root.findAllByType(Touch).find(n => String(n.props.label).startsWith(`${label},`))!

    expect(row.props.label).toContain('…')
    await ReactTestRenderer.act(async () => row.props.onPress())
    expect(Clipboard.setString).toHaveBeenLastCalledWith(value)
  })

  test('another payment opens closed again', async () => {
    const tree = await render(PAID)
    await openDetails(tree)
    expect(shown(tree)).toContain('Proof of payment')

    await ReactTestRenderer.act(async () => {
      tree.update(<TransactionDetailSheet item={{ ...PAID, id: 'ln2' }} onClose={() => undefined} />)
    })

    expect(shown(tree)).not.toContain('Proof of payment')
  })

  test('a token payment has an id to copy and no explorer to send it to', async () => {
    const tree = await render({
      ...PAID,
      method: 'spark',
      asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '10' },
      transferRef: 'tokenhash1234567890abcdefabcdef',
      invoice: undefined,
      paymentHash: undefined,
      preimage: undefined,
    })
    await openDetails(tree)
    const row = tree.root.findAllByType(Touch).find(n => String(n.props.label).startsWith('Payment ID,'))!

    await ReactTestRenderer.act(async () => row.props.onPress())
    expect(Clipboard.setString).toHaveBeenLastCalledWith('tokenhash1234567890abcdefabcdef')
    expect(shown(tree)).not.toContain('View in explorer')
  })

  test('a Bitcoin payment keeps the explorer on the first level, outside the fold', async () => {
    const tree = await render({ ...PAID, method: 'bitcoin', txId: 'c'.repeat(64) })

    expect(tree.root.findAllByType(GradientButton).map(n => n.props.label)).toEqual(['View in explorer'])
    expect(shown(tree)).not.toContain('Transaction ID')
  })

  // The explorer is read as the sheet opens, and a press can come before that read answers.
  test('a press before the chosen explorer is read opens that explorer', async () => {
    let answer: ((config: settings.TxExplorerConfig) => void) | undefined
    const chosen = jest
      .spyOn(settings, 'loadTxExplorers')
      .mockImplementation(() => new Promise(resolve => (answer = resolve)))
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    try {
      const txId = 'c'.repeat(64)
      const tree = await render({ ...PAID, method: 'bitcoin', txId })
      const view = tree.root.findAllByType(GradientButton).find(b => b.props.label === 'View in explorer')
      await ReactTestRenderer.act(async () => {
        view?.props.onPress()
      })
      expect(opened).not.toHaveBeenCalled()

      await ReactTestRenderer.act(async () => {
        answer?.({ custom: [{ id: 'mine', url: 'http://node.local:3006/' }], selectedId: 'mine' })
      })
      expect(opened).toHaveBeenCalledTimes(1)
      expect(opened).toHaveBeenCalledWith(`http://node.local:3006/tx/${txId}`)
    } finally {
      chosen.mockRestore()
      opened.mockRestore()
    }
  })

  // A read that fails on a later opening leaves the explorer an earlier one found, which the link is
  // drawn with, rather than the default.
  test('a press after a read that failed opens the explorer read before', async () => {
    const chosen = jest
      .spyOn(settings, 'loadTxExplorers')
      .mockResolvedValueOnce({ custom: [], selectedId: 'blockstream' })
      .mockRejectedValueOnce(new Error('unreadable'))
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    try {
      const txId = 'c'.repeat(64)
      const item: HistoryItem = { ...PAID, method: 'bitcoin', txId }
      const tree = await render(item)
      await ReactTestRenderer.act(async () => {
        tree.update(<TransactionDetailSheet item={null} onClose={() => undefined} />)
      })
      await ReactTestRenderer.act(async () => {
        tree.update(<TransactionDetailSheet item={item} onClose={() => undefined} />)
      })
      expect(chosen).toHaveBeenCalledTimes(2)

      const view = tree.root.findAllByType(GradientButton).find(b => b.props.label === 'View in explorer')
      await ReactTestRenderer.act(async () => {
        await view?.props.onPress()
      })
      expect(opened).toHaveBeenCalledWith(`https://blockstream.info/tx/${txId}`)
    } finally {
      chosen.mockRestore()
      opened.mockRestore()
    }
  })
})

describe('a USDT send', () => {
  const SEND: HistoryItem = {
    id: 'cc1',
    direction: 'sent',
    status: 'complete',
    amountSat: 50_000,
    feesSat: 0,
    timestamp: 1_700_000_300,
    method: 'spark',
    asset: null,
    destination: 'TRrecipient000000000000000000000000',
    delivery: 'complete',
    transferRef: 'transfer-1',
    provider: 'Orchestra',
    crossChainSend: {
      chain: 'tron',
      asset: 'USDT',
      estimatedOut: '49',
      deliveredAmount: '48.75',
      feeAmount: '1.25',
      txHash: '0xdelivery000000000000000000000000000000',
    },
  }
  const rows = (tree: ReactTestRenderer.ReactTestRenderer) =>
    Object.fromEntries(
      tree.root
        .findAllByType(FigureRow)
        .map(row => [row.props.label, row.findAllByType(Text).slice(1).map(n => [n.props.children].flat().join('')).join('')]),
    )
  const headline = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(Text)
      .map(n => [n.props.children].flat().filter((c: unknown) => typeof c === 'string').join(''))
      .find(text => text.includes('\u2212'))

  test('opens on what arrived, with the network, the address and the transaction on the first level', async () => {
    const tree = await render(SEND)
    const row = rows(tree)

    expect(headline(tree)).toBe('\u221248.75 USDT')
    expect(row.Arrived).toBe('48.75 USDT')
    expect(row['Destination network']).toBe('Tron')
    expect(row.Left).toBe(`${formatSats(50_000)} sats`)
    expect(shown(tree)).toContain('Destination')
    expect(shown(tree)).toContain('Transaction on Tron')
    expect(shown(tree)).not.toContain('Provider')
  })

  // Dollar mode raised the sats first, so the send carries that conversion, whose own sides name the sats
  // it made. Those reached the wallet, not the far side. Shape from sendDelivery's note in spark.ts.
  describe('funded by a conversion', () => {
    const CONVERSION = {
      status: 'complete' as const,
      automatic: true,
      from: { ticker: 'USDB', amount: '12' },
      to: { ticker: null, amount: '12000' },
    }
    const labels = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(FigureRow).map(row => row.props.label as string)

    test('delivered, the far side is the one Arrived and there is one Left', async () => {
      const tree = await render({ ...SEND, conversion: CONVERSION })

      expect(labels(tree).filter(label => label === 'Arrived')).toHaveLength(1)
      expect(labels(tree).filter(label => label === 'Left')).toHaveLength(1)
      expect(rows(tree).Arrived).toBe('48.75 USDT')
      expect(rows(tree).Left).toBe(`${formatSats(50_000)} sats`)
    })

    test('pending, only the estimate stands for the far side', async () => {
      const tree = await render({
        ...SEND,
        status: 'pending',
        delivery: 'pending',
        conversion: CONVERSION,
        crossChainSend: { ...SEND.crossChainSend!, deliveredAmount: undefined },
      })

      expect(labels(tree)).not.toContain('Arrived')
      expect(rows(tree)['Expected to arrive']).toBe('≈ 49 USDT')
    })

    test.each(['failed', 'refundPending', 'refunded'] as const)('at %s no line says it arrived', async delivery => {
      const tree = await render({
        ...SEND,
        status: 'failed',
        delivery,
        conversion: CONVERSION,
        crossChainSend: { ...SEND.crossChainSend!, deliveredAmount: undefined },
      })

      expect(labels(tree)).not.toContain('Arrived')
      expect(labels(tree)).not.toContain('Expected to arrive')
    })

    test('the conversion still says how it ended', async () => {
      const tree = await render({ ...SEND, conversion: CONVERSION })

      expect(rows(tree).Conversion).toBe('Completed')
    })
  })

  test('the fee is the provider\'s, in the asset that arrived', async () => {
    expect(rows(await render(SEND)).Fee).toBe('1.25 USDT')
  })

  test('with no fee from the provider there is no line, and never 0 sats', async () => {
    const tree = await render({ ...SEND, crossChainSend: { ...SEND.crossChainSend!, feeAmount: undefined } })

    expect(rows(tree).Fee).toBeUndefined()
    expect(Object.values(rows(tree))).not.toContain('0 sats')
  })

  test('pending, the arrival and the fee are both estimates', async () => {
    const tree = await render({
      ...SEND,
      status: 'pending',
      delivery: 'pending',
      crossChainSend: { ...SEND.crossChainSend!, deliveredAmount: undefined },
    })
    const row = rows(tree)

    expect(headline(tree)).toBe('≈ \u221249 USDT')
    expect(row['Expected to arrive']).toBe('≈ 49 USDT')
    expect(row.Arrived).toBeUndefined()
    expect(row.Fee).toBe('≈ 1.25 USDT')
  })

  test.each(['failed', 'refundPending', 'refunded'] as const)(
    'at %s nothing arrived, so the figure is what left and no fee stands',
    async delivery => {
      const tree = await render({
        ...SEND,
        status: 'failed',
        delivery,
        crossChainSend: { ...SEND.crossChainSend!, deliveredAmount: undefined },
      })
      const row = rows(tree)

      expect(headline(tree)).toBe(`\u2212${formatSats(50_000)} sats`)
      expect(row.Arrived).toBeUndefined()
      expect(row['Expected to arrive']).toBeUndefined()
      expect(row.Fee).toBeUndefined()
      expect(row.Total).toBeUndefined()
    },
  )

  test('a Boltz send has no transaction line', async () => {
    const tree = await render({ ...SEND, crossChainSend: { ...SEND.crossChainSend!, txHash: undefined } })

    expect(shown(tree)).not.toContain('Transaction on')
  })
})

// Text from a third party: a comment and a LUD-09 action are drawn as they came, and nothing in them
// runs or resolves.
describe('text the service left', () => {
  const PAID: HistoryItem = {
    id: 'ln1',
    direction: 'sent',
    status: 'complete',
    amountSat: 1_000,
    feesSat: 0,
    timestamp: 1_700_000_300,
    method: 'lightning',
    asset: null,
  }
  let open: jest.SpyInstance
  beforeEach(() => {
    open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  })
  afterEach(() => open.mockRestore())

  test('the comment a send went out with shows as written', async () => {
    const tree = await render({ ...PAID, comment: 'Hello {{x}} $t(common.sats)' })

    expect(shown(tree)).toContain('Hello {{x}} $t(common.sats)')
  })

  test('a message shows as written, with no key lookup and no interpolation', async () => {
    const tree = await render({ ...PAID, successAction: { kind: 'message', text: 'history.sent {{x}}' } })

    expect(shown(tree)).toContain('history.sent {{x}}')
    expect(shown(tree)).toContain('Message from the recipient')
  })

  test('a decrypted one carries its description', async () => {
    const tree = await render({
      ...PAID,
      successAction: { kind: 'message', text: '1234', description: 'Your code' },
    })

    expect(shown(tree)).toContain('Your code')
    expect(shown(tree)).toContain('1234')
  })

  test('an http address opens on a tap and not before', async () => {
    const url = 'https://shop.example/receipt/1'
    const tree = await render({ ...PAID, successAction: { kind: 'url', url, description: 'Receipt' } })

    expect(open).not.toHaveBeenCalled()
    expect(shown(tree)).toContain(url)
    await ReactTestRenderer.act(async () =>
      tree.root.findAllByType(Touch).find(n => n.props.role === 'link')!.props.onPress(),
    )
    expect(open).toHaveBeenCalledWith(url)
  })

  test('an address on another host than the service paid is shown and never opens', async () => {
    const url = 'https://else.example/receipt/1'
    const tree = await render({ ...PAID, successAction: { kind: 'url', url, description: 'Receipt', foreignHost: true } })

    expect(shown(tree)).toContain(url)
    expect(tree.root.findAllByType(Touch).filter(n => n.props.role === 'link')).toHaveLength(0)
  })

  // eslint-disable-next-line no-script-url
  test.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'https://a b.example'])(
    'the address %s is not offered at all',
    async url => {
      const tree = await render({ ...PAID, successAction: { kind: 'url', url, description: 'Receipt' } })

      expect(tree.root.findAllByType(Touch).filter(n => n.props.role === 'link')).toHaveLength(0)
      expect(shown(tree)).toContain('Receipt')
      expect(shown(tree)).not.toContain(url)
    },
  )
})

describe('built on the shared pieces', () => {
  test('names the direction with the section role', async () => {
    const tree = await render(RECEIVED)
    const sections = tree.root.findAllByType(Txt).filter(n => n.props.role === 'section')
    expect(sections.map(n => n.props.children)).toEqual(['Received'])
  })

  test('lays every detail out on a divided row, and a copy row reads its label and value', async () => {
    const tree = await render(RECEIVED)
    // Date and from through FigureRow; the source transaction as a copy row. The token's 0 is no fee.
    const valueRows = tree.root.findAllByType(FigureRow)
    expect(valueRows.map(n => n.props.label)).toEqual(['Date', 'From'])
    for (const row of valueRows) {
      expect(StyleSheet.flatten(row.props.style)).toMatchObject({ borderBottomColor: colors.divider })
    }
    // The copy row and the fold's own line.
    expect(tree.root.findAllByType(Row).filter(n => n.props.divider === true)).toHaveLength(2)
    const copy = tree.root.findAllByType(Touch)
    expect(copy.map(n => n.props.label)).toEqual(['Transaction on Tron, tronhash1234…90abcdef', undefined])
  })
})

// A Lightning receive with a zap comment and every hash runs past a small screen, and the sheet stops
// at its cap, so the detail has to scroll there or the explorer button and the last rows are cut off.
describe('a detail taller than the screen', () => {
  const TALL: HistoryItem = {
    id: 'z1',
    direction: 'received',
    status: 'complete',
    amountSat: 21_000,
    feesSat: 0,
    timestamp: 1_700_000_300,
    method: 'lightning',
    asset: null,
    description: 'Thanks for the talk',
    invoice: 'lnbc210u1pjexampleinvoicewithalongbody',
    paymentHash: 'a'.repeat(64),
    preimage: 'b'.repeat(64),
    txId: 'c'.repeat(64),
    zap: { comment: 'Great talk, here is a long comment that wraps over several lines in the sheet.' },
  } as HistoryItem

  test('scrolls inside the sheet, from the direction down to the last row', async () => {
    const tree = await render(TALL)
    await openDetails(tree)
    const scrolls = tree.root.findAllByType(ScrollView)
    expect(scrolls).toHaveLength(1)
    const inside = scrolls[0]!.findAllByType(Text).map(n => [n.props.children].flat().join(''))
    expect(inside).toContain('Received')
    expect(inside.some(s => s.includes('Great talk'))).toBe(true)
    expect(inside).toContain('Proof of payment')
  })

  test('sits under the sheet cap, so the backdrop stays above it', async () => {
    const tree = await render(TALL)
    const capped = tree.root
      .findAllByType(View)
      .map(n => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean)))
      .find(style => style.maxHeight !== undefined)
    expect(capped?.maxHeight).toBe('90%')
  })
})


test('draws the amount on one line that shrinks to fit', async () => {
  const tree = await render(RECEIVED)
  const figure = tree.root.findAllByType(Text).find(n => String(n.props.children).startsWith('+'))!
  expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
})
