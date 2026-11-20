import { noteGatewayDeleted, onGatewayDeleted } from '../src/wallet/deletionMark'

// The notice of deletionMark.ts on its own. deletion.ts listens from its module scope, which Metro's
// inline requires load only when a screen first calls into it, so a refusal heard at boot waits for
// the first listener rather than reaching nobody.

const KEY = '02ABCDEF'

test('a key refused before anyone listens is handed to the first listener, once, as its stored key', () => {
  noteGatewayDeleted({ pubkey: ` ${KEY} ` })
  noteGatewayDeleted({ pubkey: KEY })
  const first = jest.fn()
  const off = onGatewayDeleted(first)
  expect(first.mock.calls).toEqual([['02abcdef']])

  const second = jest.fn()
  const offSecond = onGatewayDeleted(second)
  expect(second).not.toHaveBeenCalled()

  noteGatewayDeleted({ pubkey: KEY })
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledTimes(1)
  off()
  offSecond()
})

test('a refusal with no key reaches nobody and is not kept', () => {
  noteGatewayDeleted({ pubkey: null })
  noteGatewayDeleted({ pubkey: '  ' })
  const hear = jest.fn()
  const off = onGatewayDeleted(hear)
  expect(hear).not.toHaveBeenCalled()
  off()
})
