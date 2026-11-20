import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, View } from 'react-native'
import i18n from '../src/i18n'
import { SUPPORT_EMAIL } from '../src/wallet/recover'
import { expectMailFallback } from './support/mailFallback'

// No screen shows a carried text on a card no mail stands behind, so the helper refuses to accept one,
// both when the call is typed and when a card with that shape is handed to it.
test('the mail card helper refuses a carried text on a card no mail stands behind', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <View>
        <Text>{SUPPORT_EMAIL}</Text>
        <View testID="support-mail-text">
          <Text>ref-1</Text>
        </View>
        <Text>{i18n.t('support.copy')}</Text>
      </View>,
    )
  })
  expect(() =>
    // @ts-expect-error a card no mail stands behind carries no text
    expectMailFallback(tree, 'ref-1', 'none'),
  ).toThrow('a card no mail stands behind carries no text')
})
