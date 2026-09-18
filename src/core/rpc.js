import { NETWORKS, getSettings, network } from './config.js';

const FALLBACKS = {
  mainnet: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
  devnet: ['https://api.devnet.solana.com', 'https://solana-devnet.publicnode.com'],
};

let requestId = 0;

export class RpcError extends Error {
  constructor(message, { code, data, retryable = false } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.retryable = retryable;
  }
}

function endpointsFor(networkId) {
  const primary = network(networkId).rpc;
  return [primary, ...(FALLBACKS[networkId] || [])].filter((url, i, all) => all.indexOf(url) === i);
}

async function post(url, body, signal) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new RpcError(`Could not reach ${new URL(url).host}.`, { retryable: true });
  }
  if (response.status === 429 || response.status === 403 || response.status >= 500) {
    throw new RpcError(`${new URL(url).host} answered HTTP ${response.status}.`, { retryable: true });
  }
  if (!response.ok) throw new RpcError(`RPC answered HTTP ${response.status}.`);
  return response.json();
}

/**
 * JSON-RPC call with ordered failover. Reads retry on the next endpoint when one is
 * rate-limited or unreachable; application errors (bad params, tx errors) surface immediately.
 */
export async function rpc(method, params = [], { networkId = getSettings().network, signal, failover = true } = {}) {
  const endpoints = failover ? endpointsFor(networkId) : [network(networkId).rpc];
  let lastError;
  for (const url of endpoints) {
    try {
      const payload = await post(url, { jsonrpc: '2.0', id: ++requestId, method, params }, signal);
      if (payload.error) {
        const retryable = payload.error.code === 429 || payload.error.code === 403 || /rate|forbidden|limit/i.test(payload.error.message || '');
        const error = new RpcError(payload.error.message || 'RPC request failed.', { code: payload.error.code, data: payload.error.data, retryable });
        if (retryable) {
          lastError = error;
          continue;
        }
        throw error;
      }
      return payload.result;
    } catch (error) {
      if (error instanceof RpcError && error.retryable) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError || new RpcError('Every RPC endpoint failed.');
}

export function getTransaction(signature, opts) {
  return rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], opts);
}

export function getRawTransaction(signature, opts) {
  return rpc('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], opts);
}

export function getAccount(address, opts) {
  return rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }], opts).then((r) => r.value);
}

export function getAccountBase64(address, opts) {
  return rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }], opts).then((r) => r.value);
}

export function getBalance(address, opts) {
  return rpc('getBalance', [address, { commitment: 'confirmed' }], opts).then((r) => r.value);
}

export function getSignaturesForAddress(address, config = {}, opts) {
  return rpc('getSignaturesForAddress', [address, { limit: 25, commitment: 'confirmed', ...config }], opts);
}

export function getLatestBlockhash(opts) {
  return rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], opts).then((r) => r.value);
}

export function getMinimumBalanceForRentExemption(size, opts) {
  return rpc('getMinimumBalanceForRentExemption', [size], opts);
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export { NETWORKS };
