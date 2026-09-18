import {
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  getBase58Decoder,
  getBase58Encoder,
  partiallySignTransaction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getSettings } from './config.js';
import { getBalance } from './rpc.js';
import { buildMessage, freshBlockhash, sendAndConfirm } from './tx.js';

const STORAGE_KEY = 'spl404.session.v1';
const b58 = getBase58Decoder();
const b58bytes = getBase58Encoder();

const listeners = new Set();
let current = null;

function storageKey() {
  return `${STORAGE_KEY}.${getSettings().network}`;
}

function emit() {
  listeners.forEach((fn) => fn(current));
}

export function onSessionChange(fn) {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

export function sessionState() {
  return current;
}

/** Accepts a Solana CLI JSON array, a base58 secret key (Phantom export), or raw 64 bytes. */
export function parseSecretKey(input) {
  if (input instanceof Uint8Array) return input;
  const text = String(input).trim();
  let bytes;
  if (text.startsWith('[')) {
    try {
      bytes = new Uint8Array(JSON.parse(text));
    } catch {
      throw new Error('That JSON is not a keypair byte array.');
    }
  } else {
    try {
      bytes = new Uint8Array(b58bytes.encode(text));
    } catch {
      throw new Error('That is not a base58 secret key.');
    }
  }
  if (bytes.length !== 64) throw new Error(`A Solana secret key is 64 bytes; this one is ${bytes.length}.`);
  return bytes;
}

async function signerFromSecret(secret, label) {
  const keyPairSigner = await createKeyPairSignerFromBytes(secret);
  return {
    kind: 'session',
    name: label || 'Session key',
    address: keyPairSigner.address,
    supportsV1: true,
    keyPairSigner,
    secret,
    async signTransactions(transactions) {
      return Promise.all(transactions.map((tx) => partiallySignTransaction([keyPairSigner.keyPair], tx)));
    },
  };
}

export async function restoreSession() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(storageKey()) || 'null');
  } catch {
    stored = null;
  }
  current = stored ? await signerFromSecret(new Uint8Array(b58bytes.encode(stored.secret)), stored.label).catch(() => null) : null;
  emit();
  return current;
}

export async function useSecretKey(secretInput, { label, remember = true } = {}) {
  const secret = parseSecretKey(secretInput);
  const signer = await signerFromSecret(secret, label);
  current = signer;
  if (remember) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ secret: b58.decode(secret), label: signer.name }));
    } catch {
      /* not remembered: the key lives for this tab only */
    }
  }
  emit();
  return signer;
}

export async function createSession({ label } = {}) {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32), 0);
  secret.set(publicKey, 32);
  return useSecretKey(secret, { label });
}

export function forgetSession() {
  try {
    localStorage.removeItem(storageKey());
  } catch {
    /* nothing stored */
  }
  current = null;
  emit();
}

export function exportSecret(signer = current) {
  if (!signer) return null;
  return { base58: b58.decode(signer.secret), json: JSON.stringify([...signer.secret]) };
}

export function sessionBalance(signer = current) {
  return signer ? getBalance(signer.address) : Promise.resolve(0);
}

/** Moves SOL from a wallet into the session key with a single legacy transfer any wallet can sign. */
export async function fundSession({ wallet, lamports, onSent }) {
  if (!current) throw new Error('Create a session key first.');
  const { blockhash, lastValidBlockHeight } = await freshBlockhash();
  const message = buildMessage({
    version: 'legacy',
    feePayer: wallet.address,
    blockhash: { blockhash, lastValidBlockHeight },
    budget: { computeUnitLimit: 2_000, microLamports: 0 },
    instructions: [getTransferSolInstruction({ source: createNoopSigner(wallet.address), destination: current.address, amount: BigInt(lamports) })],
  });
  const [signed] = await wallet.signTransactions([compileTransaction(message)]);
  return sendAndConfirm(signed, { lastValidBlockHeight, onSent });
}

/** Returns everything left in the session key to a destination, minus the network fee. */
export async function sweepSession({ destination, onSent }) {
  if (!current) throw new Error('No session key to sweep.');
  const balance = await getBalance(current.address);
  const fee = 5000;
  if (balance <= fee) throw new Error('The session key has nothing left to sweep.');
  // The account must end at exactly zero: anything between zero and rent-exempt is rejected.
  const { blockhash, lastValidBlockHeight } = await freshBlockhash();
  const message = buildMessage({
    version: 'legacy',
    feePayer: current.address,
    blockhash: { blockhash, lastValidBlockHeight },
    budget: { computeUnitLimit: 2_000, microLamports: 0 },
    instructions: [getTransferSolInstruction({ source: createNoopSigner(current.address), destination, amount: BigInt(balance - fee) })],
  });
  const [signed] = await current.signTransactions([compileTransaction(message)]);
  return sendAndConfirm(signed, { lastValidBlockHeight, onSent });
}
