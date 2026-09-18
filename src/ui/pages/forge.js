import { explorerTx } from '../../core/config.js';
import { estimateCost, inscribe, planInscription } from '../../core/inscribe.js';
import { sniffMime } from '../../core/payload.js';
import { clear, copyButton, el, formatBytes, formatSol, shorten, toast } from '../components/dom.js';

const STEPS = [
  { key: 'plan', title: 'Plan the write', detail: 'Measured against the real transaction limit.' },
  { key: 'sign', title: 'Sign in your wallet', detail: 'One prompt for the batch. Nothing is sent before you approve.' },
  { key: 'confirm', title: 'Confirm on Solana', detail: 'Every transaction is watched until it lands.' },
];

export function createForge({ elements, getSigner, onRequestWallet, getSettings, onListedChange }) {
  const state = { kind: 'text', file: null, bytes: new Uint8Array(), text: '', plan: null, busy: false, result: null };
  let planToken = 0;

  const receipt = elements.receipt;

  function renderReceipt({ stage, progress, error } = {}) {
    clear(receipt);
    const plan = state.plan;
    receipt.append(el('p', { class: 'kicker', text: 'What gets signed' }));
    receipt.append(el('h3', { text: plan?.kind === 'chunked' ? `${plan.chunkCount} chunks and a manifest` : 'One memo transaction' }));
    receipt.append(el('p', { class: 'faint', style: 'font-size:12px', text: plan?.kind === 'chunked'
      ? 'Each chunk is written first, then a manifest naming their signatures and the SHA-256 they must produce. Anyone can rebuild the file from those alone.'
      : 'Your bytes go into an SPL Memo instruction. Nothing else is touched: no approvals, no transfers, no programs deployed.' }));

    if (plan && !plan.problem) {
      receipt.append(el('div', { class: 'metrics' }, [
        el('div', {}, [el('small', { text: 'Transactions' }), el('strong', { text: String(plan.transactions) })]),
        el('div', {}, [el('small', { text: 'Format' }), el('strong', { text: plan.version === 1 ? 'v1 · 4 KB' : 'legacy · 1.2 KB' })]),
        el('div', {}, [el('small', { text: 'Per-memo budget' }), el('strong', { text: formatBytes(plan.budget) })]),
        el('div', {}, [el('small', { text: 'Estimated fee' }), el('strong', { text: state.cost ? formatSol(state.cost.lamports) : '—' })]),
      ]));
    }

    const current = stage ? STEPS.findIndex((step) => step.key === stage) : -1;
    receipt.append(el('ol', { class: 'steps' }, STEPS.map((step, index) => el('li', {
      class: current > index ? 'done' : current === index ? 'active' : '',
    }, [
      el('span', { text: current > index ? '✓' : String(index + 1).padStart(2, '0') }),
      el('div', {}, [el('strong', { text: step.title }), el('small', { text: index === 2 && progress ? progress : step.detail })]),
    ]))));

    if (error) receipt.append(el('p', { class: 'status error', style: 'margin-top:14px', text: error }));

    if (state.result) {
      const { result } = state;
      receipt.append(el('p', { class: 'status good', style: 'margin-top:14px', text: result.kind === 'chunked'
        ? `Wrote ${result.signatures.length} transactions. The manifest is the link to share.`
        : 'Written and confirmed on Solana.' }));
      receipt.append(el('div', { class: 'receipt-links' }, [
        el('a', { href: explorerTx(result.primary, getSettings().network), target: '_blank', rel: 'noopener noreferrer' }, [
          el('span', { text: result.kind === 'chunked' ? 'Manifest transaction' : 'Transaction' }),
          el('span', { text: shorten(result.primary, 6, 6) }),
        ]),
        ...(result.chunkSignatures || []).slice(0, 4).map((signature, index) => el('a', { href: explorerTx(signature, getSettings().network), target: '_blank', rel: 'noopener noreferrer' }, [
          el('span', { text: `Chunk ${index + 1}` }),
          el('span', { text: shorten(signature, 6, 6) }),
        ])),
      ]));
      receipt.append(el('div', { class: 'payload-actions', style: 'margin-top:12px' }, [
        copyButton(result.primary, 'Copy signature'),
        copyButton(`${location.origin}${location.pathname}?q=${result.primary}`, 'Copy share link'),
        el('button', { type: 'button', text: 'Inspect it', onClick: () => elements.onInspect(result.primary) }),
      ]));
    }
  }

  async function refreshPlan() {
    const token = ++planToken;
    const signer = getSigner();
    const size = state.bytes.length;
    elements.byteCount.textContent = size.toLocaleString();

    if (!signer) {
      state.plan = null;
      state.cost = null;
      elements.planSummary.textContent = size ? 'connect a wallet to size the write' : 'nothing to write yet';
      elements.byteBar.style.width = '0%';
      renderReceipt();
      updateSubmit();
      return;
    }

    try {
      const plan = await planInscription({
        signer,
        bytes: state.bytes,
        name: state.file?.name || 'payload.txt',
        mime: state.file?.type || sniffMime(state.bytes) || 'text/plain',
        list: elements.listToggle.checked,
      });
      if (token !== planToken) return;
      state.plan = plan;
      state.cost = plan.problem || plan.kind === 'empty' ? null : await estimateCost(plan, { signer }).catch(() => null);
      if (token !== planToken) return;

      elements.planSummary.textContent = plan.problem
        ? plan.problem
        : plan.kind === 'empty'
          ? 'nothing to write yet'
          : plan.kind === 'single'
            ? `one ${plan.version === 1 ? 'v1' : 'legacy'} transaction`
            : `${plan.chunkCount} chunks + 1 manifest`;
      const fill = plan.kind === 'single' ? Math.min(100, (size / plan.budget) * 100) : 100;
      elements.byteBar.style.width = `${fill}%`;
      elements.byteBar.classList.toggle('over', Boolean(plan.problem));
    } catch (error) {
      if (token !== planToken) return;
      state.plan = null;
      elements.planSummary.textContent = error.message;
    }
    renderReceipt();
    updateSubmit();
  }

  function updateSubmit() {
    const signer = getSigner();
    const ready = Boolean(signer) && state.bytes.length > 0 && state.plan && !state.plan.problem;
    elements.submit.disabled = state.busy || (Boolean(signer) && !ready);
    elements.submit.textContent = state.busy
      ? 'Writing…'
      : !signer
        ? 'Connect a wallet to inscribe'
        : state.plan?.kind === 'chunked'
          ? `Inscribe ${state.plan.transactions} transactions`
          : 'Inscribe on Solana';
  }

  function setKind(kind) {
    state.kind = kind;
    elements.tabs.forEach((tab) => {
      const active = tab.dataset.kind === kind;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    elements.textField.hidden = kind !== 'text';
    elements.fileField.hidden = kind === 'text';
    if (kind === 'text') {
      state.file = null;
      setText(elements.textarea.value);
    } else {
      state.bytes = state.file ? state.bytes : new Uint8Array();
      refreshPlan();
    }
  }

  function setText(text) {
    state.text = text;
    state.bytes = new TextEncoder().encode(text);
    refreshPlan();
  }

  async function setFile(file) {
    if (!file) return;
    state.file = file;
    state.bytes = new Uint8Array(await file.arrayBuffer());
    elements.dropTitle.textContent = file.name;
    elements.dropHint.textContent = `${formatBytes(file.size)} · ${file.type || 'unknown type'}`;
    refreshPlan();
  }

  async function submit() {
    const signer = getSigner();
    if (!signer) {
      onRequestWallet();
      return;
    }
    state.busy = true;
    state.result = null;
    updateSubmit();
    renderReceipt({ stage: 'sign' });
    try {
      const result = await inscribe({
        signer,
        bytes: state.bytes,
        text: state.kind === 'text' ? state.text : undefined,
        name: state.file?.name || 'payload.txt',
        mime: state.file?.type || sniffMime(state.bytes) || 'text/plain',
        list: elements.listToggle.checked,
        onProgress: ({ index, total, stage, phase }) => renderReceipt({
          stage: 'confirm',
          progress: `${phase === 'manifest' ? 'Manifest' : `Transaction ${index + 1} of ${total}`}: ${stage === 'sending' ? 'sending' : 'confirmed'}`,
        }),
      });
      state.result = result;
      renderReceipt({ stage: 'done' });
      toast(result.kind === 'chunked' ? 'File written and manifest confirmed.' : 'Written to Solana.', 'good');
    } catch (error) {
      const extra = error.chunkSignatures?.length ? ` ${error.chunkSignatures.length} chunks did land; keep this page open and retry to reuse them.` : '';
      renderReceipt({ stage: 'sign', error: `${error.message}${extra}` });
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      updateSubmit();
    }
  }

  elements.tabs.forEach((tab) => tab.addEventListener('click', () => setKind(tab.dataset.kind)));
  elements.textarea.addEventListener('input', (event) => setText(event.target.value));
  elements.fileInput.addEventListener('change', (event) => setFile(event.target.files?.[0]));
  elements.listToggle.addEventListener('change', () => {
    onListedChange?.(elements.listToggle.checked);
    refreshPlan();
  });
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  const drop = elements.drop;
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    if (type === 'drop') setFile(event.dataTransfer?.files?.[0]);
  }));

  renderReceipt();
  updateSubmit();
  return { refresh: refreshPlan };
}
