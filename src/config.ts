import {
  BREEZ_API_KEY,
  BREEZ_SPARK_API_KEY,
  BREEZ_LNURL_DOMAIN,
  VOLTZ_DISTRIBUTION,
} from '@env'

// The react-native-dotenv babel plugin resolves '@env' at build time, so importing
// '@env' directly bakes the value into the bundle and makes it impossible to
// override in tests. This module isolates that coupling so the rest of the code
// depends on a function that tests can mock.
export function getBreezApiKey(): string | undefined {
  return BREEZ_API_KEY || undefined
}

// Falls back to the older BREEZ_API_KEY when unset, so a single-key .env still connects.
export function getBreezSparkApiKey(): string | undefined {
  return BREEZ_SPARK_API_KEY || BREEZ_API_KEY || undefined
}

// Custom LNURL domain for the Spark Lightning address (e.g. 'usevoltz.app'); unset falls back to the
// SDK default (breez.tips). Set it only once an LNURL server answers on the domain and accepts it,
// either breez.tips with the domain CNAME'd to it and allowlisted by Breez, or a self-hosted server,
// because until then address registration fails.
export function getBreezLnurlDomain(): string | undefined {
  return BREEZ_LNURL_DOMAIN || undefined
}


// How this build sells names and domain years, through the App Store or Google Play ('store') or in
// sats ('direct'). The .env is compiled into every build, release builds included, so a release made
// from a .env that says direct would sell around the store; direct therefore holds only in a
// development build, and anything else, unset included, is store.
export type Distribution = 'store' | 'direct'

export function distributionFor(value: string | undefined, dev: boolean): Distribution {
  return dev && value === 'direct' ? 'direct' : 'store'
}

export function getDistribution(): Distribution {
  return distributionFor(VOLTZ_DISTRIBUTION, __DEV__)
}
