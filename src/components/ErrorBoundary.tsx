import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import i18n from 'i18next'
import { colors, font, radius, space, touch } from '../theme'
import { leadingText } from '../i18n/direction'

type Props = { children: React.ReactNode }
type State = { failed: boolean }

// The last thing between a render error and a blank screen. Without one, a throw anywhere in the tree
// unmounts the whole app: React discards the entire tree when no boundary catches, which in a wallet
// reads as the money being gone. It is not, and saying so is most of this component's job.
//
// Placed around SafeAreaProvider rather than inside it, so a throw in the provider tree is caught
// too. The recovery screen therefore has no insets, which costs nothing: it is centred inside
// space.xl of padding, well clear of any notch or home indicator.
//
// Retrying is offered because a great many render errors are transient, coming from a value that
// arrived late or a subscription that fired against a torn-down screen. When the cause is in
// persisted state the retry fails again immediately, which is honest: it shows the same screen
// rather than pretending to recover.
//
// Android's back leaves the app from here, on purpose. Handling it would mean a BackHandler listener
// or a navigator, and the boundary depends on nothing inside the tree that just failed.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The only record there is. Nothing is sent anywhere: a stack trace from a non-custodial wallet
    // can carry an address or an amount, and this app has no telemetry by design.
    console.error('render failed:', error?.message ?? error, info?.componentStack ?? '')
  }

  render(): React.ReactNode {
    if (!this.state.failed) {
      return this.props.children
    }
    return (
      <View style={styles.screen} accessibilityRole="alert">
        <Text style={[leadingText(), styles.title]}>
          {say('errors.crashTitle', 'Something broke')}
        </Text>
        <Text style={[leadingText(), styles.body]}>
          {say(
            'errors.crashBody',
            'Your wallet and your money are untouched. Your recovery phrase never leaves this device.',
          )}
        </Text>
        <Pressable
          onPress={() => this.setState({ failed: false })}
          accessibilityRole="button"
          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}>
          <Text style={[leadingText(), styles.retryText]}>
            {say('errors.crashRetry', 'Try again')}
          </Text>
        </Pressable>
      </View>
    )
  }
}

// Translated, but never dependent on translation working. A boundary that throws while rendering its
// own message leaves exactly the blank screen it exists to prevent, and i18n is inside the tree that
// just failed. The English literals are the floor, not the intended copy.
function say(key: string, fallback: string): string {
  try {
    const text = i18n.t(key)
    return typeof text === 'string' && text !== '' && text !== key ? text : fallback
  } catch {
    return fallback
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  title: {
    color: colors.text,
    fontSize: font.size.xxl,
    ...font.family.bold,
    textAlign: 'center',
  },
  body: {
    color: colors.textSecondary,
    fontSize: font.size.base,
    lineHeight: font.leading.base,
    textAlign: 'center',
  },
  retry: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    marginTop: space.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
  },
  retryPressed: { backgroundColor: colors.surfaceRaised },
  retryText: {
    color: colors.text,
    fontSize: font.size.base,
    ...font.family.semibold,
    textAlign: 'center',
  },
})
