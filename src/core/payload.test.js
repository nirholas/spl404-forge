import { describe, expect, it } from 'vitest';
import { classifyBytes, classifyText, extensionFor, findEmbeddedDataUris, parseDataUri, sniffMime, toDataUri } from './payload.js';
import { isAddress, isSignature, parseTarget } from './input.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const ADDRESS = 'So11111111111111111111111111111111111111112';
const SIGNATURE = '4'.repeat(88);

describe('sniffing bytes', () => {
  it('recognizes real media by its signature, not its label', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(GIF)).toBe('image/gif');
    expect(sniffMime(Uint8Array.from([1, 2, 3]))).toBeUndefined();
    expect(classifyBytes(PNG)).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length });
  });

  it('treats unreadable bytes as binary rather than mangled text', () => {
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    expect(classifyBytes(noise).kind).toBe('binary');
  });

  it('reads UTF-8 bytes back as their text payload', () => {
    expect(classifyBytes(new TextEncoder().encode('a plain note')).kind).toBe('text');
  });
});

describe('classifying text', () => {
  it('parses JSON and tags a recognizable schema', () => {
    const payload = classifyText('{"p":"spl404","t":"agent","name":"x"}');
    expect(payload.kind).toBe('json');
    expect(payload.schema).toBe('agent');
    expect(classifyText('{"name":"Coin","image":"https://example.com/a.png"}').schema).toBe('token-metadata');
  });

  it('falls back to text when JSON does not parse', () => {
    expect(classifyText('{not json}').kind).toBe('text');
  });

  it('decodes a data URI into its real content', () => {
    const payload = classifyText(toDataUri(PNG, 'image/png'));
    expect(payload).toMatchObject({ kind: 'image', mime: 'image/png', dataUri: true });
    expect(payload.contentSize).toBe(PNG.length);
  });

  it('keeps SVG and HTML as source, never as something to render', () => {
    expect(classifyText('<svg viewBox="0 0 1 1"></svg>').kind).toBe('svg');
    expect(classifyText('<!doctype html><html></html>').kind).toBe('html');
  });

  it('finds data URIs buried inside longer strings', () => {
    const found = findEmbeddedDataUris(`Program log: metadata ${toDataUri(PNG, 'image/png')} end`);
    expect(found).toHaveLength(1);
    expect(found[0].mime).toBe('image/png');
  });

  it('rejects a data URI whose payload is not valid', () => {
    expect(parseDataUri('data:image/png;base64,!!!!')).toBeNull();
    expect(parseDataUri('https://example.com/a.png')).toBeNull();
  });

  it('maps mime types to the extension a download should use', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('model/gltf-binary')).toBe('glb');
    expect(extensionFor('application/x-unknown')).toBe('bin');
  });
});

describe('reading what a person pasted', () => {
  it('tells signatures and addresses apart', () => {
    expect(isSignature(SIGNATURE)).toBe(true);
    expect(isAddress(ADDRESS)).toBe(true);
    expect(isAddress('0OIl')).toBe(false);
  });

  it('accepts raw ids', () => {
    expect(parseTarget(` ${ADDRESS} `)).toMatchObject({ kind: 'address', id: ADDRESS });
    expect(parseTarget(SIGNATURE)).toMatchObject({ kind: 'tx', id: SIGNATURE });
  });

  it('pulls the id out of explorer links from any of the common explorers', () => {
    expect(parseTarget(`https://solscan.io/tx/${SIGNATURE}`)).toMatchObject({ kind: 'tx', id: SIGNATURE });
    expect(parseTarget(`https://explorer.solana.com/address/${ADDRESS}?cluster=devnet`)).toMatchObject({ kind: 'address', id: ADDRESS, network: 'devnet' });
    expect(parseTarget(`solana.fm/address/${ADDRESS}`)).toMatchObject({ kind: 'address', id: ADDRESS });
    expect(parseTarget(`https://solscan.io/token/${ADDRESS}?cluster=mainnet`)).toMatchObject({ kind: 'address', network: 'mainnet' });
  });

  it('explains itself instead of failing silently', () => {
    expect(() => parseTarget('')).toThrow('Paste a transaction');
    expect(() => parseTarget('hello world')).toThrow('does not look like');
    expect(() => parseTarget('https://example.com/nothing/here')).toThrow('No signature or address');
  });
});
