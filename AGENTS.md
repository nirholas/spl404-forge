# AGENTS.md

Operating notes for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Everything here is derived from the files actually in the tree, so trust it over guesses, and update it when the facts change.

## What this repository is

See what is really inside a Solana transaction, then inscribe your own files on-chain with your wallet. Transaction v1 ready.

- Homepage: https://spl404-forge.pages.dev
- Source: https://github.com/nirholas/spl404-forge
- Primary language: JavaScript
- License: Apache License 2.0 (see the LICENSE file)

## Repository layout

- `docs/`
- `public/`
- `src/`
- `README.md`
- `LICENSE`
- `package.json`

## Setup

```bash
npm install
```

## Commands

| Task | Command |
|---|---|
| dev | `npm run dev` |
| build | `npm run build` |
| test | `npm test` |

Run the test and lint commands above before you consider a change finished. If a command fails on code you did not touch, say so in your report instead of silently skipping it.

## Conventions

- `.env` files are gitignored; never commit credentials, and read configuration from environment variables.
- Commit messages follow Conventional Commits (`type(scope): summary`), matching the existing history.
- Read the surrounding code before adding to it, and match its naming, file organisation and error-handling style.
- Keep `README.md` accurate: if a change alters behaviour, commands or configuration, update the docs in the same commit.
- Do not leave TODO comments, stub functions, placeholder data or commented-out code behind. Finish what you start or leave it out.
- Small, focused commits with a subject line that describes the change, not the act of committing.

## Where to raise things

- Bugs and feature requests: https://github.com/nirholas/spl404-forge/issues
- Questions and ideas: https://github.com/nirholas/spl404-forge/discussions
- Security issues: report privately at https://github.com/nirholas/spl404-forge/security/advisories/new, never in a public issue.
