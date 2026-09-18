import { getSettings } from '../../core/config.js';
import { inspectTransaction } from '../../core/inspect-tx.js';
import { registryAddress } from '../../core/registry.js';
import { getSignaturesForAddress, mapLimit } from '../../core/rpc.js';
import { clear, el, formatAge, formatBytes, shorten, statusNode } from '../components/dom.js';

const PAGE = 12;

function thumbFor(payload) {
  if (payload?.kind === 'image' && payload.url) return el('img', { src: payload.url, alt: '', loading: 'lazy' });
  return el('span', { class: 'glyph', text: payload?.mime || 'memo' });
}

function card(entry, onOpen) {
  const first = entry.result.payloads[0];
  const title = entry.result.manifests[0]?.name
    || (first?.kind === 'json' && first.json?.name)
    || (first?.text ? first.text.slice(0, 48) : null)
    || 'Untitled inscription';
  const size = entry.result.manifests[0]?.size ?? first?.contentSize ?? first?.size ?? 0;
  return el('button', { class: 'feed-card', type: 'button', onClick: () => onOpen(entry.signature) }, [
    el('div', { class: `thumb${getSettings().blurGallery && first?.kind === 'image' ? ' blurred' : ''}` }, [thumbFor(first)]),
    el('div', { class: 'meta' }, [
      el('strong', { text: String(title) }),
      el('small', { text: `${entry.result.manifests.length ? 'file' : first?.kind || 'memo'} · ${formatBytes(size)} · ${formatAge(entry.blockTime)}` }),
      el('small', { text: shorten(entry.signature, 6, 6) }),
    ]),
  ]);
}

/**
 * Reads the public index straight from Solana: every listed creation tagged that
 * address, so its signature history is the feed. No database, no indexer, no server.
 */
export function createFeed({ grid, status, refreshButton, onOpen }) {
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    statusNode(status, { message: 'Reading the public index from Solana', busy: true });
    clear(grid);
    for (let i = 0; i < 4; i += 1) grid.append(el('div', { class: 'skeleton card' }));

    try {
      const address = await registryAddress();
      const signatures = await getSignaturesForAddress(address, { limit: PAGE * 2 });
      const usable = signatures.filter((entry) => !entry.err).slice(0, PAGE);
      if (!usable.length) {
        clear(grid);
        statusNode(status, { message: '' });
        grid.append(el('div', { class: 'empty', text: 'Nothing has been listed on this network yet. Inscribe something with listing switched on and it shows up here.' }));
        return;
      }
      const results = await mapLimit(usable, 4, async (entry) => ({
        signature: entry.signature,
        blockTime: entry.blockTime,
        result: await inspectTransaction(entry.signature),
      }));
      const entries = results.filter((item) => item.ok).map((item) => item.value).filter((entry) => entry.result.payloads.length || entry.result.manifests.length);
      clear(grid);
      statusNode(status, { message: '' });
      if (!entries.length) {
        grid.append(el('div', { class: 'empty', text: 'The index has entries, but none of them carried readable content.' }));
        return;
      }
      entries.forEach((entry) => grid.append(card(entry, onOpen)));
    } catch (error) {
      clear(grid);
      statusNode(status, { tone: 'error', message: `The feed could not be read: ${error.message}` });
    } finally {
      loading = false;
    }
  }

  refreshButton.addEventListener('click', load);
  return { load };
}
