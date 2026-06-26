# Cloud Sharing Phase Audit

Date: 2026-06-25

Scope: C0-C5 from `docs/architecture/cloud-project-sharing.md`.

## Phase Status

| Phase | Requirement                                                                                                                                  | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0    | Project backend distinction, local adapter preservation, renderer project type display, agent routing by backend                             | `packages/project-service/src/project-gateway.ts` defines `ProjectBackendKind`, `ProjectGateway`, and `LocalProjectAdapter`; `packages/shared-project-client/src/index.ts` defines `SharedProjectGatewayAdapter`; `apps/desktop/src/renderer/App.tsx` displays Local/Shared project state and passes shared context into agent requests; `apps/desktop/src/main/index.ts` routes shared project tools through active shared project context. |
| C1    | Sign-in/session storage, shared list, create/open shared projects, server-backed file tree/read/write, source ZIP import                     | `packages/shared-project-server/src/index.ts` implements auth/session refresh, list/create/open file APIs, file revisions, settings, and source import/export routes; `apps/desktop/src/main/index.ts` persists shared session tokens and materializes shared projects; shared desktop E2E imports, exports, deletes, and creates from local projects.                                                                                       |
| C2    | Invitations, membership, Owner/Editor/Viewer roles, share UI, server permission enforcement                                                  | Server tests cover invitation/member permissions and viewer write rejection; desktop E2E proves owner invite, editor access, viewer read-only behavior, role change, member removal, and ownership transfer.                                                                                                                                                                                                                                 |
| C3    | Managed desktop cache, local compile from cache, uploaded PDF/log/diagnostic artifacts tied to source revision                               | `SharedProjectCache` materializes server source; real collaboration gate runs local `pdflatex` from cache and uploads PDF/log/diagnostic artifact; owner inspection verifies PDF byte length.                                                                                                                                                                                                                                                |
| C4    | Yjs-backed text collaboration, presence, remote cursor/display, collaborative update persistence                                             | Client/server use Yjs document updates; real collaboration gate proves owner/editor concurrent edits, presence event, owner realtime receipt of editor `document.updated`, reconnect catch-up, and converged final source.                                                                                                                                                                                                                   |
| C5    | Shared agent support through gateway, audit events, reviewable changesets/collaborative patches, local compile verification, artifact upload | Real Codex gate uses connected Codex CLI, failed local compile, reviewable changeset, server apply, realtime agent/document/file/build/run events, successful local compile verification, audit events, and uploaded artifact inspection.                                                                                                                                                                                                    |

## Fresh Verification

- `npm run format:check` passed.
- `npm run test` passed: 31 files, 388 tests.
- `npm run build` passed.
- `npm run lint` passed.
- `git diff --check` passed.
- `E2E_ONLY_SHARED=1 npm run e2e` passed.
- `npm run shared:collab:real` passed and wrote `docs/qa/real-shared-collaboration-2026-06-25/report.json`.
- `npm run shared:codex:real` passed and wrote `docs/qa/real-shared-codex-agent-2026-06-25/report.json`.
- `npm run package:mac` passed and created `/var/folders/81/_btlkg4s2vqcv347np6233h80000gn/T/zeroleaf-release/ZeroLeaf.app`.
- `/Applications/ZeroLeaf.app` was replaced with the packaged bundle via `ditto --norsrc`, quarantine attributes were cleared, and `codesign --verify --deep --strict /Applications/ZeroLeaf.app` passed.
- Installed app launch smoke passed: `pgrep -fl ZeroLeaf` found `/Applications/ZeroLeaf.app/Contents/MacOS/ZeroLeaf`.
- `npm run onlyoffice:status` passed: `zeroleaf-onlyoffice-dev` running, `http://127.0.0.1:8082`, API script reachable with HTTP 200.

## Real Evidence Highlights

- Real collaboration report: editor and viewer invitations, local compile artifact, realtime presence, owner/editor document updates, source export, and PDF byte length.
- Real Codex report: Codex auth connected, initial compile failed, verified compile succeeded, realtime running/proposed/applied/document/file/build/completed events, audit event count, and PDF byte length.
- Shared desktop E2E: shared project lifecycle, viewer read-only enforcement, collaborator build inspection by viewer, comments, revision restore, member role updates, member removal, ownership transfer, source ZIP import/export/delete, and local-to-shared project creation.

## Residual Risk

- The implementation is verified in local development and Electron E2E harnesses, not against a deployed multi-tenant production server.
- The installed macOS app has been replaced and launch-smoked on this machine, but notarized release packaging and remote deployment are outside this local implementation scope.
