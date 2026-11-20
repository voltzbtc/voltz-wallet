import type React from 'react'
import type { SvgProps } from 'react-native-svg'
import Usdt from '../assets/stable-icons/usdt.svg'
import Usdc from '../assets/stable-icons/usdc.svg'
import Arbitrum from '../assets/stable-icons/arbitrum.svg'
import Arc from '../assets/stable-icons/arc.svg'
import Avalanche from '../assets/stable-icons/avalanche.svg'
import Base from '../assets/stable-icons/base.svg'
import Bsc from '../assets/stable-icons/bsc.svg'
import Ethereum from '../assets/stable-icons/ethereum.svg'
import Hyperliquid from '../assets/stable-icons/hyperliquid.svg'
import Monad from '../assets/stable-icons/monad.svg'
import Optimism from '../assets/stable-icons/optimism.svg'
import Plasma from '../assets/stable-icons/plasma.svg'
import Polygon from '../assets/stable-icons/polygon.svg'
import Solana from '../assets/stable-icons/solana.svg'
import Spark from '../assets/stable-icons/spark.svg'
import Tempo from '../assets/stable-icons/tempo.svg'
import Tron from '../assets/stable-icons/tron.svg'

// Official marks from web3icons (MIT), the background variant, shipped because the SDK carries no
// icons.
// Base alone is drawn here from its official square and blue, since the package's background variant
// fills the circle with the square and reads as a white box.
// Keyed apart from token identifiers, with a coin by ticker and a chain by the SDK's slug.
export const STABLE_LOGOS: Record<string, React.FC<SvgProps>> = {
  'coin:USDT': Usdt,
  'coin:USDC': Usdc,
  'chain:arbitrum': Arbitrum,
  'chain:arc': Arc,
  'chain:avalanche': Avalanche,
  'chain:base': Base,
  'chain:bsc': Bsc,
  'chain:ethereum': Ethereum,
  // HyperCore and HyperEVM are both Hyperliquid, under one mark.
  'chain:hypercore': Hyperliquid,
  'chain:hyperevm': Hyperliquid,
  'chain:monad': Monad,
  'chain:optimism': Optimism,
  'chain:plasma': Plasma,
  'chain:polygon': Polygon,
  'chain:solana': Solana,
  // Spark's own asterisk, the light version from spark.money/brand on the brand's dark, unaltered and
  // with its clear space, in the square the other network marks use.
  'chain:spark': Spark,
  'chain:tempo': Tempo,
  'chain:tron': Tron,
}

export const coinIconId = (ticker: string): string => `coin:${ticker}`
export const chainIconId = (slug: string): string => `chain:${slug}`
