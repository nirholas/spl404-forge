import { getBase58Encoder } from '@solana/kit';
import { COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAMS, NETWORKS, TX_LIMIT, getSettings } from './config.js';
import { base64ToBytes, byteLength, classifyText, findEmbeddedDataUris } from './payload.js';
import { parseChunkMemo, parseManifest, reassemble } from './protocol.js';
import { registryAddress } from './registry.js';
import { getRawTransaction, getSignaturesForAddress, getTransaction, mapLimit } from './rpc.js';
import { scanBytes } from './scan.js';
import { classifyBytes } from './payload.js';

const base58 = getBase58Encoder();

function programIdOf(ix, accountKeys) {
  if (ix.programId) return String(ix.programId);
  if (typeof ix.programIdIndex === 'number') return accountKeys[ix.programIdIndex]?.pubkey;
  return undefined;
}

function memoText(ix) {
  if (typeof ix.parsed === 'string') return ix.parsed;
  if (typeof ix.parsed?.memo === 'string') return ix.parsed.memo;
  if (typeof ix.data === 'string') {
    try {
      return new TextDecoder().decode(base58.encode(ix.data));
    } catch {
      return null;
    }
  }
  return null;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function flattenInstructions(tx) {
  const keys = tx.transaction.message.accountKeys || [];
  const outer = (tx.transaction.message.instructions || []).map((ix, i) => ({ ix, path: `#${i + 1}`, depth: 0, outerIndex: i }));
  const inner = (tx.meta?.innerInstructions || []).flatMap((group) =>
    group.instructions.map((ix, j) => ({ ix, path: `#${group.index + 1}.${j + 1}`, depth: 1, outerIndex: group.index })),
  );
  const ordered = [];
  outer.forEach((entry) => {
    ordered.push(entry);
    inner.filter((child) => child.outerIndex === entry.outerIndex).forEach((child) => ordered.push(child));
  });
  return ordered.map((entry) => ({ ...entry, programId: programIdOf(entry.ix, keys) }));
}

function describe(ix, programId) {
  if (MEMO_PROGRAMS.has(programId) || ix.program === 'spl-memo') return { program: 'Memo', type: 'memo' };
  if (ix.parsed && typeof ix.parsed === 'object') {
    return { program: prettyProgram(ix.program || programId), type: ix.parsed.type || 'instruction', info: ix.parsed.info };
  }
  if (programId === COMPUTE_BUDGET_PROGRAM) return { program: 'Compute Budget', type: 'budget' };
  return { program: ix.program ? prettyProgram(ix.program) : programId, type: 'raw' };
}

function prettyProgram(name = '') {
  const map = {
    system: 'System', 'spl-token': 'Token', 'spl-token-2022': 'Token-2022', 'spl-associated-token-account': 'Associated Token',
    'spl-memo': 'Memo', 'address-lookup-table': 'Lookup Table', vote: 'Vote', stake: 'Stake', 'bpf-upgradeable-loader': 'Loader',
  };
  return map[name] || name;
}

function readBudget(tx) {
  const config = tx.transaction.message.transactionConfig;
  if (config) {
    return {
      computeUnitLimit: config.computeUnitLimit ?? null,
      priorityFeeLamports: config.priorityFee ?? config.priorityFeeLamports ?? null,
      loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit ?? null,
      heapSize: config.heapSize ?? null,
    };
  }
  return null;
}

async function findTransactionAnyNetwork(signature, preferred) {
  const order = [preferred, ...Object.keys(NETWORKS).filter((id) => id !== preferred)];
  for (const networkId of order) {
    const tx = await getTransaction(signature, { networkId });
    if (tx) return { tx, networkId };
  }
  return { tx: null, networkId: preferred };
}

export async function inspectTransaction(signature, { networkId = getSettings().network } = {}) {
  const found = await findTransactionAnyNetwork(signature, networkId);
  if (!found.tx) {
    const error = new Error('Transaction not found on mainnet or devnet. It may still be processing, or it was never confirmed.');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const { tx } = found;
  const raw = await getRawTransaction(signature, { networkId: found.networkId }).catch(() => null);
  const wireSize = raw?.transaction?.[0] ? base64ToBytes(raw.transaction[0]).length : null;
  const version = tx.version === undefined ? 'legacy' : tx.version;
  const registry = await registryAddress();

  const instructions = flattenInstructions(tx);
  const payloads = [];
  const memoTexts = [];
  const seen = new Set();
  const addPayload = (payload, origin) => {
    const key = `${payload.kind}:${payload.size}:${payload.text?.slice(0, 64) ?? payload.mime}`;
    if (seen.has(key)) return;
    seen.add(key);
    payloads.push({ ...payload, origin });
  };

  const described = instructions.map((entry) => {
    const meta = describe(entry.ix, entry.programId);
    if (meta.type === 'memo') {
      const text = memoText(entry.ix);
      if (text !== null) {
        memoTexts.push(text);
        const chunk = parseChunkMemo(text);
        const payload = chunk
          ? { ...classifyBytes(chunk.bytes), chunk: { fileId: chunk.fileId, index: chunk.index, total: chunk.total } }
          : classifyText(text);
        addPayload(payload, { type: 'memo', label: `Memo ${entry.path}`, path: entry.path });
        meta.summary = `${byteLength(text).toLocaleString()} bytes`;
      }
    } else if (meta.type === 'raw' && typeof entry.ix.data === 'string' && entry.ix.data.length > 60) {
      try {
        const bytes = base58.encode(entry.ix.data);
        meta.summary = `${bytes.length.toLocaleString()} bytes of data`;
        scanBytes(bytes).forEach((payload) => addPayload(payload, { type: 'instruction', label: `Instruction ${entry.path} data`, path: entry.path }));
      } catch {
        /* undecodable instruction data: still listed, just not scanned */
      }
    } else if (meta.info) {
      collectStrings(meta.info)
        .filter((s) => s.length > 32)
        .flatMap((s) => findEmbeddedDataUris(s))
        .forEach((payload) => addPayload(payload, { type: 'instruction', label: `${meta.program} ${meta.type} ${entry.path}`, path: entry.path }));
      if (meta.type === 'transfer' && meta.info?.destination === registry) meta.summary = 'SPL404 public index tag';
    }
    return { path: entry.path, depth: entry.depth, programId: entry.programId, ...meta, info: undefined };
  });

  (tx.meta?.logMessages || []).forEach((line) => {
    if (line.length < 64) return;
    findEmbeddedDataUris(line).forEach((payload) => addPayload(payload, { type: 'log', label: 'Program log' }));
  });

  const manifests = memoTexts
    .map((text) => {
      try {
        return parseManifest(JSON.parse(text));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const keys = tx.transaction.message.accountKeys || [];
  const mints = new Set();
  instructions.forEach(({ ix }) => {
    const info = ix.parsed?.info;
    if (info?.mint) mints.add(info.mint);
  });
  (tx.meta?.postTokenBalances || []).forEach((balance) => mints.add(balance.mint));

  return {
    signature,
    networkId: found.networkId,
    movedNetwork: found.networkId !== networkId,
    slot: tx.slot,
    blockTime: tx.blockTime,
    success: !tx.meta?.err,
    error: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
    version,
    wireSize,
    sizeLimit: version === 1 ? TX_LIMIT[1] : TX_LIMIT.legacy,
    fee: tx.meta?.fee ?? null,
    computeUnits: tx.meta?.computeUnitsConsumed ?? null,
    budget: readBudget(tx),
    feePayer: keys[0]?.pubkey,
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    instructions: described,
    payloads,
    manifests,
    mints: [...mints],
    listed: described.some((ix) => ix.summary === 'SPL404 public index tag'),
    logs: tx.meta?.logMessages || [],
  };
}

/** Fetches every chunk listed by a manifest, rebuilds the file, and verifies its hash. */
export async function resolveManifest(manifest, { networkId, onProgress } = {}) {
  let done = 0;
  const results = await mapLimit(manifest.chunks, 4, async (signature) => {
    const tx = await getTransaction(signature, { networkId });
    onProgress?.(++done, manifest.chunks.length);
    if (!tx) return null;
    const memo = flattenInstructions(tx)
      .filter((entry) => MEMO_PROGRAMS.has(entry.programId) || entry.ix.program === 'spl-memo')
      .map((entry) => memoText(entry.ix))
      .find((text) => text && parseChunkMemo(text));
    return memo || null;
  });
  const memos = results.map((r) => (r.ok ? r.value : null));
  const rebuilt = reassemble(manifest, memos);
  const payload = classifyBytes(rebuilt.bytes);
  if (payload.kind === 'binary' || payload.mime !== manifest.mime) {
    Object.assign(payload, { mime: manifest.mime });
  }
  return { ...rebuilt, payload };
}

/** A chunk only knows its file id; the manifest is written later by the same signer. */
export async function findManifestForChunk(signature, feePayer, { networkId } = {}) {
  const newer = await getSignaturesForAddress(feePayer, { limit: 60, until: signature }, { networkId });
  const candidates = newer.filter((entry) => !entry.err).map((entry) => entry.signature).reverse();
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = await mapLimit(candidates.slice(i, i + 4), 4, (sig) => getTransaction(sig, { networkId }));
    for (const result of batch) {
      if (!result.ok || !result.value) continue;
      for (const entry of flattenInstructions(result.value)) {
        if (!(MEMO_PROGRAMS.has(entry.programId) || entry.ix.program === 'spl-memo')) continue;
        const text = memoText(entry.ix);
        try {
          const manifest = parseManifest(JSON.parse(text));
          if (manifest?.chunks.includes(signature)) return { manifest, signature: result.value.transaction.signatures[0] };
        } catch {
          /* not a manifest memo */
        }
      }
    }
  }
  return null;
}
