import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { METAPLEX_METADATA_PROGRAM, NETWORKS, PROTOCOL, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, getSettings } from './config.js';
import { base64ToBytes, classifyText, parseDataUri } from './payload.js';
import { getAccount, getAccountBase64, getSignaturesForAddress } from './rpc.js';
import { scanBytes } from './scan.js';

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const ARWEAVE_GATEWAY = 'https://arweave.net/';

export function resolveUri(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice(7).replace(/^ipfs\//, '');
  if (uri.startsWith('ar://')) return ARWEAVE_GATEWAY + uri.slice(5);
  return uri;
}

export function storageOf(uri) {
  if (!uri) return { where: 'none', label: 'Not set' };
  if (uri.startsWith('data:')) return { where: 'onchain', label: 'On-chain (data URI)' };
  if (/^(ar:\/\/|https:\/\/(www\.)?arweave\.net\/|https:\/\/[a-z0-9-]+\.arweave\.net\/)/i.test(uri)) return { where: 'permaweb', label: 'Arweave' };
  if (/^ipfs:\/\/|\/ipfs\/|\.ipfs\./i.test(uri)) return { where: 'ipfs', label: 'IPFS' };
  if (/^https?:\/\//i.test(uri)) return { where: 'web', label: new URL(uri).host };
  return { where: 'unknown', label: 'Unrecognized URI' };
}

/**
 * Collapses where a token's name, JSON, and image actually live into one trader-facing verdict.
 * "onchain" means every byte a wallet needs is stored in Solana account data.
 */
export function verdictFor({ metadataUri, imageUri }) {
  const json = storageOf(metadataUri);
  const image = storageOf(imageUri);
  const layers = [json.where, image.where].filter((w) => w !== 'none');
  if (layers.length && layers.every((w) => w === 'onchain')) {
    return { level: 'onchain', title: 'Fully on-chain', detail: 'The metadata and image bytes live in Solana account data. No server can change or remove them.' };
  }
  if (layers.includes('onchain')) {
    return { level: 'hybrid', title: 'Partly on-chain', detail: 'Some of this token is stored on Solana, the rest is fetched from elsewhere.' };
  }
  if (!layers.length) {
    return { level: 'none', title: 'No media', detail: 'This token has name and symbol only, with no metadata URI or image.' };
  }
  if (layers.every((w) => w === 'permaweb' || w === 'ipfs')) {
    return { level: 'offchain', title: 'Stored off-chain', detail: 'The image is hosted on decentralized storage, not on Solana. The token only stores a link.' };
  }
  return { level: 'offchain', title: 'Hosted off-chain', detail: 'The image is served from a regular web server that its owner can change or take down at any time.' };
}

function readBorshString(bytes, offset) {
  const length = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  const start = offset + 4;
  const value = new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0+$/, '');
  return { value, next: start + length };
}

export function decodeMetaplexMetadata(bytes) {
  let offset = 1 + 32 + 32;
  const name = readBorshString(bytes, offset);
  const symbol = readBorshString(bytes, name.next);
  const uri = readBorshString(bytes, symbol.next);
  return { name: name.value.trim(), symbol: symbol.value.trim(), uri: uri.value.trim() };
}

async function metaplexMetadata(mint, networkId) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: METAPLEX_METADATA_PROGRAM,
    seeds: ['metadata', getAddressEncoder().encode(METAPLEX_METADATA_PROGRAM), getAddressEncoder().encode(mint)],
  });
  const account = await getAccountBase64(pda, { networkId });
  if (!account) return null;
  return { address: pda, ...decodeMetaplexMetadata(base64ToBytes(account.data[0])) };
}

async function loadJson(uri) {
  if (!uri) return { json: null };
  if (uri.startsWith('data:')) {
    const parsed = classifyText(uri);
    return { json: parsed.json ?? null, inline: true, size: parsed.size };
  }
  const url = resolveUri(uri);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { json: null, error: `Metadata host answered HTTP ${response.status}.` };
    return { json: await response.json() };
  } catch (error) {
    return { json: null, error: error.name === 'AbortError' ? 'Metadata host timed out.' : 'Metadata host is unreachable from the browser.' };
  }
}

function tokenExtensions(parsed) {
  return parsed?.info?.extensions || [];
}

function extension(parsed, name) {
  return tokenExtensions(parsed).find((ext) => ext.extension === name)?.state;
}

async function inspectMint(address, account, networkId) {
  const parsed = account.data.parsed;
  const info = parsed.info;
  const program = account.owner === TOKEN_2022_PROGRAM ? 'Token-2022' : 'SPL Token';
  const onMint = extension(parsed, 'tokenMetadata');
  const pointer = extension(parsed, 'metadataPointer');
  const metaplex = onMint ? null : await metaplexMetadata(address, networkId).catch(() => null);

  const source = onMint ? 'Token-2022 metadata stored in the mint account' : metaplex ? 'Metaplex metadata account' : null;
  const name = onMint?.name ?? metaplex?.name ?? '';
  const symbol = onMint?.symbol ?? metaplex?.symbol ?? '';
  const uri = onMint?.uri ?? metaplex?.uri ?? '';
  const additional = Object.fromEntries((onMint?.additionalMetadata || []).map(([k, v]) => [k, v]));

  const { json, error: jsonError, inline } = await loadJson(uri);
  const imageUri = additional.image || (typeof json?.image === 'string' ? json.image : '') || '';
  const image = imageUri.startsWith('data:') ? classifyText(imageUri) : null;

  const payloads = [];
  if (image) payloads.push({ ...image, origin: { type: 'metadata', label: additional.image ? 'image field in mint account' : 'image inside on-chain JSON' } });
  if (json) payloads.push({ ...classifyText(JSON.stringify(json, null, 2)), origin: { type: 'metadata', label: inline ? 'metadata JSON stored on-chain' : 'metadata JSON (fetched)' } });

  const agent = json?.p === PROTOCOL && json?.t === 'agent' ? json : additional['spl404.type'] === 'agent' ? { ...json, ...additional } : null;

  return {
    kind: 'mint',
    address,
    networkId,
    program,
    lamports: account.lamports,
    space: account.space,
    decimals: info.decimals,
    supply: info.supply,
    mintAuthority: info.mintAuthority,
    freezeAuthority: info.freezeAuthority,
    updateAuthority: onMint?.updateAuthority ?? null,
    metadataPointer: pointer?.metadataAddress ?? null,
    metadataSource: source,
    name,
    symbol,
    uri,
    json,
    jsonError,
    description: typeof json?.description === 'string' ? json.description : additional.description || '',
    imageUri,
    imageUrl: image?.url || (imageUri ? resolveUri(imageUri) : null),
    additional,
    agent,
    verdict: verdictFor({ metadataUri: uri, imageUri }),
    storage: { metadata: storageOf(uri), image: storageOf(imageUri) },
    payloads,
  };
}

async function findAccount(address, preferred) {
  const order = [preferred, ...Object.keys(NETWORKS).filter((id) => id !== preferred)];
  for (const networkId of order) {
    const account = await getAccount(address, { networkId });
    if (account) return { account, networkId };
  }
  return { account: null, networkId: preferred };
}

export async function inspectAddress(address, { networkId = getSettings().network } = {}) {
  const found = await findAccount(address, networkId);
  const { account } = found;
  if (!account) {
    return { kind: 'empty', address, networkId, movedNetwork: false, detail: 'No account exists at this address on mainnet or devnet.' };
  }
  const moved = found.networkId !== networkId;
  const parsedType = account.data?.parsed?.type;

  if ((account.owner === TOKEN_PROGRAM || account.owner === TOKEN_2022_PROGRAM) && parsedType === 'mint') {
    return { ...(await inspectMint(address, account, found.networkId)), movedNetwork: moved };
  }

  if (account.executable) {
    return { kind: 'program', address, networkId: found.networkId, movedNetwork: moved, owner: account.owner, lamports: account.lamports, space: account.space };
  }

  if (account.owner === '11111111111111111111111111111111' && account.space === 0) {
    const history = await getSignaturesForAddress(address, { limit: 30 }, { networkId: found.networkId }).catch(() => []);
    return { kind: 'wallet', address, networkId: found.networkId, movedNetwork: moved, lamports: account.lamports, history };
  }

  const raw = Array.isArray(account.data) ? base64ToBytes(account.data[0]) : null;
  const rawAccount = raw ? null : await getAccountBase64(address, { networkId: found.networkId });
  const bytes = raw || (rawAccount ? base64ToBytes(rawAccount.data[0]) : new Uint8Array());
  const dataUri = parseDataUri(new TextDecoder().decode(bytes));
  return {
    kind: 'account',
    address,
    networkId: found.networkId,
    movedNetwork: moved,
    owner: account.owner,
    lamports: account.lamports,
    space: account.space ?? bytes.length,
    parsedType,
    payloads: (dataUri ? [classifyText(new TextDecoder().decode(bytes))] : scanBytes(bytes, { minText: 32 })).map((p) => ({ ...p, origin: { type: 'account', label: 'account data' } })),
  };
}
