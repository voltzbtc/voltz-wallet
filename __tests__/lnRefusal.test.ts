import {
  domainOrderRefusalKey,
  finalOf,
  gatewayRefusal,
  paidRefusal,
  gatewayRetryAt,
  moveRefusalKey,
  refusalKey,
  storeErrorKey,
  storeNameRefusalKey,
} from '../src/wallet/lnRefusal'

// Copies the error SDK 0.27.2 throws for any answer of the LNURL server other than 2xx or 401. On
// React Native its message is only the class name, and the payload is the one string in `inner`.
function sdkError(tag: string, text: string): Error {
  return Object.assign(new Error(`SdkError.${tag}`), { tag, inner: Object.freeze([text]) })
}

function answered(status: number, body: string): Error {
  return sdkError('NetworkError', `network request failed with status ${status}: ${body}`)
}

test('the gateway code is read from the body the server answered with', () => {
  expect(gatewayRefusal(answered(403, '{"error":"change_limit_reached"}'))).toBe(
    'change_limit_reached',
  )
  // Whitespace and extra fields are the gateway's to add; the code is what the app reads.
  expect(gatewayRefusal(answered(429, '{ "error": "reserved", "retryAfter": 60 }'))).toBe('reserved')
})

// A register refused while another wallet's hold of the name lasts says when it clears.
test('the second a refusal clears is read beside its code, and only as a number', () => {
  expect(gatewayRetryAt(answered(409, '{"error":"held_by_another_wallet","retry_at":1800000600}'))).toBe(1_800_000_600)
  expect(gatewayRetryAt(answered(409, '{"error":"held_by_another_wallet"}'))).toBeUndefined()
  expect(gatewayRetryAt(answered(409, '{"error":"held_by_another_wallet","retry_at":"1800000600"}'))).toBeUndefined()
  expect(gatewayRetryAt(answered(502, '<html>502 Bad Gateway</html>'))).toBeUndefined()
  expect(gatewayRetryAt(sdkError('NetworkError', 'connection refused {"retry_at":1800000600}'))).toBeUndefined()
})

test('a body that is not the gateway JSON carries no code', () => {
  expect(gatewayRefusal(answered(502, '<html>502 Bad Gateway</html>'))).toBeUndefined()
  expect(gatewayRefusal(answered(409, 'name is reserved'))).toBeUndefined()
  expect(gatewayRefusal(answered(500, ''))).toBeUndefined()
  expect(gatewayRefusal(answered(403, 'null'))).toBeUndefined()
  expect(gatewayRefusal(answered(403, '"reserved"'))).toBeUndefined()
  expect(gatewayRefusal(answered(403, '{"error":403}'))).toBeUndefined()
  expect(gatewayRefusal(answered(403, '{"reason":"reserved"}'))).toBeUndefined()
})

// The same NetworkError carries failures that never reached the server, such as a dropped
// connection, with no status and no body. A JSON-looking fragment in that text is not an answer.
test('a NetworkError that is not a server answer carries no code', () => {
  expect(
    gatewayRefusal(sdkError('NetworkError', 'connection refused {"error":"reserved"}')),
  ).toBeUndefined()
})

test('only a NetworkError is read, whatever its text says', () => {
  const text = 'network request failed with status 403: {"error":"reserved"}'
  expect(gatewayRefusal(sdkError('InvalidInput', text))).toBeUndefined()
  expect(gatewayRefusal(new Error(text))).toBeUndefined()
  expect(gatewayRefusal(new Error('reserved'))).toBeUndefined()
  expect(gatewayRefusal({ tag: 'NetworkError', inner: [] })).toBeUndefined()
  expect(gatewayRefusal({ tag: 'NetworkError', inner: text })).toBeUndefined()
  expect(gatewayRefusal(undefined)).toBeUndefined()
  expect(gatewayRefusal(null)).toBeUndefined()
  expect(gatewayRefusal(text)).toBeUndefined()
})

// The code comes from a response body, so a name every object inherits must not find a sentence.
test('a code that names an object property maps to nothing', () => {
  for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect(refusalKey(code)).toBeUndefined()
    expect(moveRefusalKey(code)).toBeUndefined()
  }
})

test('a move reads the domain refusals as being about the receiving wallet', () => {
  expect(moveRefusalKey('domain_not_yours')).toBe('receive.lnMoveNotAllowed')
  expect(moveRefusalKey('domain_expired')).toBe('domain.noticeExpiredTitle')
  expect(moveRefusalKey('change_limit_reached')).toBe(refusalKey('change_limit_reached'))
  expect(moveRefusalKey(undefined)).toBeUndefined()
  expect(moveRefusalKey('something_new')).toBeUndefined()
})

describe('a store purchase of a name', () => {
  test('reads the store refusals before the ones the sats path shares', () => {
    expect(storeNameRefusalKey('name_taken')).toBe('receive.lnTaken')
    expect(storeNameRefusalKey('held_by_another_wallet')).toBe('receive.lnTaken')
    expect(storeNameRefusalKey('name_held_for_credit')).toBe('receive.lnTaken')
    expect(storeNameRefusalKey('name_paid_by_another_wallet')).toBe('receive.lnTaken')
    expect(storeNameRefusalKey('name_pending')).toBe('store.otherPending')
    expect(storeNameRefusalKey('order_in_other_store')).toBe('store.otherStore')
    expect(storeNameRefusalKey('sats_purchase_in_progress')).toBe('store.satsInProgress')
    expect(storeNameRefusalKey('change_limit_reached')).toBe(refusalKey('change_limit_reached'))
  })

  // A stale intent is fixed by signing again, which the next press does.
  test.each(['intent_missing', 'intent_used', 'intent_expired'])('%p asks for another try', code => {
    expect(storeNameRefusalKey(code)).toBe('store.retry')
  })

  // An unknown code is no clear refusal, and the register behind it is read back instead.
  test('a code it does not know maps to nothing, object properties included', () => {
    for (const code of ['upstream_timeout', 'tier_mismatch', 'constructor', '__proto__']) {
      expect(storeNameRefusalKey(code)).toBeUndefined()
    }
  })

  test('says what the store answered, and nothing for a cancel', () => {
    expect(storeErrorKey('network')).toBe('store.errorNetwork')
    expect(storeErrorKey('storeUnavailable')).toBe('store.unavailable')
    expect(storeErrorKey('declined')).toBe('store.errorDeclined')
    expect(storeErrorKey('alreadyOwned')).toBe('store.errorAlreadyOwned')
    expect(storeErrorKey('cancelled')).toBeUndefined()
    expect(storeErrorKey('unknown')).toBeUndefined()
  })
})

describe('a store order of a domain year', () => {
  // The hold on a host being renewed is the owner's own purchase, never a stranger buying it.
  test('reads the hold on the host by whether it is a renewal', () => {
    expect(domainOrderRefusalKey('held_by_another_wallet', false)).toBe('useDomain.domainBeingBought')
    expect(domainOrderRefusalKey('held_by_another_wallet', true)).toBe('useDomain.renewalInProgress')
    expect(domainOrderRefusalKey('sats_purchase_in_progress', false)).toBe('useDomain.renewalInProgress')
    expect(domainOrderRefusalKey('order_in_other_store', true)).toBe('store.otherStore')
    expect(domainOrderRefusalKey('domain_belongs_to_another_wallet', false)).toBeUndefined()
    expect(domainOrderRefusalKey('constructor', false)).toBeUndefined()
  })
})

// The gateway answers a paid confirmation it cannot grant with `final`. Only an explicit false says a
// later confirmation may still grant the name; true, and no field at all as a year or an older gateway
// sends, say nothing will, so the money waits on a person.
describe('a paid confirmation refused', () => {
  const refusal = (final?: unknown) =>
    Object.assign(new Error('paid_but_not_granted'), final === undefined ? {} : { final })

  test('is coming only on final false', () => {
    expect(paidRefusal(refusal(false))).toBe('coming')
    expect(paidRefusal(refusal(true))).toBe('kept')
    expect(paidRefusal(refusal())).toBe('kept')
    expect(paidRefusal(refusal('false'))).toBe('kept')
    expect(paidRefusal(refusal(0))).toBe('kept')
  })

  test('is not any other refusal, and survives what is not an error', () => {
    expect(paidRefusal(Object.assign(new Error('name_taken'), { final: false }))).toBeUndefined()
    expect(paidRefusal(undefined)).toBeUndefined()
    expect(paidRefusal(null)).toBeUndefined()
    expect(paidRefusal('paid_but_not_granted')).toBeUndefined()
  })

  test('read from its code alone, never says the name is coming', () => {
    expect(refusalKey('paid_but_not_granted')).toBe('recover.blockedBody')
    expect(storeNameRefusalKey('paid_but_not_granted')).toBe('recover.blockedBody')
  })

  test('final is read only as a boolean', () => {
    expect(finalOf({ final: false })).toBe(false)
    expect(finalOf({ final: true })).toBe(true)
    expect(finalOf({ final: 'false' })).toBeUndefined()
    expect(finalOf({})).toBeUndefined()
    expect(finalOf(undefined)).toBeUndefined()
  })
})
