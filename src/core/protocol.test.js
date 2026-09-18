import { describe, expect, it } from 'vitest';
import {
  CHUNK_PREFIX,
  chunkCapacity,
  fileIdFor,
  manifestCapacity,
  manifestJson,
  maxChunkedFileSize,
  parseChunkMemo,
  parseManifest,
  planChunks,
  reassemble,
  sha256Hex,
} from './protocol.js';

const bytes = (length, seed = 7) => Uint8Array.from({ length }, (_, i) => (i * seed + 11) % 256);
const V1_MEMO = 3900;
const LEGACY_MEMO = 900;

function memosFor(source, budget) {
  const plan = planChunks(source, budget);
  const manifest = parseManifest(JSON.parse(manifestJson({
    name: 'thing.bin',
    mime: 'application/octet-stream',
    size: source.length,
    hash: plan.hash,
    chunks: plan.memos.map((_, i) => `sig${i}`.padEnd(88, '1')),
  })));
  return { plan, manifest };
}

describe('chunk planning', () => {
  it('keeps every chunk memo inside the budget it was planned for', () => {
    for (const budget of [LEGACY_MEMO, V1_MEMO]) {
      const { plan } = memosFor(bytes(40_000), budget);
      expect(plan.memos.length).toBeGreaterThan(1);
      for (const memo of plan.memos) {
        expect(memo.length).toBeLessThanOrEqual(budget);
        expect(memo.startsWith(CHUNK_PREFIX)).toBe(true);
      }
    }
  });

  it('needs far fewer chunks under a v1 budget than a legacy one', () => {
    const source = bytes(60_000);
    expect(planChunks(source, V1_MEMO).memos.length).toBeLessThan(planChunks(source, LEGACY_MEMO).memos.length / 3);
  });

  it('derives the file id from the content hash', () => {
    const source = bytes(5_000);
    const plan = planChunks(source, V1_MEMO);
    expect(plan.hash).toBe(sha256Hex(source));
    expect(plan.fileId).toBe(fileIdFor(plan.hash));
    expect(parseChunkMemo(plan.memos[0]).fileId).toBe(plan.fileId);
  });

  it('writes a single chunk for a payload that fits once', () => {
    expect(planChunks(bytes(100), V1_MEMO).memos).toHaveLength(1);
  });

  it('reports a capacity the manifest can actually list', () => {
    const capacity = manifestCapacity(V1_MEMO, { name: 'thing.bin', mime: 'application/octet-stream' });
    const chunks = Array.from({ length: capacity }, (_, i) => `s${i}`.padEnd(88, '1'));
    const memo = manifestJson({ name: 'thing.bin', mime: 'application/octet-stream', size: 1, hash: '0'.repeat(64), chunks });
    expect(memo.length).toBeLessThanOrEqual(V1_MEMO);
    expect(maxChunkedFileSize(V1_MEMO, { name: 'thing.bin', mime: 'application/octet-stream' })).toBeGreaterThan(chunkCapacity(V1_MEMO));
  });
});

describe('chunk parsing', () => {
  it('rejects anything that is not a well-formed chunk', () => {
    expect(parseChunkMemo('hello')).toBeNull();
    expect(parseChunkMemo(`${CHUNK_PREFIX}zz:0:1:AAAA`)).toBeNull();
    expect(parseChunkMemo(`${CHUNK_PREFIX}${'a'.repeat(16)}:2:2:AAAA`)).toBeNull();
    expect(parseChunkMemo(`${CHUNK_PREFIX}${'a'.repeat(16)}:0:1`)).toBeNull();
  });
});

describe('reassembly', () => {
  it('rebuilds the exact bytes from chunks in any order', () => {
    const source = bytes(9_000);
    const { plan, manifest } = memosFor(source, LEGACY_MEMO);
    const shuffled = [...plan.memos].reverse();
    const ordered = manifest.chunks.map((_, index) => shuffled[shuffled.length - 1 - index]);
    const result = reassemble(manifest, ordered);
    expect(result.verified).toBe(true);
    expect(result.problems).toEqual([]);
    expect(Array.from(result.bytes)).toEqual(Array.from(source));
  });

  it('refuses a rebuild with a missing part instead of returning half a file', () => {
    const source = bytes(9_000);
    const { plan, manifest } = memosFor(source, LEGACY_MEMO);
    const withHole = [...plan.memos];
    withHole[1] = null;
    const result = reassemble(manifest, withHole);
    expect(result.verified).toBe(false);
    expect(result.problems.join(' ')).toMatch(/missing/i);
  });

  it('refuses chunks that belong to a different file', () => {
    const { plan, manifest } = memosFor(bytes(9_000), LEGACY_MEMO);
    const other = planChunks(bytes(9_000, 13), LEGACY_MEMO);
    const mixed = [...plan.memos];
    mixed[0] = other.memos[0];
    const result = reassemble(manifest, mixed);
    expect(result.verified).toBe(false);
    expect(result.problems.join(' ')).toMatch(/different file/i);
  });

  it('refuses a rebuild whose hash does not match the manifest', () => {
    const source = bytes(4_000);
    const { plan, manifest } = memosFor(source, LEGACY_MEMO);
    const tampered = { ...manifest, hash: 'f'.repeat(64) };
    const result = reassemble(tampered, plan.memos);
    expect(result.verified).toBe(false);
    expect(result.problems.join(' ')).toMatch(/SHA-256/);
  });
});

describe('manifest parsing', () => {
  it('accepts only its own protocol and a real digest', () => {
    const valid = JSON.parse(manifestJson({ name: 'a', mime: 'text/plain', size: 2, hash: '0'.repeat(64), chunks: ['s'] }));
    expect(parseManifest(valid)).toMatchObject({ name: 'a', mime: 'text/plain', chunks: ['s'] });
    expect(parseManifest({ ...valid, p: 'other' })).toBeNull();
    expect(parseManifest({ ...valid, sha256: 'nope' })).toBeNull();
    expect(parseManifest({ ...valid, chunks: 'not-a-list' })).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });

  it('drops non-string entries from the chunk list', () => {
    const valid = JSON.parse(manifestJson({ name: 'a', mime: 'text/plain', size: 2, hash: '0'.repeat(64), chunks: ['s'] }));
    expect(parseManifest({ ...valid, chunks: ['s', 42, null] }).chunks).toEqual(['s']);
  });
});
