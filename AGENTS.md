# Pace development

Pace is a React, TypeScript and Vite PWA. Financial records live in the user's browser; the development environment does not need a production database or service credentials.

## Runtime and commands

- Use Node.js 24 and the committed npm lockfile.
- Prepare a Linux cloud workspace: `bash scripts/codex-cloud-setup.sh`.
- Start the development server: `bash scripts/codex-cloud-start.sh` (port 5173 by default).
- Check readiness at `http://127.0.0.1:5173/` before opening the environment's preview.
- Run the existing unit, build, privacy and browser checks: `bash scripts/codex-cloud-check.sh`.
- Run targeted tests with `npm test -- <test-path>`; run `npm run typecheck` for type checking.
- `npm run test:preservation` additionally needs a separate 2.2.0 build through `PACE_QA_PREVIOUS_DIST`; report it as unrun if that fixture is unavailable.

## Data and publication

- Use fictional test fixtures and disposable browser contexts only. Never use an existing personal browser profile or real receipts, transactions, balances or backups.
- Do not commit .env files, credentials, private keys, user exports, browser profiles, databases, `node_modules`, build output or test output.
- Work on a development branch. Pushing or merging to `main` starts the existing GitHub Pages production deployment. Environment setup and Publish do not authorize application deployment.
- Keep the cloud environment's access set to **Only me**.
- Local conversations, unsaved editor buffers and unpushed local changes do not automatically become cloud task state. Review and commit intended code changes to an appropriate branch.

See `docs/CODEX-CLOUD.md` for the environment configuration and verification requirements.
