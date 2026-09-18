import { PROTOCOL } from './config.js';

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Formats that browsers render inertly inside <img>, <audio>, or <video>. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg']);

const SIGNATURES = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mime: 'image/webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'audio/wav', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  { mime: 'image/avif', test: (b) => ascii(b, 4, 12) === 'ftypavif' },
  { mime: 'video/mp4', test: (b) => ascii(b, 4, 8) === 'ftyp' },
  { mime: 'audio/ogg', test: (b) => ascii(b, 0, 4) === 'OggS' },
  { mime: 'audio/mpeg', test: (b) => ascii(b, 0, 3) === 'ID3' },
  { mime: 'application/pdf', test: (b) => ascii(b, 0, 4) === '%PDF' },
  { mime: 'model/gltf-binary', test: (b) => ascii(b, 0, 4) === 'glTF' },
  { mime: 'application/gzip', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { mime: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];

function ascii(bytes, start, end) {
  if (bytes.length < end) return '';
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function sniffMime(bytes) {
  return SIGNATURES.find((sig) => sig.test(bytes))?.mime;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8Bytes(value) {
  return encoder.encode(value);
}

export function byteLength(value) {
  return encoder.encode(value).length;
}

export function decodeUtf8(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function isMostlyPrintable(text) {
  if (!text) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
  }
  return printable / [...text].length > 0.92;
}

export function parseDataUri(value) {
  const match = /^data:([^,]*?),([\s\S]*)$/i.exec(value.trim());
  if (!match) return null;
  const params = match[1].split(';').map((part) => part.trim()).filter(Boolean);
  const isBase64 = params.some((param) => param.toLowerCase() === 'base64');
  const mime = (params.find((param) => param.includes('/')) || 'text/plain').toLowerCase();
  let bytes;
  try {
    bytes = isBase64 ? base64ToBytes(match[2]) : utf8Bytes(safeDecodeURIComponent(match[2]));
  } catch {
    return null;
  }
  return { mime, bytes, base64: isBase64 };
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mediaKind(mime) {
  if (mime === 'image/svg+xml') return 'svg';
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (AUDIO_MIMES.has(mime)) return 'audio';
  if (VIDEO_MIMES.has(mime)) return 'video';
  if (mime === 'text/html') return 'html';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'model/gltf-binary') return 'model';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}

function objectUrlFor(bytes, mime) {
  if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return undefined;
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function structuredType(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  if (json.p === PROTOCOL && typeof json.t === 'string') return json.t;
  if (typeof json.image === 'string' && typeof json.name === 'string') return 'token-metadata';
  return undefined;
}

/**
 * Turns raw bytes (from a memo, instruction data, an account, or a reassembled file)
 * into a typed, renderable payload. Nothing here executes the content.
 */
export function classifyBytes(bytes, hint = {}) {
  const size = bytes.length;
  const sniffed = sniffMime(bytes);
  if (sniffed) {
    const kind = mediaKind(sniffed);
    return { kind, mime: sniffed, size, bytes, url: objectUrlFor(bytes, sniffed), source: hint.source };
  }

  const text = decodeUtf8(bytes);
  if (text !== null && isMostlyPrintable(text)) return classifyText(text, hint);

  return { kind: 'binary', mime: 'application/octet-stream', size, bytes, source: hint.source };
}

export function classifyText(text, hint = {}) {
  const bytes = utf8Bytes(text);
  const size = bytes.length;
  const trimmed = text.trim();

  const dataUri = trimmed.startsWith('data:') ? parseDataUri(trimmed) : null;
  if (dataUri) {
    const kind = mediaKind(dataUri.mime);
    const inner = kind === 'json' || kind === 'text' || kind === 'html' || kind === 'svg' ? decodeUtf8(dataUri.bytes) : null;
    const result = {
      kind,
      mime: dataUri.mime,
      size,
      contentSize: dataUri.bytes.length,
      bytes: dataUri.bytes,
      text: inner ?? undefined,
      url: objectUrlFor(dataUri.bytes, dataUri.mime),
      dataUri: true,
      source: hint.source,
    };
    if (kind === 'json' && inner) {
      try {
        result.json = JSON.parse(inner);
        result.schema = structuredType(result.json);
      } catch {
        result.kind = 'text';
      }
    }
    return result;
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const json = JSON.parse(trimmed);
      return { kind: 'json', mime: 'application/json', size, bytes, text, json, schema: structuredType(json), source: hint.source };
    } catch {
      /* not JSON: fall through to text heuristics */
    }
  }

  if (/^\s*<svg[\s>]/i.test(trimmed) && /<\/svg>\s*$/i.test(trimmed)) {
    return { kind: 'svg', mime: 'image/svg+xml', size, bytes, text, url: objectUrlFor(bytes, 'image/svg+xml'), source: hint.source };
  }
  if (/^\s*(<!doctype html|<html[\s>])/i.test(trimmed)) {
    return { kind: 'html', mime: 'text/html', size, bytes, text, source: hint.source };
  }

  return { kind: 'text', mime: 'text/plain', size, bytes, text, source: hint.source };
}

/** Finds data URIs buried inside longer strings, such as program logs or JSON blobs. */
export function findEmbeddedDataUris(text) {
  const matches = text.match(/data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[A-Za-z0-9+/=%._~-]{16,}/gi) || [];
  return matches.map((match) => classifyText(match)).filter((payload) => payload.kind !== 'text');
}

export function extensionFor(mime) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/svg+xml': 'svg', 'text/html': 'html', 'application/json': 'json', 'text/plain': 'txt',
    'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'model/gltf-binary': 'glb', 'application/pdf': 'pdf', 'application/gzip': 'gz', 'application/zip': 'zip',
  };
  return map[mime] || 'bin';
}

export function toDataUri(bytes, mime) {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
