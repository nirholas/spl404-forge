import { getProgramDerivedAddress } from '@solana/kit';
import { MEMO_V3, REGISTRY_SEED } from './config.js';

let cached;

/**
 * The public index. It is a program-derived address with no private key, so nobody controls it.
 * Creations opt in by adding a zero-lamport transfer to it, which makes every listed creation
 * discoverable through plain getSignaturesForAddress without any indexer or database.
 */
export async function registryAddress() {
  if (!cached) {
    cached = getProgramDerivedAddress({ programAddress: MEMO_V3, seeds: [REGISTRY_SEED] }).then(([address]) => address);
  }
  return cached;
}
