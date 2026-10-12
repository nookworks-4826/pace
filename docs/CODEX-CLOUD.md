# Pace: Codex Cloud configuration

This document specifies the reusable environment. It does not confirm that an environment has been created or published.

## Configuration

| Setting | Value |
| --- | --- |
| Suggested name | `Pace Cloud` |
| Repository | `nookworks-4826/pace` |
| Development branch | `cloud/pace-development-20261012` |
| Runtime | Node.js 24, npm, Git, Bash, Chromium with Linux dependencies |
| Install script | `bash scripts/codex-cloud-setup.sh` |
| Start command | `bash scripts/codex-cloud-start.sh` |
| Preview port | `5173` |
| Tests | `bash scripts/codex-cloud-check.sh` |
| Privacy / Who can use | **Only me** |
| App environment variables | None required for local development |
| Secrets | None required |

If the cloud image uses another Node version, ask the environment setup agent to install and persist Node.js 24 before running the install script. Scripts deliberately fail on another major version, rather than using different build tooling silently.

Enable the Package managers network preset during setup. Chromium installation may also need `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`; Node installation may need `nodejs.org`. Add only download hosts required by the setup logs. The application itself uses same-origin OCR assets and does not need banking API credentials. Review the actual saved network settings before publishing.

The start skill should run the start command as a persistent development process, wait for an HTTP 200 response at `http://127.0.0.1:5173/`, then show the cloud preview. Run the existing browser checks with isolated profiles and fictional fixtures. Do not open real financial data in the preview.

## Verify and publish

1. Reuse a matching existing environment if available; otherwise create one using this repository.
2. Configure Node 24, the install script, the start skill, the required download domains and **Only me**.
3. Run installation and `bash scripts/codex-cloud-check.sh` inside Codex Cloud. Verify the running development preview as well.
4. Record the successful commands and any unavailable test fixtures. `test:preservation` needs a separate 2.2.0 build; the normal checks above do not assert old-version update preservation.
5. Save the environment and select **Publish** only after resolving setup failures. Confirm **Environment published**.
6. Start a fresh cloud task from the published environment and confirm the server and tests still run.

Saving scripts or passing GitHub Actions checks is preparation. Neither action proves that Codex Cloud installation, preview or Publish succeeded.

## Start from Galaxy

In the ChatGPT mobile app, open Codex and select the published **Pace Cloud** environment. If that entry is unavailable, use ChatGPT in the phone's browser, choose **Work in > Cloud**, then select the environment. Send a development request and specify the development branch. Reopen the same cloud task to continue its saved working files.

Each new task starts from the published environment's prepared filesystem. A local PC conversation, local unsaved code or an unpushed change is not transferred automatically. Commit approved source changes to a development branch and summarize any context the cloud task needs.

## Production boundary

The existing deployment workflow runs on pushes to `main`. Keep development on the branch above and do not merge, push to main, run the Pages workflow or deploy the application as part of environment setup. Publishing a cloud environment prepares a development workspace; it does not publish the PWA.

Official guide: https://learn.chatgpt.com/docs/environments/cloud-environments
