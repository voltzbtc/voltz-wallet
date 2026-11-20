import React from 'react'
import { StyleSheet, View } from 'react-native'
import { Skeleton } from './Skeleton'
import { radius, space } from '../theme'

// Rows of a flag and a name, the shape of the language and currency pickers, so nothing shifts when
// the list lands.
export function PickerSkeleton(): React.JSX.Element {
  return (
    <View style={styles.skeletons}>
      {[0, 1, 2, 3, 4].map(i => (
        <View key={i} style={styles.skelRow}>
          <Skeleton width={22} height={16} borderRadius={radius.sm} />
          <Skeleton width={150} height={16} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // No padding above, as a row's own 16 is what the list opens with under the search field.
  skeletons: {
    paddingHorizontal: space.xl,
  },
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.lg,
  },
})
