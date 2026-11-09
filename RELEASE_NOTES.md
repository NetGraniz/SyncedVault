# Synced Vault 0.2.2

Small usability update for Dropbox synchronization on Windows and iPhone.

## Changes

- Added a **Synced Vault** sidebar tab showing Dropbox authorization status, last successful sync, **Sync now** and **Settings**.
- Open the panel in the left sidebar with **Open Synced Vault panel** from the command palette. Drag its tab next to File explorer and Search to arrange the icons.
- **Sync now** uses the existing preview-and-confirm sync. The previous Ribbon sync button and settings still work.
- Added three panel tests and a reproducible `npm run build` command.
- No changes to Dropbox authentication, data format, deletion tombstones or conflict handling. No data migration required from 0.2.1.

## GitHub release instructions

Commit this source and push tag **`0.2.2`** (NOT `v0.2.2`). GitHub Actions verifies the version, builds and tests the source, creates provenance attestations, and publishes a Release containing **`main.js`**, **`manifest.json`**, and **`styles.css`** with these release notes as its description. Do not manually create the Release first.

The community scanner may continue recommending review of full-vault enumeration. This is an intentional core operation: the plugin must discover vault files to synchronize them. See the README for scope and limitations.

This is still an experimental build. Keep independent backups and do not enable Remotely Save and Synced Vault simultaneously on the same vault. Manual sync only; maximum single file size is 100 MiB.
