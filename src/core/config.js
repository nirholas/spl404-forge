export const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_V3 = 'Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH';
export const MEMO_PROGRAMS = new Set([MEMO_V1, MEMO_V2, MEMO_V3]);

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/** Wire-format ceilings. Legacy and v0 share 1,232 bytes; v1 (SIMD-0385) raises it to 4,096. */
export const TX_LIMIT = { legacy: 1232, 1: 4096 };

/** Protocol tag written into structured payloads and used to derive the public index address. */
export const PROTOCOL = 'spl404';
export const PROTOCOL_VERSION = 1;
export const REGISTRY_SEED = 'spl404-forge:registry';

export const NETWORKS = {
  mainnet: {
    id: 'mainnet',
    label: 'Mainnet',
    rpc: 'https://solana-rpc.publicnode.com',
    chain: 'solana:mainnet',
    explorerCluster: '',
  },
  devnet: {
    id: 'devnet',
    label: 'Devnet',
    rpc: 'https://api.devnet.solana.com',
    chain: 'solana:devnet',
    explorerCluster: 'devnet',
  },
};

const STORAGE_KEY = 'spl404.settings.v1';

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

const listeners = new Set();
let settings = {
  network: 'mainnet',
  customRpc: { mainnet: '', devnet: '' },
  priority: 'standard',
  listInGallery: true,
  blurGallery: true,
  ...readStored(),
};

const envRpc = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SOLANA_RPC_URL : undefined;
const envDevnetRpc = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SOLANA_DEVNET_RPC_URL : undefined;

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings stay in memory for this tab */
  }
  listeners.forEach((fn) => fn(settings));
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function network(id = settings.network) {
  const base = NETWORKS[id] || NETWORKS.mainnet;
  const envOverride = id === 'devnet' ? envDevnetRpc : envRpc;
  const rpc = settings.customRpc?.[base.id] || envOverride || base.rpc;
  return { ...base, rpc };
}

export function explorerTx(signature, id = settings.network) {
  const cluster = NETWORKS[id]?.explorerCluster;
  return `https://solscan.io/tx/${signature}${cluster ? `?cluster=${cluster}` : ''}`;
}

export function explorerAddress(address, id = settings.network) {
  const cluster = NETWORKS[id]?.explorerCluster;
  return `https://solscan.io/account/${address}${cluster ? `?cluster=${cluster}` : ''}`;
}
