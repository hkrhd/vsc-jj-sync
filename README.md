# jj-sync

Auto-commit and push Jujutsu (jj) changes when a workspace folder has been idle for 3 minutes.

## Features

- Watches file create/change/delete/rename in a workspace folder.
- After 3 minutes of no file activity, runs `jj commit` and `jj git push -b main`.
- Pulls on startup, on a 1-minute interval, and before push (`jj git fetch` + `jj git import`).
- Ignores changes under `.jj/` to avoid feedback loops.
- If `.gitignore` is missing, sync is blocked until the user explicitly enables it.

## Requirements

- `jj` must be available on PATH.
- A Git remote must exist for `jj git push -b main`.

## Extension Settings

- `jjSync.enabled`: Enable auto-sync for this workspace folder (scope: resource).

## Usage

1. Open the workspace folder.
2. Set `jjSync.enabled` to `true` in the folder settings.
3. Make changes and wait for 3 minutes of inactivity.

## Known Issues

- If pull fails, it will retry after the next file change and show a notification.
