# Synced Vault 0.2.3

Security, reliability, and release-quality update for Dropbox synchronization on Windows and iPhone.

## Important security action

Version 0.2.2 accidentally included a local `data.json` file in the source repository. The file and its history have been removed in 0.2.3, but the exposed Dropbox authorization must also be revoked in Dropbox. Users of that test build must reconnect Dropbox after updating.

## Changes

- Added a safe **Forget authorization** action. It removes the local token while preserving the device ID and synchronization baseline.
- Prevented a file recreated after the preview from racing with publication of a deletion tombstone.
- Allowed a live path to replace an old case-variant tombstone while continuing to reject two live paths that collide on Windows.
- Added manifest download and post-read file-size limits for safer mobile memory use.
- Added regression tests for case-variant tombstones.
- Added reproducible build input under `src/`, `versions.json`, CI, release asset verification, release notes, and GitHub artifact attestations.

## Upgrade notes

Back up the vault before updating. After installing 0.2.3, open **Settings → Synced Vault**, revoke the old app connection in Dropbox if you have not already done so, use **Forget authorization**, and authorize Dropbox again on every device. Keep Remotely Save disabled in any vault managed by Synced Vault.

Synchronization remains manual and preview-first. The maximum supported individual file size remains 100 MiB.
