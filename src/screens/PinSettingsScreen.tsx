import React, { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import { MenuRow } from '../components/MenuRow'
import { Toggle } from '../components/Toggle'
import { Skeleton } from '../components/Skeleton'
import {
  disableBiometricUnlock,
  getBiometryKind,
  isBiometricUnlockEnabled,
  markBiometricOffered,
  type BiometryKind,
} from '../wallet/biometrics'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { font, radius, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'

// The size of a MenuRow's mark, and about what its label takes.
const ROW_ICON = 22
const ROW_LABEL = 150

export function PinSettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [biometryKind, setBiometryKind] = useState<BiometryKind>(null)
  const [bioEnabled, setBioEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useFocusEffect(
    useCallback(() => {
      let active = true
      ;(async () => {
        const [kind, enabled] = await Promise.all([getBiometryKind(), isBiometricUnlockEnabled()])
        if (active) {
          setBiometryKind(kind)
          setBioEnabled(enabled)
          setLoaded(true)
        }
      })()
      return () => {
        active = false
      }
    }, []),
  )

  // Enabling captures the PIN behind the biometric gate, and disabling drops that copy.
  //
  // Either direction is an answer to the offer, so the offer is marked as made and the next keypad
  // unlock does not ask again what was just decided here. The mark is not waited on, and a mark that
  // fails costs at most one offer later, so it never holds the switch.
  function toggleBiometric(value: boolean) {
    markBiometricOffered().catch(() => undefined)
    if (value) {
      navigation.navigate('EnableBiometrics')
    } else {
      disableBiometricUnlock().then(() => setBioEnabled(false))
    }
  }

  return (
    <Screen layout="padded" contentStyle={styles.container}>
      <MenuRow
        bleed
        divider={!loaded || biometryKind != null}
        icon="lock"
        label={t('settings.changePin')}
        onPress={() => navigation.navigate('ChangePin')}
      />
      {!loaded ? (
        // Reserved while the keychain read resolves, so the row does not pop in a frame later.
        <View style={styles.skelRow}>
          <Skeleton width={ROW_ICON} height={ROW_ICON} borderRadius={radius.full} />
          <Skeleton width={ROW_LABEL} height={font.leading.base} />
        </View>
      ) : biometryKind ? (
        <MenuRow
          bleed
          divider={false}
          icon={biometryKind === 'face' ? 'faceid' : 'fingerprint'}
          label={t('settings.biometric')}
          right={
            <Toggle
              value={bioEnabled}
              onValueChange={toggleBiometric}
              accessibilityLabel={t('settings.biometric')}
            />
          }
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  // A row's own 16 of padding makes up the 24 under the header.
  container: {
    paddingTop: rhythm.headerToContent - space.lg,
  },
  // Matches a MenuRow's height (leading icon + label, paddingVertical space.lg) so nothing jumps.
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.lg,
  },
})
