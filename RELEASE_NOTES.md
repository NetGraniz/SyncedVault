# Synced Vault 0.2.0

Experimental Dropbox synchronization for Obsidian on Windows and iPhone.

## Changes

- Protects local files modified during sync from being overwritten by an older preview.
- Uses immutable SHA-256 file payloads, persistent deletion tombstones, and Dropbox revision-checked manifest updates to prevent stale devices from silently restoring deletions.
- Stores concurrent edits in `Sync Conflicts/`; integrates with Synced Trash's ordinary `Trash/` folder.
- Prevents accidentally changing the Dropbox App Key after authorization.
- Manual synchronization with a confirmation preview, plus optional `.obsidian` configuration sync.
- Updated author metadata, documentation, and simulated two-device regression tests.

## GitHub release instructions

Create a **published** GitHub Release with tag **`0.2.0`** (NOT `v0.2.0`). Upload **`main.js`**, **`manifest.json`**, and **`styles.css`** as three separate release assets, without renaming them. The repository's root `manifest.json` must also contain `"version": "0.2.0"`.

This is still an experimental build. Keep independent backups and do not enable Remotely Save and Synced Vault simultaneously on the same vault. Manual sync only; maximum single file size is 100 MiB.
