const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const SIGNATURE_RE = new RegExp(`^${BASE58}{64,90}$`);
const ADDRESS_RE = new RegExp(`^${BASE58}{32,44}$`);

const TX_PATHS = ['tx', 'transaction', 'txs'];
const ADDRESS_PATHS = ['account', 'address', 'token', 'mint', 'wallet', 'program'];

export function isSignature(value) {
  return SIGNATURE_RE.test(value);
}

export function isAddress(value) {
  return ADDRESS_RE.test(value);
}

function clusterFrom(url) {
  const cluster = url.searchParams.get('cluster') || url.searchParams.get('network');
  if (!cluster) return undefined;
  if (/devnet/i.test(cluster)) return 'devnet';
  if (/mainnet/i.test(cluster)) return 'mainnet';
  return undefined;
}

/**
 * Accepts whatever a trader is likely to paste: a raw signature or address, or a link
 * from Solscan, Solana Explorer, SolanaFM, Orb, XRAY, Solana Beach, or this app itself.
 */
export function parseTarget(raw = '') {
  const input = String(raw).trim();
  if (!input) throw new Error('Paste a transaction signature, token address, or explorer link.');

  if (isSignature(input)) return { kind: 'tx', id: input };
  if (isAddress(input)) return { kind: 'address', id: input };

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('That does not look like a Solana signature, address, or explorer link.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const network = clusterFrom(url);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].toLowerCase();
    const next = segments[i + 1];
    if (!next) continue;
    if (TX_PATHS.includes(segment) && isSignature(next)) return { kind: 'tx', id: next, network };
    if (ADDRESS_PATHS.includes(segment) && isAddress(next)) return { kind: 'address', id: next, network };
  }

  const candidate = segments.reverse().find((part) => isSignature(part) || isAddress(part));
  if (candidate) return { kind: isSignature(candidate) ? 'tx' : 'address', id: candidate, network };

  throw new Error('No signature or address found in that link.');
}
