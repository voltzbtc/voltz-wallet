import { announceSendSettled, onSendSettled, sendSettledHeard } from '../src/wallet/sendNotice'

test('an end is heard only while someone listens, with the facts it was told with', () => {
  const heard = jest.fn()
  expect(sendSettledHeard()).toBe(false)
  const off = onSendSettled(heard)
  expect(sendSettledHeard()).toBe(true)

  announceSendSettled('failed', { sat: 1000, rail: 'lightning' })
  off()
  announceSendSettled('complete', { sat: 2000, rail: 'spark' })

  expect(heard.mock.calls).toEqual([['failed', { sat: 1000, rail: 'lightning' }]])
  expect(sendSettledHeard()).toBe(false)
})
