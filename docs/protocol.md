# The SPL404 inscription protocol, version 1

The goal is that nothing here depends on SPL404 Forge. Given a signature and this
page, any client can rebuild and verify the same file from plain Solana RPC.

Everything is written with the SPL Memo program. Memos are UTF-8 text with no
account setup, no rent, and no program of our own to trust or maintain.

## A small payload is just a memo

If the bytes fit in one transaction, they are written verbatim: plain text, JSON,
or a data URI. There is no wrapper and no header. A reader treats the memo as
content and sniffs its type from the bytes themselves.

How much fits depends on the transaction format, and the client measures it
rather than assuming: it compiles a real transaction and binary-searches the
largest memo that still fits under 1,232 bytes (legacy) or 4,096 bytes (v1).

## A larger payload becomes chunks plus a manifest

### Chunk memo

```
spl404:c:<fileId>:<index>:<total>:<base64>
```

- `fileId`: the first 16 hex characters of the file's SHA-256.
- `index`: zero-based position, `total`: how many chunks exist.
- `base64`: standard base64 of this chunk's raw bytes.

A chunk knows which file it belongs to and where it sits, but not where the
other chunks are. That is deliberate: chunks are written before their signatures
can be known.

### Manifest memo

```json
{
  "p": "spl404",
  "v": 1,
  "t": "file",
  "name": "picture.png",
  "mime": "image/png",
  "size": 41234,
  "sha256": "7f83b1657ff1fc53b92dc18148a1d65dfa13514dcfd4f1f47ab49f22bbecda11",
  "chunks": ["<signature>", "<signature>", "…"]
}
```

The manifest is written last, in its own transaction, because it names the
signatures of the chunks. It is the only thing a reader needs: the chunk list is
the address of every part, and `sha256` is the proof they rebuilt correctly.

A manifest has to fit in one memo too, which is what caps file size. On v1 a
manifest lists several times more chunk signatures than a legacy one, and each
chunk carries more than three times the bytes, so the same wallet writes a much
larger file simply by supporting v1.

## Rebuilding

1. Read the manifest memo and validate it: `p` must be `spl404`, `t` must be
   `file`, and `sha256` must be 64 hex characters.
2. Fetch every signature in `chunks` with `maxSupportedTransactionVersion: 1`.
3. Parse each chunk memo. Reject any whose `fileId` does not match the first 16
   characters of the manifest hash: that chunk belongs to a different file.
4. Order by `index`, concatenate, and hash.
5. Render only if the hash equals `sha256` and the length matches `size`.

A rebuild that fails any check is reported, not displayed. Missing parts, mixed
files, and hash mismatches are each named separately so the failure is legible.

The reference implementation is `src/core/protocol.js`, with tests in
`src/core/protocol.test.js`.

## The public index

Listing is opt-in. A listed creation adds a zero-lamport transfer to a
program-derived address derived from the Memo program and the seed
`spl404-forge:registry`.

That address has no private key, so nobody can spend from it, change it, or
remove an entry. Its signature history is the feed, which means the feed is
readable with `getSignaturesForAddress` from any client, with no database and no
indexer. A creation that opts out is identical in every other way and remains
fully readable by anyone holding its signature.

## What this protocol does not do

It does not encrypt, compress, deduplicate, or grant ownership. It writes bytes
where they can be proven, and gives anyone the means to prove them.
