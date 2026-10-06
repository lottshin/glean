# Contributing to Glean

Thanks for helping improve Glean. Keep changes focused, preserve user-owned Markdown data, and include verification appropriate to the behavior being changed.

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- Obsidian 1.6.6 or newer for manual UI testing

Install dependencies and run the checks:

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

Run the Obsidian plugin development build with:

```bash
npm run dev
```

Build the companion browser extension with:

```bash
npm run extension:build
```

Production builds embed the generated offline dictionary. Follow `docs/dictionary.md` to prepare `data/generated/`, then run `npm run build`.

## Contribution guidelines

- Keep pull requests limited to one coherent change.
- Add or update tests for parsing, scheduling, storage formats, imports, and other behavior that can regress silently.
- Treat Markdown notes and their frontmatter as public data formats. Existing notes must remain readable after an update.
- Do not commit API keys, receiver tokens, personal vault content, private media, or generated build output.
- Follow the existing TypeScript style and prefer Obsidian APIs over direct filesystem access where practical.
- Update user-facing documentation when behavior, settings, permissions, or network access changes.

## Bug reports

Include the Glean version, Obsidian version, operating system, steps to reproduce, and the actual result. Remove personal note content, local paths, tokens, and API keys from logs or screenshots before posting them.

## Third-party code and data

New dependencies, icons, dictionaries, media, and generated datasets must have redistribution terms compatible with this repository. Record required attribution or license text in `THIRD_PARTY_NOTICES.md`.
