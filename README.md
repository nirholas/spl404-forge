# SPL404 Forge

Paste any Solana signature, address, or explorer link and see what is actually inside it: the memos, the data URIs, the images buried in instruction data, the JSON a token really stores. Then put your own bytes there, with your own wallet, in one memo or as a verifiable chunked file.

There is no backend. The page talks to Solana JSON-RPC directly and decodes every byte in your browser.

> **Status:** works on mainnet and devnet. Writing to mainnet spends real SOL and is public and permanent. Rehearse on devnet.

## What it does

**Inspect.** Transactions, wallets, mints, and program accounts. It flattens inner instructions, decodes every memo, carves images out of opaque buffers, finds data URIs hidden inside program logs, and reports the transaction's real wire size against its version's limit. For a token it says plainly where the metadata and image actually live, which is usually not on Solana.

**Rebuild.** A file written by this protocol is split into chunk memos plus one manifest that lists their signatures and the SHA-256 they must produce. The inspector fetches every chunk, rebuilds the bytes, and refuses to render anything whose hash does not match. Given only one chunk, it can search the signer's later transactions for the manifest.

**Inscribe.** Text, JSON, or a file. Small payloads are one memo. Anything larger is chunked automatically, with the manifest written last because it has to name signatures that do not exist yet. Chunk signatures survive a failed manifest step, so nothing you already paid for is lost.

**Feed.** Creations can tag a program-derived index address with a zero-lamport transfer. That address has no private key and nobody controls it, so the public feed is just its signature history, read live from the chain.

## Transaction v1

v1 (SIMD-0385) raises the wire limit from 1,232 to 4,096 bytes and moves compute and loaded-account limits out of ComputeBudget instructions into the message itself, where an unset limit means zero rather than a default. This app uses v1 whenever the connected wallet advertises it and falls back to legacy transactions otherwise. The practical difference: a file takes roughly a quarter as many transactions on v1, and a manifest can list several times more chunks.

All transaction reads pass `maxSupportedTransactionVersion: 1`, so v1 transactions are visible here even where other tools still show nothing.

## Quick start

```bash
npm ci
npm run dev     # http://localhost:5173
npm test        # protocol, payload, and input parsing
npm run build   # static output in dist/
```

Node 20+. No API keys, no accounts, no server.

## Deploy

The build is a static directory. Any host works:

```bash
npm run build
npx wrangler pages deploy dist --project-name spl404-forge
```

Public RPC endpoints are rate limited. For real traffic set `VITE_SOLANA_RPC_URL` and `VITE_SOLANA_DEVNET_RPC_URL` (see [.env.example](./.env.example)), or let each viewer add their own endpoint in Settings, which is stored only in their browser. Never put a credentialed URL in a `VITE_*` variable; it ships to every visitor.

## Safety model

- Keys never reach this page. Wallets sign, and nothing is sent without a wallet prompt.
- On-chain bytes are written by strangers, so they are never inserted as HTML or executed. Images, audio, and video render through object URLs; SVG and HTML are shown as source text only, because both can carry script.
- A chunked file is rendered only after its rebuilt bytes match the hash recorded in its manifest.
- A Content Security Policy ([public/_headers](./public/_headers)) allows scripts only from this origin and media only from local `blob:` and `data:` URLs, and forbids plugins and framing. Network requests may go to any `https:` origin, because a viewer can point the app at their own RPC endpoint.
- Sign-In With Solana verifies the returned signature against the account's own public key before the session is trusted.
- Everything written here is public and permanent. Do not inscribe secrets, personal data, or content you do not have the rights to.

## How it is put together

| Path | What lives there |
| --- | --- |
| `src/core/` | Chain reads, the protocol, transaction building, wallet and session handling. No DOM. |
| `src/ui/` | Views and components. Renders what core returns; never talks to RPC itself. |
| `src/scene/` | The three.js backdrop. Decoration only, and skipped under reduced motion. |
| `docs/` | The [inscription protocol](./docs/protocol.md) and the [architecture](./docs/architecture.md). |

The protocol is deliberately small enough to reimplement without this app: read [docs/protocol.md](./docs/protocol.md) and you can write and rebuild the same files from any client.

## License

MIT. See [LICENSE](./LICENSE).
