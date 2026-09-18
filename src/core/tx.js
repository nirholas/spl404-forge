import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionSize,
  partiallySignTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { TX_LIMIT, getSettings } from './config.js';
import { getLatestBlockhash, rpc } from './rpc.js';

export const MAX_COMPUTE_UNITS = 1_400_000;
export const MAX_LOADED_ACCOUNTS_BYTES = 64 * 1024 * 1024;

const PRIORITY_PERCENTILE = { economy: 0.25, standard: 0.5, fast: 0.8 };
const MIN_MICRO_LAMPORTS = { economy: 1_000, standard: 10_000, fast: 100_000 };

/**
 * Builds a message for either wire format. v1 carries its budget in TransactionConfig;
 * legacy carries it as ComputeBudget instructions. Callers never branch on version.
 */
export function buildMessage({ version, feePayer, instructions, blockhash, budget }) {
  const { computeUnitLimit, microLamports = 0, loadedAccountsDataSizeLimit } = budget;
  if (version === 1) {
    const priorityFeeLamports = BigInt(Math.ceil((microLamports * computeUnitLimit) / 1_000_000));
    return pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => setTransactionMessageConfig({ computeUnitLimit, priorityFeeLamports, loadedAccountsDataSizeLimit }, m),
    );
  }
  const budgetInstructions = [getSetComputeUnitLimitInstruction({ units: computeUnitLimit })];
  if (microLamports > 0) budgetInstructions.push(getSetComputeUnitPriceInstruction({ microLamports: BigInt(microLamports) }));
  return pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([...budgetInstructions, ...instructions], m),
  );
}

const PLACEHOLDER_BLOCKHASH = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n };
const SIZING_BUDGET = { computeUnitLimit: MAX_COMPUTE_UNITS, microLamports: 1_000_000, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_BYTES };

export function measure({ version, feePayer, instructions }) {
  const tx = compileTransaction(buildMessage({ version, feePayer, instructions, blockhash: PLACEHOLDER_BLOCKHASH, budget: SIZING_BUDGET }));
  return getTransactionSize(tx);
}

export function fits(args) {
  return measure(args) <= TX_LIMIT[args.version];
}

/** Largest memo (in bytes) that fits in one transaction next to the given extra instructions. */
export function memoBudget({ version, feePayer, makeInstructions }) {
  let low = 0;
  let high = TX_LIMIT[version];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits({ version, feePayer, instructions: makeInstructions('x'.repeat(mid)) })) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Greedily packs ordered instruction groups into as few transactions as possible.
 * A group is never split, so instructions that must be atomic stay together.
 */
export function packGroups({ version, feePayer, groups }) {
  const packed = [];
  let current = [];
  for (const group of groups) {
    const candidate = [...current, ...group];
    if (fits({ version, feePayer, instructions: candidate })) {
      current = candidate;
      continue;
    }
    if (!current.length) throw new Error('One step of this transaction is larger than the network allows. Reduce the content size.');
    packed.push(current);
    if (!fits({ version, feePayer, instructions: group })) throw new Error('One step of this transaction is larger than the network allows. Reduce the content size.');
    current = [...group];
  }
  if (current.length) packed.push(current);
  return packed;
}

export async function priorityMicroLamports(writableAccounts = [], level = getSettings().priority) {
  try {
    const fees = await rpc('getRecentPrioritizationFees', [writableAccounts.slice(0, 128)]);
    const values = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    const pick = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * (PRIORITY_PERCENTILE[level] ?? 0.5)))] : 0;
    const network = getSettings().network;
    const floor = network === 'mainnet' ? MIN_MICRO_LAMPORTS[level] ?? 10_000 : 0;
    return Math.min(Math.max(pick, floor), 5_000_000);
  } catch {
    return getSettings().network === 'mainnet' ? MIN_MICRO_LAMPORTS.standard : 0;
  }
}

/** Simulates without signatures to size compute and loaded-account budgets from reality. */
export async function simulateBudget({ version, feePayer, instructions }) {
  const message = buildMessage({ version, feePayer, instructions, blockhash: PLACEHOLDER_BLOCKHASH, budget: { ...SIZING_BUDGET, microLamports: 0 } });
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const result = await rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
  const value = result.value;
  if (value.err) {
    const error = new Error(explainError(value.err, value.logs));
    error.logs = value.logs;
    error.simulation = true;
    throw error;
  }
  return {
    computeUnitLimit: Math.min(MAX_COMPUTE_UNITS, Math.ceil((value.unitsConsumed || 0) * 1.2) + 2_000),
    loadedAccountsDataSizeLimit: value.loadedAccountsDataSize
      ? Math.min(MAX_LOADED_ACCOUNTS_BYTES, Math.ceil((value.loadedAccountsDataSize * 1.15) / 4096) * 4096 + 8192)
      : MAX_LOADED_ACCOUNTS_BYTES,
    logs: value.logs,
  };
}

export function explainError(err, logs = []) {
  const text = typeof err === 'string' ? err : JSON.stringify(err);
  const joined = `${text} ${(logs || []).join(' ')}`;
  if (/AccountNotFound|no record of a prior credit/i.test(joined)) return 'The paying account has no SOL on this network. Fund it and try again.';
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(joined)) return 'Not enough SOL to cover rent for the new account. Add a little more SOL and retry.';
  if (/insufficient lamports|InsufficientFunds/i.test(joined)) return 'Not enough SOL for this transaction and its fees.';
  if (/BlockhashNotFound|Blockhash not found/i.test(joined)) return 'The network moved on before the transaction landed. Please retry.';
  if (/already in use/i.test(joined)) return 'That address is already in use. Generate a fresh mint key and retry.';
  if (/exceeds? .*size|too large|TooLarge/i.test(joined)) return 'The transaction is larger than the network allows.';
  if (/invalid utf-?8|InvalidInstructionData/i.test(joined) && /Memo/i.test(joined)) return 'The memo program only accepts valid UTF-8 text.';
  if (/ComputationalBudgetExceeded|exceeded CUs/i.test(joined)) return 'The transaction ran out of compute. Retry to re-estimate.';
  return `Solana rejected the transaction: ${text}`;
}

export function explainWalletError(error) {
  const message = error?.message || String(error);
  if (/reject|denied|declined|cancel/i.test(message) || error?.code === 4001) return 'You declined the request in your wallet.';
  return message;
}

export async function freshBlockhash() {
  const value = await getLatestBlockhash();
  return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
}

/**
 * Signs a batch: the primary signer first (a wallet may rewrite the message, for example to add
 * a guard instruction), then any local keypairs such as a fresh mint. One wallet prompt per batch.
 */
export async function signBatch(signer, transactions, extraKeyPairs = []) {
  const signed = await signer.signTransactions(transactions);
  return Promise.all(
    signed.map((tx, i) => {
      const extras = extraKeyPairs[i] || [];
      return extras.length ? partiallySignTransaction(extras.map((s) => s.keyPair), tx) : tx;
    }),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends, rebroadcasts, and polls until confirmed, failed, or the blockhash expires. */
export async function sendAndConfirm(transaction, { lastValidBlockHeight, onSent } = {}) {
  const wire = getBase64EncodedWireTransaction(transaction);
  const signature = getSignatureFromTransaction(transaction);
  try {
    await rpc('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }], { failover: false });
  } catch (error) {
    const logs = error.data?.logs;
    throw Object.assign(new Error(explainError(error.data?.err || error.message, logs)), { logs, signature });
  }
  onSent?.(signature);
  const started = Date.now();
  let lastBroadcast = Date.now();
  while (true) {
    await sleep(1200);
    const statuses = await rpc('getSignatureStatuses', [[signature]], { failover: false }).catch(() => null);
    const status = statuses?.value?.[0];
    if (status?.err) throw Object.assign(new Error(explainError(status.err)), { signature });
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
    if (Date.now() - lastBroadcast > 3000) {
      lastBroadcast = Date.now();
      rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }], { failover: false }).catch(() => {});
    }
    if (Date.now() - started > 20_000 && lastValidBlockHeight) {
      const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }], { failover: false }).catch(() => null);
      if (height !== null && BigInt(height) > lastValidBlockHeight) {
        throw Object.assign(new Error('The transaction expired before it was confirmed. Nothing was charged. Please retry.'), { signature, expired: true });
      }
    }
    if (Date.now() - started > 150_000) throw Object.assign(new Error('Confirmation is taking unusually long. Check the explorer link before retrying.'), { signature });
  }
}

export function estimateFeeLamports({ transactions, signaturesPerTx = 1, microLamports, computeUnitLimit }) {
  const base = 5000 * signaturesPerTx;
  const priority = Math.ceil((microLamports * computeUnitLimit) / 1_000_000);
  return transactions * (base + priority);
}
