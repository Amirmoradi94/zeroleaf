# Crash and Error Reporting Policy

The private-alpha MVP uses local-first error reporting.

## Policy

- No automatic crash, analytics, telemetry, document, prompt, or provider data is
  sent to any remote service.
- Runtime errors are shown in the app status area when recoverable.
- Build logs and agent audit events remain local unless the user exports or shares
  them manually.
- Provider authentication is owned by the installed Codex or Claude Code CLI.
  The app does not collect or store provider secrets.
- Clearing local history removes stored snapshots, changesets, audit events,
  build-job rows, and agent-session rows from the app history database.

## Alpha Support Workflow

For private alpha debugging, users should share:

- App version and operating system.
- Whether `latexmk` is available.
- A copied error message or exported source bundle if they choose to share it.
- Steps that reproduce the issue.

Users should not share private subscription tokens, `.env` files, or unrelated
projects.
