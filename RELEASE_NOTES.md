# Synced Vault 1.0.0

The first stable release of preview-first Dropbox synchronization for Obsidian on Windows and iPhone.

## Stable release

- Validated through several weeks of daily use across multiple Windows PCs and iPhones with a real Dropbox account.
- Covered by automated planning, Dropbox protocol, conflict, deletion, race-protection, panel, and simulated two-device tests.
- Declares the existing manifest v1 format stable. Future incompatible formats will use an explicit migration.
- Removes the experimental and early-test labels without changing synchronization behavior or stored data.

## Safety model

- Every synchronization displays a complete preview and requires confirmation.
- Dropbox manifest writes use revision-based compare-and-swap protection.
- Concurrent local edits are preserved in `Sync Conflicts/` before the Dropbox version is applied.
- Downloaded file payloads are verified against their SHA-256 hashes.
- Persistent deletion tombstones prevent an old offline device from silently restoring a deleted note.

## Upgrade notes

No migration or reconnection is required when upgrading from 0.2.3. Continue using the same Dropbox App Key and Vault ID. Do not run another full-vault sync plugin on the same vault at the same time, and keep independent backups of important notes.

Synchronization remains manual and preview-first. The maximum supported individual file size remains 100 MiB.
