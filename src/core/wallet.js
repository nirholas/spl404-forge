import { getWallets } from '@wallet-standard/app';
import { getBase58Decoder, getBase58Encoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getSettings, network } from './config.js';
import { explainWalletError } from './tx.js';

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const EVENTS = 'standard:events';
const SIGN_TX = 'solana:signTransaction';
const SIGN_MESSAGE = 'solana:signMessage';
const SIGN_IN = 'solana:signIn';
const LAST_WALLET = 'spl404.wallet.last';
const SESSION_PROOF = 'spl404.wallet.proof';

const txEncoder = getTransactionEncoder();
const txDecoder = getTransactionDecoder();
const b58 = getBase58Decoder();
const b58bytes = getBase58Encoder();

let registry;
const listeners = new Set();
let state = { wallets: [], wallet: null, account: null, proof: null };
let offWalletEvents = null;

function emit() {
  listeners.forEach((fn) => fn(state));
}

function setState(patch) {
  state = { ...state, ...patch };
  emit();
}

export function onWalletChange(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function walletState() {
  return state;
}

function isSolanaWallet(wallet) {
  return wallet.chains.some((chain) => chain.startsWith('solana:')) && CONNECT in wallet.features && SIGN_TX in wallet.features;
}

export function supportedVersions(wallet) {
  const versions = new Set();
  for (const name of ['solana:signAndSendTransaction', SIGN_TX]) {
    for (const v of wallet?.features?.[name]?.supportedTransactionVersions ?? []) versions.add(String(v));
  }
  return versions;
}

function refreshList() {
  const wallets = registry.get().filter(isSolanaWallet);
  setState({ wallets });
}

export function initWallets() {
  if (registry) return;
  registry = getWallets();
  refreshList();
  registry.on('register', () => {
    refreshList();
    autoReconnect();
  });
  registry.on('unregister', refreshList);
  autoReconnect();
}

let reconnecting = false;
async function autoReconnect() {
  if (state.account || reconnecting) return;
  let last;
  try {
    last = localStorage.getItem(LAST_WALLET);
  } catch {
    return;
  }
  const wallet = last && state.wallets.find((w) => w.name === last);
  if (!wallet) return;
  reconnecting = true;
  try {
    await connect(wallet, { silent: true });
  } catch {
    /* silent reconnect is best-effort: the user can connect manually */
  } finally {
    reconnecting = false;
  }
}

function loadProof(address) {
  try {
    const proof = JSON.parse(localStorage.getItem(SESSION_PROOF) || 'null');
    return proof?.address === address && proof.expiresAt > Date.now() ? proof : null;
  } catch {
    return null;
  }
}

export async function connect(wallet, { silent = false } = {}) {
  const { accounts } = await wallet.features[CONNECT].connect(silent ? { silent: true } : undefined);
  const account = accounts.find((a) => a.chains?.some((c) => c.startsWith('solana:'))) || accounts[0];
  if (!account) throw new Error(`${wallet.name} did not share an account.`);
  offWalletEvents?.();
  offWalletEvents = wallet.features[EVENTS]?.on('change', ({ accounts: next }) => {
    if (!next) return;
    if (!next.length) return disconnect();
    setState({ account: next[0], proof: loadProof(next[0].address) });
  });
  try {
    localStorage.setItem(LAST_WALLET, wallet.name);
  } catch {
    /* storage unavailable: auto-reconnect simply won't happen next visit */
  }
  setState({ wallet, account, proof: loadProof(account.address) });
  return account;
}

export async function disconnect() {
  const { wallet } = state;
  offWalletEvents?.();
  offWalletEvents = null;
  try {
    localStorage.removeItem(LAST_WALLET);
    localStorage.removeItem(SESSION_PROOF);
  } catch {
    /* nothing persisted */
  }
  setState({ wallet: null, account: null, proof: null });
  await wallet?.features[DISCONNECT]?.disconnect().catch(() => {});
}

function siwsMessage({ domain, address, statement, uri, nonce, issuedAt, expirationTime, chainId }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n');
}

/**
 * Sign-In With Solana. Uses the wallet's native solana:signIn when present, otherwise a
 * standard SIWS message through solana:signMessage. The signature is verified locally
 * against the account's public key before the session is trusted.
 */
export async function signIn() {
  const { wallet, account } = state;
  if (!wallet || !account) throw new Error('Connect a wallet first.');
  const nonce = b58.decode(crypto.getRandomValues(new Uint8Array(12)));
  const issuedAt = new Date().toISOString();
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
  const input = {
    domain: location.host,
    address: account.address,
    statement: 'Sign in to SPL404 Forge. This request does not trigger a transaction or cost any SOL.',
    uri: location.origin,
    version: '1',
    chainId: getSettings().network,
    nonce,
    issuedAt,
    expirationTime: new Date(expiresAt).toISOString(),
  };

  let signedMessage;
  let signature;
  try {
    if (wallet.features[SIGN_IN]) {
      const [output] = await wallet.features[SIGN_IN].signIn(input);
      signedMessage = output.signedMessage;
      signature = output.signature;
    } else if (wallet.features[SIGN_MESSAGE]) {
      signedMessage = new TextEncoder().encode(siwsMessage(input));
      const [output] = await wallet.features[SIGN_MESSAGE].signMessage({ account, message: signedMessage });
      signature = output.signature;
    } else {
      throw new Error(`${wallet.name} cannot sign messages.`);
    }
  } catch (error) {
    throw new Error(explainWalletError(error));
  }

  const valid = ed25519.verify(signature, signedMessage, b58bytes.encode(account.address));
  if (!valid) throw new Error('The wallet returned a signature that does not match this account.');
  const text = new TextDecoder().decode(signedMessage);
  if (!text.includes(nonce)) throw new Error('The signed message does not contain the sign-in challenge.');

  const proof = { address: account.address, message: text, signature: b58.decode(signature), expiresAt, wallet: wallet.name };
  try {
    localStorage.setItem(SESSION_PROOF, JSON.stringify(proof));
  } catch {
    /* proof stays in memory for this tab */
  }
  setState({ proof });
  return proof;
}

/** Adapts the connected Wallet Standard wallet to the signer shape used by every flow. */
export function walletSigner() {
  const { wallet, account } = state;
  if (!wallet || !account) return null;
  const versions = supportedVersions(wallet);
  return {
    kind: 'wallet',
    name: wallet.name,
    icon: wallet.icon,
    address: account.address,
    supportsV1: versions.has('1'),
    async signTransactions(transactions) {
      const chain = network().chain;
      const inputs = transactions.map((tx) => ({ account, chain, transaction: new Uint8Array(txEncoder.encode(tx)) }));
      let outputs;
      try {
        outputs = await wallet.features[SIGN_TX].signTransaction(...inputs);
      } catch (error) {
        throw new Error(explainWalletError(error));
      }
      return outputs.map((output) => txDecoder.decode(output.signedTransaction));
    },
  };
}
