# Synced Vault

An **experimental, preview-first Dropbox sync plugin for Obsidian** on Windows and iPhone.

Synced Vault synchronizes your notes, attachments, images, and the visible `Trash/` folder used by Synced Trash. It saves deletion tombstones in Dropbox so that an out-of-date second device cannot silently restore a deleted note. Concurrent edits are preserved in `Sync Conflicts/` rather than discarded.

> **Version 0.2.3 is an early test release. Back up important notes before testing.** Automated tests cover mocked Dropbox and simulated Windows/iPhone vaults; they are not a substitute for a real two-device test.

## Synced Vault sidebar

Use the command palette (**Ctrl+P** on Windows) and run **Open Synced Vault panel**. The panel opens in the left sidebar and displays whether Dropbox authorization is stored, the last successful sync time, and buttons for **Sync now** and **Settings**. Drag its tab beside File explorer, Search and Synced Trash to arrange the icons however you like. Obsidian remembers the tab position in its local workspace settings.

**Sync now** opens the existing change preview; it never skips confirmation before applying changes. The original sync button in the Ribbon and the **Review and synchronize Dropbox vault** command remain available. **Connected to Dropbox** means a saved authorization token is present, not that a network request has just succeeded.

## Install

Copy **`manifest.json`**, **`main.js`**, and **`styles.css`** from the install archive to:

`<vault>/.obsidian/plugins/synced-vault/`

Enable the community plugin in **Obsidian → Settings → Community plugins**. Installation must be repeated on **each device**, including iPhone. The plugin uses standard Obsidian APIs, not Node.js or Electron.

## Dropbox setup

1. Open <https://www.dropbox.com/developers/apps/create> and create a **Scoped access → App folder** app. Create this app **once**; use its same App Key on both devices.
2. Enable Dropbox permissions **`files.content.read`**, **`files.content.write`**, and **`files.metadata.read`** in the app's Permissions tab. Save the settings. You might need to reauthorize after changing scopes.
3. In Obsidian, open **Settings → Synced Vault**. Enter the **App Key**, **not** the App Secret.
4. Keep the same **Vault ID**, e.g. `main`, on your Windows and iPhone Obsidian vaults. Use a unique ID for any unrelated vault.
5. Click **Open Dropbox**, approve access, and copy the one-time code back into the **Authorization code** field. Click **Connect**. Repeat on iPhone using the same App Key, account, and Vault ID.
6. Click **Preview sync** (or the circular-arrow ribbon icon). Read the proposed operations and click **Apply changes** to proceed. `push` uploads, `pull` downloads, `tombstone` records a local deletion, `remove` applies a remote deletion, and `conflict` preserves your local file in `Sync Conflicts/` before applying Dropbox's version.
7. Run **Preview sync** on the other device and confirm. Repeat when you want to synchronize changes. Conflict copies are uploaded on the next sync.

## Critical migration advice

**Do not run Remotely Save and Synced Vault simultaneously on a live vault.** First duplicate your vault to a **separate test vault**, disable Remotely Save in that copy, and try Synced Vault there on both devices. Synced Vault uses a separate Dropbox App Folder and never deletes Remotely Save's Dropbox data. Keep your existing Dropbox and local backups until you have validated repeated sync cycles, deletion, restoration, and conflicts yourself.

## Design

For each Vault ID, Dropbox stores a manifest at `/vaults/<id>/manifest.json`, plus immutable, SHA-256-named file payloads in `/vaults/<id>/blobs/`. The manifest records current paths and persistent deletion tombstones. Manifest updates use Dropbox's **revision-based conditional write**; a competing write fails rather than silently replacing another device's state. Each device records its last successfully synchronized hashes inside its local plugin settings, so it can distinguish a new edit from a deletion.

Conflicts favor the Dropbox version **only after the previous local version is saved** to `Sync Conflicts/`. The conflict copy can be reviewed and renamed manually. The plugin checks downloaded payloads against their content hashes before writing local files.

## Current limitations (v0.2.3)

- **Manual synchronization only**. There is no background synchronization or reliable iPhone background scheduling.
- **100 MiB per file** due to the current single-upload and memory budget. Larger attachments block the sync with an error; no files are intentionally changed. Chunked upload sessions are not yet implemented.
- The `.obsidian` configuration directory is **excluded by default**. You can opt in **before the first sync** to include most settings and community plugins. Workspace layout, Remotely Save configuration, and Synced Vault's own OAuth credentials and state are always excluded. The setting must be the same on both devices.
- `.trash`, `.git`, and empty directories are not synchronized. The visible **`Trash/` is synchronized**. All tombstones and immutable blobs remain in Dropbox indefinitely; server-side garbage collection is not implemented.
- OAuth refresh tokens are stored in Obsidian's local plugin data file. Protect your vault and device backups. Do not commit that file to GitHub.
- Changing the Dropbox account, App Key, or Vault ID after syncing is **not supported safely**. Make a backup and configure a fresh test vault instead.
- A local deletion racing with an update on another device resolves to the **newly updated remote note** (no note content is lost). A concurrent edit is saved as a conflict copy.
- Network interruption after a remote commit but before finishing local application can cause a **subsequent conflict copy**; review previews carefully and keep backups.
- This release has unit, mocked Dropbox-protocol, and simulated two-device tests, **not** a completed end-to-end validation on actual Windows, iPhone, or a real Dropbox account.
- A file modified while the preview is open or while its replacement is being downloaded aborts the local overwrite. Retry the sync to retain both versions.

## Development

The installed plugin has no runtime dependencies. Development source is kept in `src/main.js`; `npm run build` reproducibly creates the release `main.js`.

To run the built-in tests on a development machine with Node.js 18+:

```sh
npm ci
npm test
```

`package-lock.json` is committed so that CI can reproduce dependency resolution. The `.github/workflows/release.yml` workflow verifies the version tag, builds and tests the source, generates provenance attestations, and publishes a GitHub Release with a description taken from `RELEASE_NOTES.md` and the three installation files. Push the exact version tag from `manifest.json` **without** a `v` prefix. Let the workflow create the Release; do not create it manually first. GitHub Actions and workflow-token write permissions must be enabled.

### Why the community scanner flags vault enumeration

The sync engine must list the vault's files to compare changes, detect deletions, and protect conflicting edits. This use of `vault.getFiles()` is intentional; removing it would break full-vault synchronization. `.obsidian`, `.trash`, and other excluded paths are filtered by the plugin's sync rules, and vault contents are sent only to the Dropbox App Folder you authorize. The scanner may continue showing a **Vault Enumeration** recommendation even when the code is functioning as designed.

Source contributions and bug reports should include the Obsidian version, platform, proposed preview operations, and the redacted error message. **Never upload your OAuth code, token, or private notes.**

## License

MIT — see `LICENSE`.
