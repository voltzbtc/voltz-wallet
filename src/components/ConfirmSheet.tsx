import React, { useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { GradientButton } from './GradientButton'
import { MenuRow } from './MenuRow'
import { Sheet } from './Sheet'
import { Toggle } from './Toggle'
import { Txt } from './Txt'
import { space } from '../theme'

export type ConfirmRequest = {
  title: string
  body?: string
  confirm: string
  cancel: string
  // For what cannot come back, which then wears the danger variant.
  danger?: boolean
  // A choice that goes with the confirm, as a switch above it with a muted line on what it does. Off
  // each time the question opens; the confirm hands its state to `onConfirm`.
  option?: { label: string; note?: string }
  onConfirm: (optionOn: boolean) => void | Promise<void>
}

// The question, for a sheet that asks inside its own panel. A second Modal cannot open from a sheet:
// over it, one window sits on another, and just after it, iOS is still dismissing the first and the
// present is refused with nothing to retry it (RCTModalHostViewComponentView). So that sheet swaps its
// content for this and sends its own close to `onClose`.
export function ConfirmBody({
  request,
  onClose,
}: {
  request: ConfirmRequest
  onClose: () => void
}): React.JSX.Element {
  // Held with the question it was set on, so a new question starts off without an effect resetting it
  // a frame late.
  const [choice, setChoice] = useState<{ request: ConfirmRequest; on: boolean } | null>(null)
  const optionOn = choice?.request === request && choice.on
  return (
    // Under the sheet's cap, since at the largest text sizes a long warning would leave the confirm
    // out of reach.
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
      <Txt role="subheading">{request.title}</Txt>
      {request.body ? (
        <Txt role="body" tone="muted">
          {request.body}
        </Txt>
      ) : null}
      {request.option ? (
        <View>
          <MenuRow
            divider={false}
            label={request.option.label}
            right={
              <Toggle
                value={optionOn}
                onValueChange={on => setChoice({ request, on })}
                accessibilityLabel={request.option.label}
              />
            }
          />
          {request.option.note ? (
            <Txt role="caption" tone="muted">
              {request.option.note}
            </Txt>
          ) : null}
        </View>
      ) : null}
      <GradientButton
        label={request.confirm}
        variant={request.danger ? 'danger' : 'primary'}
        onPress={() => {
          onClose()
          request.onConfirm(optionOn)
        }}
      />
      <GradientButton label={request.cancel} variant="secondary" onPress={onClose} />
    </ScrollView>
  )
}

// A question before an action, in the app's own surface. The system's dialog is the one light thing
// in a black app and follows the phone's theme rather than the app's, and it cannot draw a confirm
// that says how much it costs. It closes before it acts, so what the action opens is never under it.
export function ConfirmSheet({
  request,
  onClose,
}: {
  request: ConfirmRequest | null
  onClose: () => void
}): React.JSX.Element {
  // What was asked stays drawn while the sheet leaves.
  const shown = useRef(request)
  shown.current = request ?? shown.current
  const asked = shown.current

  return (
    <Sheet visible={request !== null} onClose={onClose} closeLabel={asked?.cancel ?? ''}>
      {asked && <ConfirmBody request={asked} onClose={onClose} />}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  // The sheet's own gap, which a child scroll does not inherit.
  body: { gap: space.lg },
})
