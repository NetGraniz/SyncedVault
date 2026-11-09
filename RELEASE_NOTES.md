# Synced Vault 0.2.1

Experimental Dropbox synchronization for Obsidian on Windows and iPhone.

## Changes

- Fixed the plugin description to comply with Obsidian Community review rules (removed the redundant product name). No user data migrations are required.
- Added a committed npm lockfile, reproducible test step, automated GitHub Release description, and build provenance attestations for the published assets.

- Protects local files modified during sync from being overwritten by an older preview.
- Uses immutable SHA-256 file payloads, persistent deletion tombstones, and Dropbox revision-checked manifest updates to prevent stale devices from silently restoring deletions.
- Stores concurrent edits in `Sync Conflicts/`; integrates with Synced Trash's ordinary `Trash/` folder.
- Prevents accidentally changing the Dropbox App Key after authorization.
- Manual synchronization with a confirmation preview, plus optional `.obsidian` configuration sync.
- Updated author metadata, documentation, and simulated two-device regression tests.

## GitHub release instructions

Commit this source and push tag **`0.2.1`** (NOT `v0.2.1`). GitHub Actions verifies the version, runs tests, creates provenance attestations, and publishes a Release containing **`main.js`**, **`manifest.json`**, and **`styles.css`** with these release notes as its description. Do not manually create the Release first.

The community scanner may continue recommending review of full-vault enumeration. This is an intentional core operation: the plugin must discover vault files to synchronize them. See the README for scope and limitations.

This is still an experimental build. Keep independent backups and do not enable Remotely Save and Synced Vault simultaneously on the same vault. Manual sync only; maximum single file size is 100 MiB.
