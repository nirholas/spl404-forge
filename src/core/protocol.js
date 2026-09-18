import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PROTOCOL, PROTOCOL_VERSION } from './config.js';
import { base64ToBytes, bytesToBase64 } from './payload.js';

/**
 * SPL404 inscription protocol, version 1.
 *
 * Small payloads are written verbatim into one memo: plain text, JSON, or a data URI.
 * Anything larger is split into chunk memos plus one manifest memo that lists every
 * chunk signature and the SHA-256 of the reassembled bytes, so any reader can fetch,
 * rebuild, and prove the file without trusting this app.
 *
 *   chunk:    spl404:c:<fileId>:<index>:<total>:<base64>
 *   manifest: {"p":"spl404","v":1,"t":"file","name":…,"mime":…,"size":…,"sha256":…,"chunks":[sig,…]}
 */

export const CHUNK_PREFIX = `${PROTOCOL}:c:`;
const SIGNATURE_WIDTH = 88;

export function sha256Hex(bytes) {
  return bytesToHex(sha256(bytes));
}

export function fileIdFor(hashHex) {
  return hashHex.slice(0, 16);
}

function chunkHeader(fileId, index, total) {
  return `${CHUNK_PREFIX}${fileId}:${index}:${total}:`;
}

/** Raw bytes that fit in one chunk memo whose total size must stay within memoBudget bytes. */
export function chunkCapacity(memoBudget, total = 999) {
  const header = chunkHeader('0'.repeat(16), total - 1, total).length;
  const base64Chars = Math.floor((memoBudget - header) / 4) * 4;
  return Math.max(0, (base64Chars / 4) * 3);
}

export function manifestJson({ name, mime, size, hash, chunks }) {
  return JSON.stringify({ p: PROTOCOL, v: PROTOCOL_VERSION, t: 'file', name, mime, size, sha256: hash, chunks });
}

/** How many chunk signatures a manifest memo of memoBudget bytes can list. */
export function manifestCapacity(memoBudget, { name = '', mime = '' } = {}) {
  const base = manifestJson({ name, mime, size: 99_999_999, hash: '0'.repeat(64), chunks: [] }).length;
  return Math.max(0, Math.floor((memoBudget - base + 1) / (SIGNATURE_WIDTH + 3)));
}

export function maxChunkedFileSize(memoBudget, meta) {
  const chunks = manifestCapacity(memoBudget, meta);
  return chunks * chunkCapacity(memoBudget, chunks);
}

export function planChunks(bytes, memoBudget) {
  const hash = sha256Hex(bytes);
  const fileId = fileIdFor(hash);
  let total = Math.ceil(bytes.length / chunkCapacity(memoBudget, 9));
  while (total > 0 && Math.ceil(bytes.length / chunkCapacity(memoBudget, total)) > total) total++;
  const per = chunkCapacity(memoBudget, total);
  const memos = [];
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * per, (index + 1) * per);
    memos.push(chunkHeader(fileId, index, total) + bytesToBase64(slice));
  }
  return { hash, fileId, memos };
}

export function parseChunkMemo(memo) {
  if (!memo.startsWith(CHUNK_PREFIX)) return null;
  const parts = memo.slice(CHUNK_PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [fileId, index, total, data] = parts;
  if (!/^[0-9a-f]{16}$/.test(fileId)) return null;
  const i = Number(index);
  const n = Number(total);
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 0 || i >= n) return null;
  try {
    return { fileId, index: i, total: n, bytes: base64ToBytes(data) };
  } catch {
    return null;
  }
}

export function parseManifest(json) {
  if (!json || json.p !== PROTOCOL || json.t !== 'file' || !Array.isArray(json.chunks)) return null;
  if (typeof json.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(json.sha256)) return null;
  return {
    name: typeof json.name === 'string' ? json.name : 'file',
    mime: typeof json.mime === 'string' ? json.mime : 'application/octet-stream',
    size: Number(json.size) || 0,
    hash: json.sha256,
    chunks: json.chunks.filter((sig) => typeof sig === 'string'),
  };
}

/**
 * Rebuilds a file from chunk memos (in any order) and checks it against the manifest.
 * Returns { bytes, verified, problems } so the UI can show exactly what failed.
 */
export function reassemble(manifest, chunkMemos) {
  const problems = [];
  const parsed = chunkMemos.map((memo) => (memo ? parseChunkMemo(memo) : null));
  const expectedId = fileIdFor(manifest.hash);
  const ordered = new Array(manifest.chunks.length);
  parsed.forEach((chunk, position) => {
    if (!chunk) return problems.push(`Chunk ${position + 1} is missing or not an SPL404 chunk.`);
    if (chunk.fileId !== expectedId) return problems.push(`Chunk ${position + 1} belongs to a different file.`);
    if (chunk.total !== manifest.chunks.length) problems.push(`Chunk ${position + 1} declares ${chunk.total} parts.`);
    ordered[chunk.index] = chunk.bytes;
  });
  const missing = [...ordered.keys()].filter((i) => !ordered[i]);
  if (missing.length) problems.push(`Missing part ${missing.map((i) => i + 1).join(', ')}.`);
  const length = ordered.reduce((sum, part) => sum + (part?.length || 0), 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of ordered) {
    if (!part) continue;
    bytes.set(part, offset);
    offset += part.length;
  }
  const hash = sha256Hex(bytes);
  if (hash !== manifest.hash) problems.push('SHA-256 of the rebuilt bytes does not match the manifest.');
  if (manifest.size && manifest.size !== bytes.length) problems.push(`Rebuilt ${bytes.length} bytes, manifest says ${manifest.size}.`);
  return { bytes, hash, verified: problems.length === 0, problems };
}
