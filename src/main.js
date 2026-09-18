import './styles/app.css';
import { getSettings, network, onSettingsChange, updateSettings } from './core/config.js';
import { inspectAddress } from './core/inspect-account.js';
import { inspectTransaction } from './core/inspect-tx.js';
import { parseTarget } from './core/input.js';
import { registryAddress } from './core/registry.js';
import { connect, disconnect, initWallets, onWalletChange, signIn, supportedVersions, walletSigner, walletState } from './core/wallet.js';
import { mountBackdrop } from './scene/backdrop.js';
import { clear, el, modal, shorten, statusNode, toast } from './ui/components/dom.js';
import { createFeed } from './ui/pages/feed.js';
import { createForge } from './ui/pages/forge.js';
import { renderAddress, renderTransaction, reportInspectError } from './ui/pages/inspect.js';

const $ = (id) => document.getElementById(id);

const elements = {
  networkSelect: $('network-select'),
  networkDot: $('network-dot'),
  walletButton: $('wallet-button'),
  settingsButton: $('settings-button'),
  rpcLabel: $('rpc-label'),
  inspectForm: $('inspect-form'),
  inspectInput: $('inspect-input'),
  inspectSubmit: $('inspect-submit'),
  inspectStatus: $('inspect-status'),
  inspectResult: $('inspect-result'),
  exampleButton: $('example-button'),
};

mountBackdrop($('scene'));
initWallets();

/* ---------------------------------------------------------------- wallet */

function walletLabel() {
  const { account, wallet } = walletState();
  return account ? `${wallet.name.split(' ')[0]} · ${shorten(account.address, 4, 4)}` : 'Connect wallet';
}

function openWalletModal() {
  const { wallets } = walletState();
  const body = wallets.length
    ? [
      el('div', { class: 'wallet-list' }, wallets.map((wallet) => {
        const versions = supportedVersions(wallet);
        return el('button', {
          class: 'wallet-option',
          type: 'button',
          onClick: async () => {
            dialog.close();
            try {
              await connect(wallet);
              toast(`${wallet.name} connected.`, 'good');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        }, [
          wallet.icon ? el('img', { src: wallet.icon, alt: '' }) : el('span', { class: 'chip', text: wallet.name.slice(0, 2) }),
          el('div', {}, [
            el('strong', { text: wallet.name }),
            el('small', { text: versions.has('1') ? 'supports transaction v1 · up to 4 KB per write' : 'legacy transactions only' }),
          ]),
        ]);
      })),
      el('p', { class: 'faint', style: 'font-size:11px', text: 'Keys never reach this page. Every transaction is shown by your wallet before it is signed.' }),
    ]
    : [el('div', { class: 'empty', text: 'No Solana wallet was detected. Install or unlock a Wallet Standard wallet, then reopen this dialog.' })];

  const dialog = modal({ title: 'Connect a wallet', subtitle: 'Wallet Standard, non-custodial', body });
}

function openAccountModal() {
  const { account, wallet, proof } = walletState();
  const dialog = modal({
    title: wallet.name,
    subtitle: account.address,
    body: [
      el('div', { class: 'chips' }, [
        el('span', { class: `chip${supportedVersions(wallet).has('1') ? ' good' : ' warn'}`, text: supportedVersions(wallet).has('1') ? 'transaction v1 ready' : 'legacy only' }),
        proof && el('span', { class: 'chip good', text: 'signed in' }),
      ]),
      !proof && el('button', {
        class: 'secondary full',
        type: 'button',
        text: 'Sign in with Solana',
        onClick: async () => {
          try {
            await signIn();
            toast('Signed in. The signature was verified locally.', 'good');
            dialog.close();
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }),
      el('button', {
        class: 'ghost full',
        type: 'button',
        text: 'Disconnect',
        onClick: async () => {
          await disconnect();
          dialog.close();
          toast('Wallet disconnected.');
        },
      }),
    ],
  });
}

elements.walletButton.addEventListener('click', () => {
  if (walletState().account) openAccountModal();
  else openWalletModal();
});

/* -------------------------------------------------------------- settings */

function applySettings() {
  const settings = getSettings();
  const active = network();
  elements.networkSelect.value = settings.network;
  elements.networkDot.className = `dot${settings.network === 'devnet' ? ' devnet' : ''}`;
  elements.rpcLabel.textContent = `${settings.network} · ${new URL(active.rpc).host}`;
}

function openSettingsModal() {
  const settings = getSettings();
  const rpcInput = el('input', { type: 'url', placeholder: network().rpc, value: settings.customRpc?.[settings.network] || '' });
  const blur = el('input', { type: 'checkbox', checked: settings.blurGallery });
  const dialog = modal({
    title: 'Settings',
    subtitle: 'Stored in this browser only',
    body: [
      el('div', {}, [
        el('label', { text: `Custom RPC for ${settings.network}` }),
        rpcInput,
        el('p', { class: 'faint', style: 'font-size:11px;margin-top:6px', text: 'Public endpoints are rate limited. A dedicated endpoint makes the inspector noticeably faster. This value stays in your browser.' }),
      ]),
      el('label', { class: 'switch' }, [blur, el('span', { text: 'Blur images in the feed until I click them' })]),
      el('button', {
        class: 'primary full',
        type: 'button',
        text: 'Save',
        onClick: () => {
          const value = rpcInput.value.trim();
          if (value && !/^https:\/\//i.test(value)) {
            toast('An RPC endpoint must be an https:// URL.', 'error');
            return;
          }
          updateSettings({
            customRpc: { ...settings.customRpc, [settings.network]: value },
            blurGallery: blur.checked,
          });
          dialog.close();
          toast('Settings saved.', 'good');
        },
      }),
    ],
  });
}

elements.settingsButton.addEventListener('click', openSettingsModal);
elements.networkSelect.addEventListener('change', (event) => {
  updateSettings({ network: event.target.value });
  toast(`Switched to ${event.target.value}.`);
});
/* ------------------------------------------------------------- inspector */

let inspectToken = 0;

async function inspect(rawInput, { push = true } = {}) {
  const token = ++inspectToken;
  let target;
  try {
    target = parseTarget(rawInput);
  } catch (error) {
    statusNode(elements.inspectStatus, { tone: 'error', message: error.message });
    return;
  }

  elements.inspectInput.value = target.id;
  if (target.network && target.network !== getSettings().network) updateSettings({ network: target.network });
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set('q', target.id);
    history.pushState({ q: target.id }, '', url);
  }
  document.getElementById('verify').scrollIntoView({ block: 'start' });

  elements.inspectSubmit.disabled = true;
  elements.inspectResult.hidden = true;
  statusNode(elements.inspectStatus, { message: target.kind === 'tx' ? 'Reading the transaction from Solana' : 'Reading the account from Solana', busy: true });

  try {
    const blurMedia = getSettings().blurGallery;
    if (target.kind === 'tx') {
      const result = await inspectTransaction(target.id);
      if (token !== inspectToken) return;
      statusNode(elements.inspectStatus, {
        tone: result.movedNetwork ? 'warn' : 'good',
        message: result.movedNetwork
          ? `Not on ${getSettings().network}, but found on ${result.networkId}. Showing that one.`
          : `Decoded ${result.payloads.length} payload${result.payloads.length === 1 ? '' : 's'} from ${result.instructions.length} instructions.`,
      });
      renderTransaction(result, { container: elements.inspectResult, blurMedia });
    } else {
      const result = await inspectAddress(target.id);
      if (token !== inspectToken) return;
      statusNode(elements.inspectStatus, { tone: result.movedNetwork ? 'warn' : 'good', message: result.movedNetwork ? `Found on ${result.networkId} instead.` : `Read the ${result.kind} account.` });
      renderAddress(result, { container: elements.inspectResult, blurMedia, onInspect: (signature) => inspect(signature) });
    }
  } catch (error) {
    if (token !== inspectToken) return;
    clear(elements.inspectResult).hidden = true;
    reportInspectError(error, elements.inspectStatus);
  } finally {
    if (token === inspectToken) elements.inspectSubmit.disabled = false;
  }
}

elements.inspectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  inspect(elements.inspectInput.value);
});

// The registry address itself is always inspectable and needs no hardcoded example.
elements.exampleButton.addEventListener('click', async () => {
  inspect(await registryAddress());
});

window.addEventListener('popstate', () => {
  const query = new URL(location.href).searchParams.get('q');
  if (query) inspect(query, { push: false });
});

/* ------------------------------------------------------------ forge/feed */

const forge = createForge({
  elements: {
    form: $('forge-form'),
    tabs: [...document.querySelectorAll('.tabs button')],
    textField: $('text-field'),
    fileField: $('file-field'),
    textarea: $('memo-input'),
    fileInput: $('file-input'),
    drop: $('file-drop'),
    dropTitle: $('file-drop-title'),
    dropHint: $('file-drop-hint'),
    byteCount: $('byte-count'),
    byteBar: $('byte-bar'),
    planSummary: $('plan-summary'),
    listToggle: $('list-toggle'),
    submit: $('forge-submit'),
    receipt: $('forge-receipt'),
    onInspect: (signature) => inspect(signature),
  },
  getSigner: () => walletSigner(),
  onRequestWallet: openWalletModal,
  getSettings,
  onListedChange: (listInGallery) => updateSettings({ listInGallery }),
});

const feed = createFeed({
  grid: $('feed-grid'),
  status: $('feed-status'),
  refreshButton: $('feed-refresh'),
  onOpen: (signature) => inspect(signature),
});

/* ------------------------------------------------------------------ boot */

// Subscriptions come last on purpose: onWalletChange fires immediately, so it can
// only run after forge and feed exist.
onWalletChange(() => {
  elements.walletButton.textContent = walletLabel();
  forge.refresh();
});
onSettingsChange(() => {
  applySettings();
  forge.refresh();
  feed.load();
});

$('list-toggle').checked = getSettings().listInGallery;
applySettings();
feed.load();

const initialQuery = new URL(location.href).searchParams.get('q');
if (initialQuery) inspect(initialQuery, { push: false });
