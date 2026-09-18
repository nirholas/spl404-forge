import { extensionFor } from '../../core/payload.js';
import { copyButton, downloadBytes, el, formatBytes } from './dom.js';

/**
 * Renders one decoded payload.
 *
 * On-chain bytes are written by strangers, so nothing here is ever inserted as
 * HTML or executed. Images, audio, and video render through object URLs, which
 * browsers treat as inert media. SVG and HTML are shown as source text only:
 * both can carry script, and an <img> pointing at an SVG blob would still run
 * inside some contexts, so neither is given a chance to render.
 */
export function payloadCard(payload, { blurMedia = false, onOpen } = {}) {
  const media = el('div', { class: 'payload-media' });
  const kind = payload.kind;
  const sensitive = blurMedia && (kind === 'image' || kind === 'video');

  if (kind === 'image' && payload.url) {
    media.append(el('img', { src: payload.url, alt: `Decoded ${payload.mime} payload`, loading: 'lazy' }));
  } else if (kind === 'video' && payload.url) {
    media.append(el('video', { src: payload.url, controls: '', preload: 'metadata' }));
  } else if (kind === 'audio' && payload.url) {
    media.append(el('audio', { src: payload.url, controls: '', preload: 'metadata' }));
  } else if (kind === 'json') {
    media.append(el('pre', { text: JSON.stringify(payload.json, null, 2).slice(0, 4000) }));
  } else if (kind === 'text' || kind === 'svg' || kind === 'html') {
    media.append(el('pre', { text: (payload.text || '').slice(0, 4000) }));
  } else {
    media.append(el('span', { class: 'glyph', text: payload.mime || 'binary' }));
  }

  if (sensitive) {
    media.classList.add('blurred');
    const overlay = el('div', { class: 'reveal-overlay' }, [el('span', { text: 'Tap to reveal' })]);
    overlay.addEventListener('click', () => {
      media.classList.remove('blurred');
      overlay.remove();
    });
    media.append(overlay);
  }

  const title = payload.schema
    ? payload.schema.replace(/-/g, ' ')
    : { image: 'Image', video: 'Video', audio: 'Audio', json: 'JSON', svg: 'SVG source', html: 'HTML source', text: 'Text', model: '3D model', binary: 'Binary data' }[kind] || kind;

  const actions = el('div', { class: 'payload-actions' });
  if (payload.bytes?.length) {
    actions.append(el('button', {
      type: 'button',
      text: 'Download',
      onClick: () => downloadBytes(payload.bytes, `spl404-payload.${extensionFor(payload.mime)}`, payload.mime),
    }));
  }
  if (payload.text) actions.append(copyButton(payload.text, 'Copy text'));
  if (payload.url && (kind === 'image' || kind === 'video' || kind === 'audio')) {
    actions.append(el('a', { href: payload.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }));
  }
  if (onOpen) actions.append(el('button', { type: 'button', text: 'Inspect', onClick: () => onOpen(payload) }));

  const size = payload.contentSize ?? payload.size ?? payload.bytes?.length ?? 0;
  return el('article', { class: 'payload' }, [
    media,
    el('div', { class: 'payload-body' }, [
      el('div', { class: 'payload-title' }, [
        el('strong', { text: title }),
        el('span', { class: 'faint mono', text: formatBytes(size) }),
      ]),
      el('div', { class: 'chips' }, [
        el('span', { class: 'chip', text: payload.mime || 'unknown' }),
        payload.dataUri && el('span', { class: 'chip', text: 'data uri' }),
        payload.chunk && el('span', { class: 'chip warn', text: `chunk ${payload.chunk.index + 1}/${payload.chunk.total}` }),
        payload.origin?.label && el('span', { class: 'chip', text: payload.origin.label }),
      ]),
      (kind === 'svg' || kind === 'html') && el('p', { class: 'faint', style: 'font-size:11px', text: 'Shown as source. Active formats are never rendered by this page.' }),
      actions,
    ]),
  ]);
}

export function payloadGrid(payloads, options = {}) {
  return el('div', { class: 'payloads' }, payloads.map((payload) => payloadCard(payload, options)));
}
