import React, { useState } from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Field } from './Field'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'
import { colors, space } from '../theme'

type Props = {
  value: string
  onChangeText: (text: string) => void
}

// A passphrase cannot be validated later, and a typo silently opens a different, empty wallet, so
// the eye toggle reveals the exact characters. Blind double-entry would pass the same typo twice.
export function PassphraseField({ value, onChangeText }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [reveal, setReveal] = useState(false)
  return (
    <Field
      value={value}
      onChangeText={onChangeText}
      placeholder={t('passphrase.field')}
      secureTextEntry={!reveal}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoComplete="off"
      // iOS offers a secure field typed "none" to Passwords once it leaves the screen, which would
      // carry the passphrase to iCloud Keychain; iOS 26.5 does not offer a one-time code field.
      textContentType="oneTimeCode"
      importantForAutofill="no"
      trailing={
        <Touch
          onPress={() => setReveal(r => !r)}
          feedback="link"
          // Declares the drawn size rather than taking the floor: 28 plus 8 of slop on each side
          // is exactly 44 of reachable area, and the eye keeps its drawn width instead of
          // pushing the input 16pt narrower.
          size={28}
          hitSlop={space.sm}
          label={reveal ? t('passphrase.hide') : t('passphrase.reveal')}
          style={styles.eyeButton}>
          <TabIcon name={reveal ? 'eye-off' : 'eye'} color={colors.textSecondary} size={20} />
        </Touch>
      }
    />
  )
}

const styles = StyleSheet.create({
  eyeButton: {
    paddingLeft: space.sm,
  },
})
