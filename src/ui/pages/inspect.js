import { explorerAddress, explorerTx } from '../../core/config.js';
import { findManifestForChunk, resolveManifest } from '../../core/inspect-tx.js';
import { payloadGrid } from '../components/payload-card.js';
import { clear, copyButton, el, formatBytes, formatSol, shorten, statusNode, toast } from '../components/dom.js';

const VERDICT_TONE = { onchain: 'good', hybrid: 'warn', offchain: 'warn', none: '' };

function metric(label, value) {
  return el('div', {}, [el('small', { text: label }), el('strong', { text: value })]);
}

function addressLine(label, address, networkId) {
  return el('div', { class: 'row' }, [
    el('span', { class: 'name', text: label }),
    el('a', { class: 'detail', href: explorerAddress(address, networkId), target: '_blank', rel: 'noopener noreferrer', text: shorten(address, 6, 6) }),
  ]);
}

/** Chunked files are only rendered after the rebuilt bytes match the manifest hash. */
function manifestCard(manifest, { networkId, blurMedia }) {
  const status = el('div', { class: 'status', hidden: true });
  const output = el('div', {});
  const button = el('button', { class: 'primary', type: 'button', text: `Rebuild and verify ${manifest.chunks.length} chunks` });

  button.addEventListener('click', async () => {
    button.disabled = true;
    clear(output);
    statusNode(status, { message: `Fetching chunk 0 of ${manifest.chunks.length}`, busy: true });
    try {
      const result = await resolveManifest(manifest, {
        networkId,
        onProgress: (done, total) => statusNode(status, { message: `Fetching chunk ${done} of ${total}`, busy: true }),
      });
      if (!result.verified) {
        statusNode(status, { tone: 'error', message: result.problems.join(' ') });
        button.disabled = false;
        return;
      }
      statusNode(status, { tone: 'good', message: `Rebuilt ${formatBytes(result.bytes.length)} and the SHA-256 matches the manifest.` });
      output.append(payloadGrid([{ ...result.payload, origin: { type: 'file', label: manifest.name } }], { blurMedia }));
    } catch (error) {
      statusNode(status, { tone: 'error', message: error.message });
      button.disabled = false;
    }
  });

  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('p', { class: 'kicker', text: 'Chunked file' }),
        el('h3', { text: manifest.name }),
        el('p', { class: 'faint mono', text: `${manifest.mime} · ${formatBytes(manifest.size)} · ${manifest.chunks.length} chunks` }),
      ]),
      copyButton(manifest.hash, 'Copy SHA-256'),
    ]),
    el('div', { class: 'chips' }, [el('span', { class: 'chip', text: `sha256 ${manifest.hash.slice(0, 12)}` })]),
    button,
    status,
    output,
  ]);
}

/** A chunk memo names its file but not its manifest, which is written afterwards. */
function orphanChunkCard(payload, { signature, feePayer, networkId, blurMedia, container }) {
  const status = el('div', { class: 'status', hidden: true });
  const button = el('button', { class: 'secondary', type: 'button', text: 'Find the manifest for this chunk' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    statusNode(status, { message: 'Scanning later transactions from the same signer', busy: true });
    try {
      const found = await findManifestForChunk(signature, feePayer, { networkId });
      if (!found) {
        statusNode(status, { tone: 'warn', message: 'No manifest was found in the signer’s next 60 transactions. The file may still be uploading.' });
        button.disabled = false;
        return;
      }
      statusNode(status, { tone: 'good', message: `Manifest found in ${shorten(found.signature, 6, 6)}.` });
      container.append(manifestCard(found.manifest, { networkId, blurMedia }));
    } catch (error) {
      statusNode(status, { tone: 'error', message: error.message });
      button.disabled = false;
    }
  });

  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('p', { class: 'kicker', text: 'Part of a larger file' }),
        el('h3', { text: `Chunk ${payload.chunk.index + 1} of ${payload.chunk.total}` }),
        el('p', { class: 'faint', style: 'font-size:12px', text: 'This transaction holds one piece of an SPL404 file. The manifest lists every piece and the hash they must produce.' }),
      ]),
    ]),
    button,
    status,
  ]);
}

export function renderTransaction(result, { container, blurMedia }) {
  clear(container);
  container.hidden = false;

  const versionLabel = result.version === 1 ? 'v1' : result.version === 0 ? 'v0' : 'legacy';
  container.append(el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('p', { class: 'kicker', text: 'Transaction' }),
        el('h3', { class: 'mono', text: shorten(result.signature, 10, 10) }),
      ]),
      el('div', { class: 'payload-actions' }, [
        copyButton(result.signature, 'Copy signature'),
        el('a', { href: explorerTx(result.signature, result.networkId), target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' }),
      ]),
    ]),
    el('div', { class: 'chips' }, [
      el('span', { class: `chip ${result.success ? 'good' : 'bad'}`, text: result.success ? 'succeeded' : 'failed' }),
      el('span', { class: `chip${result.version === 1 ? ' good' : ''}`, text: `transaction ${versionLabel}` }),
      el('span', { class: 'chip', text: result.networkId }),
      result.listed && el('span', { class: 'chip good', text: 'in the public index' }),
      result.movedNetwork && el('span', { class: 'chip warn', text: 'found on the other network' }),
    ]),
    result.error && el('p', { class: 'faint mono', text: result.error }),
    el('div', { class: 'metrics' }, [
      metric('Slot', result.slot?.toLocaleString?.() ?? '—'),
      metric('Wire size', result.wireSize ? `${result.wireSize} / ${result.sizeLimit} B` : '—'),
      metric('Fee', result.fee === null ? '—' : formatSol(result.fee)),
      metric('Compute', result.computeUnits === null ? '—' : result.computeUnits.toLocaleString()),
      metric('Instructions', String(result.instructions.length)),
      metric('Payloads', String(result.payloads.length)),
    ]),
    result.budget && el('div', { class: 'metrics' }, [
      metric('v1 compute limit', result.budget.computeUnitLimit?.toLocaleString?.() ?? 'unset'),
      metric('v1 priority fee', result.budget.priorityFeeLamports === null ? 'unset' : formatSol(result.budget.priorityFeeLamports)),
      metric('v1 loaded accounts', result.budget.loadedAccountsDataSizeLimit ? formatBytes(result.budget.loadedAccountsDataSizeLimit) : 'unset'),
      metric('v1 heap', result.budget.heapSize ? formatBytes(result.budget.heapSize) : 'default'),
    ]),
    result.feePayer && addressLine('Fee payer', result.feePayer, result.networkId),
  ]));

  if (result.payloads.length) {
    container.append(el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('div', {}, [
        el('p', { class: 'kicker', text: 'Decoded content' }),
        el('h3', { text: `${result.payloads.length} payload${result.payloads.length === 1 ? '' : 's'} found inside` }),
      ])]),
      payloadGrid(result.payloads, { blurMedia }),
    ]));
  }

  result.manifests.forEach((manifest) => container.append(manifestCard(manifest, { networkId: result.networkId, blurMedia })));

  const orphan = result.payloads.find((payload) => payload.chunk);
  if (orphan && !result.manifests.length && result.feePayer) {
    container.append(orphanChunkCard(orphan, { signature: result.signature, feePayer: result.feePayer, networkId: result.networkId, blurMedia, container }));
  }

  container.append(el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('div', {}, [
      el('p', { class: 'kicker', text: 'Instructions' }),
      el('h3', { text: 'What this transaction actually did' }),
    ])]),
    el('div', { class: 'rows' }, result.instructions.map((ix) => el('div', { class: `row${ix.depth ? ' nested' : ''}` }, [
      el('span', { class: 'path', text: ix.path }),
      el('span', { class: 'name', text: ix.program || 'Unknown program' }),
      el('span', { class: 'faint', text: ix.type }),
      el('span', { class: 'detail', text: ix.summary || '' }),
    ]))),
    result.logs.length ? el('details', { class: 'raw' }, [
      el('summary', { text: `Program logs (${result.logs.length} lines)` }),
      el('pre', { text: result.logs.join('\n') }),
    ]) : null,
  ]));

  if (!result.payloads.length && !result.manifests.length) {
    container.append(el('div', { class: 'empty', text: 'No embedded content in this transaction: no memos, data URIs, or readable buffers. That is normal for ordinary transfers and swaps.' }));
  }
}

export function renderAddress(result, { container, blurMedia, onInspect }) {
  clear(container);
  container.hidden = false;

  if (result.kind === 'empty') {
    container.append(el('div', { class: 'empty', text: result.detail }));
    return;
  }

  const head = (kicker, title, extra = []) => el('div', { class: 'card-head' }, [
    el('div', {}, [el('p', { class: 'kicker', text: kicker }), el('h3', { text: title }), el('p', { class: 'faint mono', text: shorten(result.address, 8, 8) })]),
    el('div', { class: 'payload-actions' }, [
      copyButton(result.address, 'Copy address'),
      el('a', { href: explorerAddress(result.address, result.networkId), target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' }),
      ...extra,
    ]),
  ]);

  if (result.kind === 'mint') {
    const verdict = result.verdict;
    container.append(el('section', { class: 'card' }, [
      head('Token', result.name || 'Unnamed mint'),
      el('div', { class: 'chips' }, [
        result.symbol && el('span', { class: 'chip', text: `$${result.symbol}` }),
        el('span', { class: 'chip', text: result.program }),
        el('span', { class: `chip ${VERDICT_TONE[verdict.level] || ''}`, text: verdict.title }),
        result.mintAuthority === null && el('span', { class: 'chip good', text: 'fixed supply' }),
        result.freezeAuthority && el('span', { class: 'chip warn', text: 'freeze authority set' }),
        result.movedNetwork && el('span', { class: 'chip warn', text: 'found on the other network' }),
      ]),
      el('p', { class: 'muted', style: 'font-size:13px', text: verdict.detail }),
      result.description && el('p', { class: 'faint', style: 'font-size:13px', text: result.description }),
      el('div', { class: 'metrics' }, [
        metric('Supply', result.supply ? Number(result.supply).toLocaleString() : '—'),
        metric('Decimals', String(result.decimals ?? '—')),
        metric('Metadata', result.storage.metadata.label),
        metric('Image', result.storage.image.label),
      ]),
      result.metadataSource && el('p', { class: 'faint', style: 'font-size:12px', text: result.metadataSource }),
      result.jsonError && el('p', { class: 'faint', style: 'font-size:12px', text: `Metadata JSON could not be loaded: ${result.jsonError}` }),
      result.agent && el('div', { class: 'chips' }, [el('span', { class: 'chip good', text: 'SPL404 agent manifest' })]),
      result.uri && el('details', { class: 'raw' }, [el('summary', { text: 'Metadata URI' }), el('pre', { text: result.uri })]),
    ]));
    if (result.payloads?.length) {
      container.append(el('section', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('div', {}, [el('p', { class: 'kicker', text: 'Decoded content' }), el('h3', { text: 'What is stored in this token' })])]),
        payloadGrid(result.payloads, { blurMedia }),
      ]));
    }
    return;
  }

  if (result.kind === 'wallet') {
    container.append(el('section', { class: 'card' }, [
      head('Wallet', 'System account'),
      el('div', { class: 'metrics' }, [
        metric('Balance', formatSol(result.lamports)),
        metric('Recent activity', `${result.history.length} signatures`),
        metric('Network', result.networkId),
      ]),
      result.history.length
        ? el('div', { class: 'rows' }, result.history.slice(0, 12).map((entry) => {
          const open = el('button', { class: 'name', style: 'text-align:left', text: shorten(entry.signature, 8, 8), onClick: () => onInspect(entry.signature) });
          return el('div', { class: 'row' }, [
            open,
            entry.err ? el('span', { class: 'chip bad', text: 'failed' }) : el('span', { class: 'chip', text: 'ok' }),
            el('span', { class: 'detail', text: entry.memo ? String(entry.memo).slice(0, 40) : '' }),
          ]);
        }))
        : el('div', { class: 'empty', text: 'No recent transactions for this wallet.' }),
    ]));
    return;
  }

  if (result.kind === 'program') {
    container.append(el('section', { class: 'card' }, [
      head('Program', 'Executable account'),
      el('div', { class: 'metrics' }, [
        metric('Owner', shorten(result.owner, 4, 4)),
        metric('Size', formatBytes(result.space || 0)),
        metric('Balance', formatSol(result.lamports)),
      ]),
    ]));
    return;
  }

  container.append(el('section', { class: 'card' }, [
    head('Account', result.parsedType ? `${result.parsedType} account` : 'Data account'),
    el('div', { class: 'metrics' }, [
      metric('Owner', shorten(result.owner, 4, 4)),
      metric('Size', formatBytes(result.space || 0)),
      metric('Balance', formatSol(result.lamports)),
      metric('Payloads', String(result.payloads?.length ?? 0)),
    ]),
  ]));
  if (result.payloads?.length) {
    container.append(el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('div', {}, [el('p', { class: 'kicker', text: 'Decoded content' }), el('h3', { text: 'Readable content inside this account' })])]),
      payloadGrid(result.payloads, { blurMedia }),
    ]));
  } else {
    container.append(el('div', { class: 'empty', text: 'This account holds no decodable media or text.' }));
  }
}

export function reportInspectError(error, status) {
  const message = error?.code === 'NOT_FOUND' ? error.message : error?.message || 'That could not be read.';
  statusNode(status, { tone: 'error', message });
  toast(message, 'error');
}
