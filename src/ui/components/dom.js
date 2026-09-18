/** Tiny DOM helpers. Text is always set as text, never as HTML, because every
 * string rendered here can come from on-chain data written by a stranger. */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'hidden' || key === 'disabled' || key === 'checked') node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of [children].flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function shorten(value = '', lead = 4, tail = 4) {
  const text = String(value);
  return text.length <= lead + tail + 1 ? text : `${text.slice(0, lead)}…${text.slice(-tail)}`;
}

export function formatBytes(size = 0) {
  if (size < 1000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1000).toFixed(size < 10_000 ? 1 : 0)} KB`;
  return `${(size / 1_000_000).toFixed(2)} MB`;
}

export function formatSol(lamports = 0) {
  const sol = Number(lamports) / 1e9;
  if (sol === 0) return '0 SOL';
  return `${sol < 0.001 ? sol.toFixed(6) : sol.toFixed(4)} SOL`;
}

export function formatAge(unixSeconds) {
  if (!unixSeconds) return '';
  const seconds = Math.max(1, Math.floor(Date.now() / 1000 - unixSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function copyButton(value, label = 'Copy') {
  const button = el('button', { type: 'button', text: label, title: label });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = label; }, 1400);
  });
  return button;
}

export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const safe = [...String(filename)].map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c)).join('').slice(0, 120) || 'payload.bin';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = el('a', { href: url, download: safe });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function statusNode(element, { tone = 'info', message, busy = false } = {}) {
  if (!message) {
    element.hidden = true;
    clear(element);
    return element;
  }
  clear(element);
  element.className = `status${tone === 'info' ? '' : ` ${tone}`}`;
  element.hidden = false;
  if (busy) element.append(el('span', { class: 'spinner' }));
  element.append(el('span', { text: message }));
  return element;
}

export function toast(message, tone = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = el('div', { class: `toast${tone === 'info' ? '' : ` ${tone}`}` }, [
    el('span', { text: message }),
  ]);
  root.append(node);
  setTimeout(() => node.remove(), 5200);
}

export function modal({ title, subtitle, body, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  const content = el('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('div', { class: 'modal-head' }, [
      el('div', {}, [el('h3', { text: title }), subtitle && el('p', { class: 'faint', text: subtitle, style: 'font-size:12px;margin-top:6px' })]),
      el('button', { class: 'ghost icon', type: 'button', 'aria-label': 'Close', text: '✕', onClick: close }),
    ]),
    el('div', { class: 'modal-body' }, body),
  ]);
  const backdrop = el('div', { class: 'modal-backdrop', onMousedown: (event) => { if (event.target === backdrop) close(); } }, [content]);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  content.querySelector('button, input, select, textarea')?.focus();
  return { close };
}
