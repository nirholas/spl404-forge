import { compileTransaction, createNoopSigner } from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import { TX_LIMIT } from './config.js';
import { byteLength, utf8Bytes } from './payload.js';
import { manifestCapacity, manifestJson, planChunks, sha256Hex } from './protocol.js';
import { registryAddress } from './registry.js';
import { buildMessage, estimateFeeLamports, freshBlockhash, memoBudget, priorityMicroLamports, sendAndConfirm, signBatch, simulateBudget } from './tx.js';

/** A zero-lamport transfer to the index address; it carries no value and only marks the transaction. */
async function indexInstruction(feePayer) {
  return getTransferSolInstruction({ source: createNoopSigner(feePayer), destination: await registryAddress(), amount: 0n });
}

function memoInstructions(memo, extras = []) {
  return [getAddMemoInstruction({ memo }), ...extras];
}

function versionFor(signer) {
  return signer?.supportsV1 ? 1 : 'legacy';
}

/**
 * Works out how the payload will be written before anything is signed: one memo when
 * it fits, otherwise chunk memos plus a manifest memo that lists their signatures.
 *
 * Returns the exact transaction count, byte budget, and any reason it cannot be sent,
 * so the UI can show the real plan rather than an optimistic guess.
 */
export async function planInscription({ signer, bytes, name, mime, list }) {
  const version = versionFor(signer);
  const feePayer = signer.address;
  const extras = list ? [await indexInstruction(feePayer)] : [];
  const budget = memoBudget({ version, feePayer, makeInstructions: (memo) => memoInstructions(memo, extras) });
  const size = bytes.length;

  if (size === 0) return { version, budget, kind: 'empty', transactions: 0, problem: 'Nothing to write yet.' };

  if (size <= budget) {
    return { version, budget, kind: 'single', transactions: 1, chunkCount: 0, size, memoBytes: size, name, mime };
  }

  // Chunk memos carry no index tag; only the manifest does, so it is sized separately.
  const chunkBudget = memoBudget({ version, feePayer, makeInstructions: (memo) => memoInstructions(memo) });
  const plan = planChunks(bytes, chunkBudget);
  const manifestBudget = budget;
  const capacity = manifestCapacity(manifestBudget, { name, mime });
  if (plan.memos.length > capacity) {
    return {
      version,
      budget,
      kind: 'chunked',
      transactions: plan.memos.length + 1,
      chunkCount: plan.memos.length,
      size,
      problem: `This file needs ${plan.memos.length} chunks but a ${version === 1 ? 'v1' : 'legacy'} manifest can list ${capacity}. Choose a smaller file${version === 1 ? '' : ', or connect a wallet that supports transaction v1'}.`,
    };
  }
  return { version, budget, kind: 'chunked', transactions: plan.memos.length + 1, chunkCount: plan.memos.length, size, hash: plan.hash, fileId: plan.fileId, memos: plan.memos, name, mime };
}

export async function estimateCost(plan, { signer }) {
  const microLamports = await priorityMicroLamports([signer.address]);
  return {
    microLamports,
    lamports: estimateFeeLamports({ transactions: plan.transactions, signaturesPerTx: 1, microLamports, computeUnitLimit: 40_000 }),
  };
}

async function buildAndSend({ signer, memos, extrasFor, budgetHint, onProgress }) {
  const version = versionFor(signer);
  const feePayer = signer.address;
  const { blockhash, lastValidBlockHeight } = await freshBlockhash();
  const microLamports = await priorityMicroLamports([feePayer]);

  const instructionSets = [];
  for (let index = 0; index < memos.length; index += 1) {
    instructionSets.push(memoInstructions(memos[index], await extrasFor(index)));
  }

  // One simulation sizes the whole batch: every transaction in it has the same shape.
  let budget = budgetHint;
  if (!budget) {
    budget = await simulateBudget({ version, feePayer, instructions: instructionSets[0] }).catch(() => ({ computeUnitLimit: 40_000 }));
  }
  const resources = {
    computeUnitLimit: budget.computeUnitLimit,
    loadedAccountsDataSizeLimit: budget.loadedAccountsDataSizeLimit,
    microLamports,
  };

  const transactions = instructionSets.map((instructions) => {
    const message = buildMessage({ version, feePayer, instructions, blockhash: { blockhash, lastValidBlockHeight }, budget: resources });
    const compiled = compileTransaction(message);
    const size = compiled.messageBytes.length + 1 + 64 * Object.keys(compiled.signatures).length;
    if (size > TX_LIMIT[version]) throw new Error('A transaction came out larger than the network allows. Reduce the content size.');
    return compiled;
  });

  const signed = await signBatch(signer, transactions);
  const signatures = [];
  for (const [index, transaction] of signed.entries()) {
    onProgress?.({ index, total: signed.length, stage: 'sending' });
    signatures.push(await sendAndConfirm(transaction, { lastValidBlockHeight }));
    onProgress?.({ index, total: signed.length, stage: 'confirmed', signature: signatures[index] });
  }
  return { signatures, budget: resources };
}

/**
 * Writes the payload. A single memo is one transaction. A chunked file writes every
 * chunk first, then one manifest naming their signatures, because the manifest cannot
 * exist until the chunks have landed. Chunk signatures are returned even when the
 * manifest step fails, so nothing already paid for is lost.
 */
export async function inscribe({ signer, bytes, text, name, mime, list, onProgress }) {
  const plan = await planInscription({ signer, bytes, name, mime, list });
  if (plan.problem) throw new Error(plan.problem);
  const extrasFor = async () => (list ? [await indexInstruction(signer.address)] : []);

  if (plan.kind === 'single') {
    const memo = text ?? new TextDecoder().decode(bytes);
    const { signatures } = await buildAndSend({ signer, memos: [memo], extrasFor, onProgress });
    return { kind: 'single', hash: sha256Hex(bytes), signatures, primary: signatures[0], plan };
  }

  let chunkSignatures = [];
  try {
    const result = await buildAndSend({
      signer,
      memos: plan.memos,
      extrasFor: async () => [],
      onProgress: (event) => onProgress?.({ ...event, phase: 'chunks' }),
    });
    chunkSignatures = result.signatures;
    const manifest = manifestJson({ name: plan.name, mime: plan.mime, size: plan.size, hash: plan.hash, chunks: chunkSignatures });
    const manifestResult = await buildAndSend({
      signer,
      memos: [manifest],
      extrasFor,
      onProgress: (event) => onProgress?.({ ...event, phase: 'manifest' }),
    });
    return { kind: 'chunked', hash: plan.hash, signatures: [...chunkSignatures, manifestResult.signatures[0]], chunkSignatures, primary: manifestResult.signatures[0], plan };
  } catch (error) {
    error.chunkSignatures = chunkSignatures;
    throw error;
  }
}

export function payloadFromText(text) {
  return { bytes: utf8Bytes(text), text, size: byteLength(text) };
}
