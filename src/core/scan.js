import { classifyBytes, classifyText, findEmbeddedDataUris } from './payload.js';

function indexOfSequence(bytes, sequence, from = 0) {
  outer: for (let i = from; i <= bytes.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) if (bytes[i + j] !== sequence[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfSequence(bytes, sequence) {
  outer: for (let i = bytes.length - sequence.length; i >= 0; i--) {
    for (let j = 0; j < sequence.length; j++) if (bytes[i + j] !== sequence[j]) continue outer;
    return i;
  }
  return -1;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const JPEG = [0xff, 0xd8, 0xff];
const JPEG_END = [0xff, 0xd9];
const GIF = [0x47, 0x49, 0x46, 0x38];
const RIFF = [0x52, 0x49, 0x46, 0x46];

function carveImages(bytes) {
  const found = [];
  let at = indexOfSequence(bytes, PNG);
  if (at >= 0) {
    const end = indexOfSequence(bytes, PNG_END, at);
    found.push(bytes.subarray(at, end >= 0 ? end + PNG_END.length : bytes.length));
  }
  at = indexOfSequence(bytes, JPEG);
  if (at >= 0) {
    const end = lastIndexOfSequence(bytes, JPEG_END);
    if (end > at) found.push(bytes.subarray(at, end + 2));
  }
  at = indexOfSequence(bytes, GIF);
  if (at >= 0) found.push(bytes.subarray(at));
  at = indexOfSequence(bytes, RIFF);
  if (at >= 0 && at + 12 <= bytes.length) {
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    found.push(bytes.subarray(at, Math.min(bytes.length, at + 8 + size)));
  }
  return found;
}

function printableRuns(bytes, minLength) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const b = bytes[i];
    const printable = i < bytes.length && ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09);
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= minLength) runs.push(new TextDecoder().decode(bytes.subarray(start, i)));
      start = -1;
    }
  }
  return runs;
}

/**
 * Looks for human-meaningful content inside opaque program data: whole-buffer media,
 * images carved out of larger buffers, data URIs, JSON, and long readable strings.
 */
export function scanBytes(bytes, { minText = 48 } = {}) {
  if (!bytes?.length) return [];
  const whole = classifyBytes(bytes);
  if (whole.kind !== 'binary') return [whole];

  const payloads = carveImages(bytes).map((part) => classifyBytes(part)).filter((p) => p.kind === 'image');
  for (const run of printableRuns(bytes, minText)) {
    const embedded = findEmbeddedDataUris(run);
    if (embedded.length) payloads.push(...embedded);
    else payloads.push(classifyText(run));
  }
  return payloads;
}
