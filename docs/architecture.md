# Architecture

A static page, a wallet, and Solana RPC. There is no server, database, upload
service, session store, or custody anywhere in the path.

## Layers

| Layer | Rule |
| --- | --- |
| `src/core/` | Talks to the chain and to wallets. Never touches the DOM. |
| `src/ui/` | Renders what core returns. Never calls RPC itself. |
| `src/scene/` | Decoration. Never blocks input and never affects behavior. |

That split is what makes the core reusable: another client can import
`src/core/protocol.js` and rebuild a file with no browser at all.

## Modules that carry the weight

- **`core/rpc.js`** wraps JSON-RPC with ordered failover. Reads retry on the next
  endpoint when one is rate limited or unreachable; application errors, like a
  rejected transaction, surface immediately rather than being retried into
  confusion.
- **`core/tx.js`** builds messages for either wire format from one call site.
  Under v1 the compute limit, priority fee, and loaded-accounts budget are
  message config; under legacy they become ComputeBudget instructions. It also
  measures the largest memo that fits, packs instruction groups into as few
  transactions as possible, and sizes compute from a real simulation rather
  than a guess.
- **`core/inscribe.js`** turns a payload into a plan before anything is signed:
  one memo, or chunks plus a manifest, with the exact transaction count and the
  reason it cannot be written when it cannot.
- **`core/inspect-tx.js`** flattens outer and inner instructions, decodes memos,
  scans instruction data and program logs for embedded content, and resolves
  manifests into verified files.
- **`core/inspect-account.js`** reads mints through both Token-2022 metadata and
  Metaplex, then reduces "where does this token actually live" to one verdict.
- **`core/wallet.js`** discovers Wallet Standard wallets, reports which
  transaction versions each advertises, and verifies a Sign-In With Solana
  signature locally before trusting it.

## Writing a file

1. Measure the memo budget for the connected wallet's transaction version.
2. Plan: one memo, or chunk memos plus a manifest. The plan is shown before any
   wallet prompt, including the transaction count and estimated fee.
3. Simulate once to size compute for the batch. Every transaction in the batch
   has the same shape, so one simulation is enough.
4. Sign the whole batch in one wallet prompt.
5. Send each transaction, rebroadcasting until it confirms or its blockhash
   expires.
6. Write the manifest naming the confirmed chunk signatures.

Chunks and the manifest cannot be atomic: the manifest has to name signatures
that do not exist until the chunks land. So chunk signatures are returned even
when the manifest step fails, and the interface says so rather than pretending
the write simply failed.

## Trust boundaries

Every byte read from the chain is treated as hostile. Payloads are rendered
through object URLs, never inserted as HTML; SVG and HTML are shown as source
text; unrecognized types are offered as downloads and nothing else. A chunked
file is not rendered until its hash matches its manifest.

Keys never enter the page. The wallet holds them and displays every transaction
before signing. Settings, including any custom RPC endpoint, stay in
`localStorage` and are never transmitted anywhere.

## Failure behavior

RPC failure, a wallet rejection, an expired blockhash, and an insufficient
balance each get their own message, because each has a different fix.
`core/tx.js` maps raw Solana errors and program logs to those messages in one
place, so the same failure reads the same way everywhere in the app.
