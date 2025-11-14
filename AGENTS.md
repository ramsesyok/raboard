# Repository Guidelines

## Project Structure & Module Organization
- `requirements.md` is the canonical functional spec; treat it as the source of truth when planning new work.
- Keep VS Code host logic under `extension/src/` (activation, commands, UNC helpers) and place the webview bundle under `media/` (HTML, CSS, client JS).
- Share pure TypeScript utilities in `extension/src/shared/` and mirror the UNC layout locally under `shared/rooms/<room>/{msgs,logs}` plus `shared/presence/<user>.json`.
- Tests live in `tests/unit/` and `tests/integration/`; fixtures for message logs sit in `tests/fixtures/rooms/general/` so flows can be replayed offline.

## Build, Test, and Development Commands
- `npm install` - install VS Code extension dependencies; rerun whenever `requirements.md` adds capabilities or when package-lock changes.
- `npm run watch` - incremental TypeScript compile plus webview bundling for tight feedback loops.
- `npm run lint` - ESLint + Prettier pass; must be clean before committing.
- `npm run package` - builds the VSIX artifact for sideloading into VS Code.
- `npm run test` - runs the unit suite; add `-- --grep "presence"` to focus a scenario.
- `npm run test:integration` - spins up a mock `\\mysv01\\board` tree under `.tmp/share` and validates presence/message flows end to end.

## Coding Style & Naming Conventions
- TypeScript/JSON use two-space indents, HTML sticks to two spaces, and PowerShell helpers may use four.
- camelCase functions and variables, PascalCase classes/enums, kebab-case filenames, except VS Code activation entry `extension.ts`.
- Spool files always follow `YYYY-MM-DDTHH-MM-SS-sssZ_<rand>.json`; keep a helper in `extension/src/shared/spool.ts` to format these names.
- Prefer explicit return types, avoid default exports, and never bypass the `object-src 'none'` CSP documented in the requirements.

## Testing Guidelines
- Use Vitest for fast unit coverage and `@vscode/test-electron` for activation plus filesystem integration tests.
- Mirror implementation paths when naming specs (e.g., `tests/unit/shared/presence.spec.ts`).
- Mock UNC access through the `.tmp/share` harness, covering success, jitter, and the "max 200 messages" truncation behavior.
- New features must include regression tests for spool naming, five-second polling, and presence expiry logic before requesting review.

## Commit & Pull Request Guidelines
- Keep commit subjects short and imperative (see `Initial commit`) or follow Conventional Commits such as `feat: support attachments`.
- Reference issue IDs or task links in the subject when available and squash noisy WIP commits locally.
- Every PR description should summarize the change, list `npm run lint && npm run test` results, and attach screenshots or GIFs when touching the webview.
- Request review before merging; CI must pass lint, unit, and integration workflows.

## Security & Configuration Tips
- Only mount `\\mysv01\\board` with least-privilege credentials and keep UNC paths out of committed configs; prefer placeholders like `\\example\\board` in docs.
- Never store secrets in source; keep tokens in `.env.local` and document required keys in `.env.example`.
- When watching the share, respect the five-second polling interval to avoid hammering the SMB server, and validate every attachment URL before rendering.
- Image support is limited to png/jpg/jpeg/svg; reject other types to stay within the CSP boundary and prevent data URI abuse.
