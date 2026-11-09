/* Synced Vault 0.2.1 — single-file, mobile-compatible Obsidian plugin. */
'use strict';

const { Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, TFile, normalizePath } = require('obsidian');
const MAX_FILE = 100 * 1024 * 1024; // Conservative memory bound for iOS and Dropbox's single upload API.
const MANIFEST_VERSION = 1;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const asBytes = (buffer) => buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const toHex = (buffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
const hashBytes = async (bytes) => toHex(await globalThis.crypto.subtle.digest('SHA-256', asBytes(bytes)));
const utf8 = new TextEncoder();
const decode = new TextDecoder();
const clone = obj => JSON.parse(JSON.stringify(obj));
const errorText = e => String(e && e.message ? e.message : e);

function safePath(path, configFolder = '.obsidian') {
  if (typeof path !== 'string' || !path || path.length > 800 || path.includes('\\') || path.startsWith('/') || path.includes('\0')) return false;
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\u0000-\u001f]/.test(p))) return false;
  // A path created on iOS must also be representable on Windows.
  if (parts.some(p => /[<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p))) return false;
  if (parts[0] === '.trash' || parts[0] === '.git' || parts[0] === '.synced-vault') return false;
  if (parts[0] === configFolder) {
    if (parts.length === 1) return false;
    if (/^workspace(-mobile)?\.json$/.test(parts[1])) return false;
    if (parts[1] === 'plugins' && ['synced-vault', 'remotely-save'].includes(parts[2])) return false;
  }
  return true;
}

function planChanges(local, remoteEntries, baseline) {
  const result = [];
  const paths = new Set([...Object.keys(local), ...Object.keys(remoteEntries), ...Object.keys(baseline)]);
  for (const path of [...paths].sort()) {
    const remote = remoteEntries[path];
    const current = own(local, path) ? local[path] : null;
    const remoteHash = remote && !remote.deleted ? remote.blob : null;
    const previous = own(baseline, path) ? baseline[path] : null;
    const localChanged = current !== previous;
    // A new device MUST NOT resurrect a remotely deleted item, even when
    // the device has never seen its deletion tombstone.
    const remoteChanged = remoteHash !== previous || (!!remote?.deleted && !own(baseline, path) && current !== null);
    if (current === remoteHash && !(remote?.deleted && current !== null)) continue;
    if (localChanged && remoteChanged) {
      if (current !== null) result.push({ type: 'conflict', path, hash: current, remoteHash });
      else if (remoteHash !== null) result.push({ type: 'pull', path, hash: remoteHash });
      continue;
    }
    if (localChanged) {
      result.push(current === null ? { type: 'tombstone', path } : { type: 'push', path, hash: current });
    } else if (remoteChanged) {
      result.push(remoteHash === null ? { type: 'remove', path } : { type: 'pull', path, hash: remoteHash });
    }
  }
  return result;
}

function validateManifest(manifest, configFolder) {
  if (!manifest || manifest.version !== MANIFEST_VERSION || !manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) {
    throw new Error('Dropbox manifest is invalid or from an unsupported version. Nothing was changed.');
  }
  const paths = Object.keys(manifest.entries);
  if (paths.length > 100000) throw new Error('Manifest contains too many entries.');
  const seen = new Set();
  for (const path of paths) {
    if (!safePath(path, configFolder)) throw new Error('Unsafe file path in Dropbox manifest: ' + path);
    const key = path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error('Case-colliding files in Dropbox manifest: ' + path);
    seen.add(key);
    const entry = manifest.entries[path];
    if (!entry || typeof entry !== 'object') throw new Error('Invalid manifest item: ' + path);
    if (entry.deleted !== true && !/^[a-f0-9]{64}$/.test(entry.blob || '')) throw new Error('Invalid file hash: ' + path);
    if (entry.deleted !== true && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE)) throw new Error('Unsupported file size: ' + path);
  }
  return manifest;
}

function caseCollision(paths) {
  const seen = new Map();
  for (const path of paths) {
    const lower = path.toLocaleLowerCase('en-US');
    if (seen.has(lower) && seen.get(lower) !== path) throw new Error('Case-colliding files: ' + seen.get(lower) + ' and ' + path);
    seen.set(lower, path);
  }
}

function escapeDropboxHeader(value) {
  // HTTP headers must contain ASCII only, including non-English filenames.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

class DropboxClient {
  constructor(appKey, refreshToken, namespace) {
    this.appKey = appKey;
    this.refreshToken = refreshToken;
    this.base = '/vaults/' + namespace;
    this.accessToken = '';
  }

  static async authorize(appKey, verifier, code) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: appKey, code_verifier: verifier }).toString();
    const response = await requestUrl({url: 'https://api.dropbox.com/oauth2/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body, throw:false});
    if (response.status !== 200 || !response.json?.refresh_token) throw new Error('Dropbox authorization failed: ' + response.text.slice(0, 300));
    return response.json.refresh_token;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    const body = new URLSearchParams({ grant_type:'refresh_token', client_id:this.appKey, refresh_token:this.refreshToken }).toString();
    const response = await requestUrl({url:'https://api.dropbox.com/oauth2/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body, throw:false});
    if (response.status !== 200 || !response.json?.access_token) throw new Error('Dropbox token refresh failed: ' + response.text.slice(0, 300));
    this.accessToken = response.json.access_token;
    return this.accessToken;
  }

  async rpc(endpoint, args) {
    const response = await requestUrl({url:'https://api.dropboxapi.com/2/' + endpoint, method:'POST', headers:{'Authorization':'Bearer ' + await this.token(), 'Content-Type':'application/json'}, body:JSON.stringify(args), throw:false});
    return response;
  }

  async content(endpoint, args, body) {
    return requestUrl({url:'https://content.dropboxapi.com/2/' + endpoint, method:'POST', headers:{'Authorization':'Bearer ' + await this.token(), 'Content-Type':'application/octet-stream', 'Dropbox-API-Arg':escapeDropboxHeader(args)}, body:body || new ArrayBuffer(0), throw:false});
  }

  async metadata(path) {
    const response = await this.rpc('files/get_metadata', {path});
    if (response.status === 200) {
      if (response.json?.['.tag'] === 'folder') return response.json;
      if (!response.json?.rev) throw new Error('Dropbox returned invalid file metadata: ' + path);
      return response.json;
    }
    if (response.status === 409 && /not_found/.test(response.text)) return null;
    throw new Error('Dropbox metadata error ' + response.status + ': ' + response.text.slice(0, 280));
  }

  async ensureRemoteFolders() {
    for (const path of ['/vaults', this.base, this.base + '/blobs']) {
      const response = await this.rpc('files/create_folder_v2', {path, autorename:false});
      if (response.status === 200) continue;
      if (response.status !== 409) throw new Error('Cannot create Dropbox folder ' + path + ': HTTP ' + response.status);
      const existing = await this.metadata(path);
      if (!existing || existing['.tag'] !== 'folder') throw new Error('Dropbox path is not a folder: ' + path);
    }
  }

  async getManifest() {
    const path = this.base + '/manifest.json';
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.metadata(path);
      if (!before) return {rev:null, data:{version:MANIFEST_VERSION, entries:{}}};
      const response = await this.content('files/download', {path});
      if (response.status !== 200) throw new Error('Cannot download Dropbox manifest: HTTP ' + response.status);
      const after = await this.metadata(path);
      if (after && before.rev === after.rev) return {rev:after.rev, data:JSON.parse(decode.decode(response.arrayBuffer))};
    }
    throw new Error('Dropbox manifest changed during download. Try again.');
  }

  async downloadBlob(hash, size) {
    if (size > MAX_FILE) throw new Error('File exceeds maximum supported size.');
    const response = await this.content('files/download', {path:this.base + '/blobs/' + hash});
    if (response.status !== 200) throw new Error('Cannot download file payload: HTTP ' + response.status);
    const bytes = response.arrayBuffer;
    if (bytes.byteLength !== size || await hashBytes(bytes) !== hash) throw new Error('Dropbox payload failed integrity check: ' + hash);
    return bytes;
  }

  async uploadBlob(hash, bytes) {
    const path = this.base + '/blobs/' + hash;
    const response = await this.content('files/upload', {path, mode:'add', autorename:false, strict_conflict:true}, bytes);
    if (response.status === 200) return;
    if (response.status === 409) {
      // Existing immutable object must be verified, never blindly trusted.
      await this.downloadBlob(hash, bytes.byteLength);
      return;
    }
    throw new Error('Dropbox blob upload failed: HTTP ' + response.status + ' ' + response.text.slice(0, 200));
  }

  async commitManifest(manifest, rev) {
    const path = this.base + '/manifest.json';
    const mode = rev ? {'.tag':'update', update:rev} : 'add';
    const bytes = utf8.encode(JSON.stringify(manifest));
    const response = await this.content('files/upload', {path, mode, autorename:false, strict_conflict:true}, asBytes(bytes));
    if (response.status === 409) throw new Error('Dropbox state changed on another device. No local files were modified. Run sync again.');
    if (response.status !== 200) throw new Error('Dropbox manifest commit failed: HTTP ' + response.status + ' ' + response.text.slice(0, 200));
    return response.json.rev;
  }
}

class PreviewModal extends Modal {
  constructor(app, operations) { super(app); this.operations = operations; this.result = null; }
  onOpen() {
    this.setTitle('Synced Vault — Review changes');
    const {contentEl} = this;
    const counts = this.operations.reduce((a, op) => {a[op.type] = (a[op.type] || 0) + 1; return a;}, {});
    contentEl.createEl('p', {text:Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Everything is up to date.'});
    contentEl.createEl('p', {text:'Review every change. Remote deletions permanently remove the local original after confirmation; conflicts keep a separate local copy.', cls:'synced-vault-danger'});
    const list = contentEl.createDiv({cls:'synced-vault-preview'});
    if (!this.operations.length) list.createEl('p', {text:'No changes.'});
    for (const op of this.operations) list.createEl('p', {text:op.type.toUpperCase() + '  ' + op.path});
    const buttons = new Setting(contentEl);
    buttons.addButton(b => b.setButtonText('Cancel').onClick(() => {this.result?.(false); this.result = null; this.close();}));
    buttons.addButton(b => b.setButtonText('Apply changes').setCta().setDisabled(!this.operations.length).onClick(() => {this.result?.(true); this.result = null; this.close();}));
  }
  onClose() {this.result?.(false); this.result = null; this.contentEl.empty();}
  confirm() {return new Promise(resolve => {this.result = resolve; this.open();});}
}

class SyncedVault extends Plugin {
  async onload() {
    const loaded = await this.loadData() || {};
    this.state = Object.assign({appKey:'', refreshToken:'', namespace:'main', syncConfig:false, baseline:{}, remoteSeen:false, deviceId:'', pendingVerifier:'', lastSync:''}, loaded);
    if (!this.state.deviceId) this.state.deviceId = toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
    this.running = false;
    this.addRibbonIcon('refresh-cw', 'Synced Vault: Review sync', () => this.sync());
    this.addCommand({id:'sync', name:'Review and synchronize Dropbox vault', callback:() => this.sync()});
    this.addSettingTab(new SyncedVaultSettings(this.app, this));
    await this.saveData(this.state);
  }

  configDir() { return this.app.vault.configDir || '.obsidian'; }
  shouldSync(path) {
    if (!safePath(path, this.configDir())) return false;
    return path !== this.configDir() && (this.state.syncConfig || !path.startsWith(this.configDir() + '/'));
  }
  async ensureDir(path) {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (!dir) return;
    let prefix = '';
    for (const part of dir.split('/')) {
      prefix = prefix ? prefix + '/' + part : part;
      if (!await this.app.vault.adapter.exists(prefix)) await this.app.vault.adapter.mkdir(prefix);
    }
  }

  async scanConfig(folder, out) {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(folder)) return;
    const listing = await adapter.list(folder);
    for (const file of listing.files) {
      if (!this.shouldSync(file)) continue;
      const bytes = await adapter.readBinary(file);
      if (bytes.byteLength > MAX_FILE) throw new Error('File too large for v0.1: ' + file);
      out[file] = {hash:await hashBytes(bytes), size:bytes.byteLength};
    }
    for (const child of listing.folders) if (child !== folder && safePath(child + '/file', this.configDir())) await this.scanConfig(child, out);
  }

  async scanLocal() {
    const out = {};
    for (const file of this.app.vault.getFiles()) {
      if (!this.shouldSync(file.path)) continue;
      if (file.stat.size > MAX_FILE) throw new Error('File too large for v0.1: ' + file.path + ' (' + file.stat.size + ' bytes)');
      const bytes = await this.app.vault.readBinary(file);
      out[file.path] = {hash:await hashBytes(bytes), size:bytes.byteLength};
    }
    if (this.state.syncConfig) await this.scanConfig(this.configDir(), out);
    caseCollision(Object.keys(out));
    return out;
  }

  async readLocal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.app.vault.readBinary(file) : this.app.vault.adapter.readBinary(path);
  }
  async assertLocalUnchanged(path, expectedHash) {
    const item = this.app.vault.getAbstractFileByPath(path);
    if (item && !(item instanceof TFile)) throw new Error('A folder now occupies this file path: ' + path);
    const exists = item instanceof TFile || await this.app.vault.adapter.exists(path);
    const currentHash = exists ? await hashBytes(await this.readLocal(path)) : null;
    if (currentHash !== expectedHash) {
      throw new Error('Local file changed while reviewing sync. No further changes were applied: ' + path);
    }
  }
  async writeLocal(path, bytes) {
    await this.ensureDir(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.modifyBinary(file, asBytes(bytes));
    else if (path.startsWith(this.configDir() + '/')) await this.app.vault.adapter.writeBinary(path, asBytes(bytes));
    else await this.app.vault.createBinary(normalizePath(path), asBytes(bytes));
  }
  async removeLocal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.delete(file, true); // Bypass Synced Trash hooks deliberately.
    else if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }
  conflictPath(path, reserved) {
    const i = path.lastIndexOf('.');
    const dot = i > path.lastIndexOf('/') ? i : path.length;
    const stem = path.slice(0, dot).replace(/\//g, '__');
    const ext = path.slice(dot);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let candidate = 'Sync Conflicts/' + stem + ' (' + this.state.deviceId + ' ' + timestamp + ')' + ext;
    let n = 1;
    while (reserved.has(candidate)) candidate = 'Sync Conflicts/' + stem + ' (' + this.state.deviceId + ' ' + timestamp + '-' + n++ + ')' + ext;
    reserved.add(candidate);
    return candidate;
  }

  client() {
    if (!this.state.appKey || !this.state.refreshToken) throw new Error('Connect Dropbox in Synced Vault settings first.');
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(this.state.namespace)) throw new Error('Vault ID may use only letters, numbers, - and _.');
    return new DropboxClient(this.state.appKey, this.state.refreshToken, this.state.namespace);
  }

  async sync() {
    if (this.running) return new Notice('Synced Vault: sync already running.');
    this.running = true;
    try {
      new Notice('Synced Vault: scanning local and Dropbox files…');
      const client = this.client();
      const local = await this.scanLocal();
      const remote = await client.getManifest();
      validateManifest(remote.data, this.configDir());
      if (!remote.rev && this.state.remoteSeen) throw new Error('Remote manifest disappeared! Refusing to treat it as empty. Check Dropbox and Vault ID before proceeding.');
      const hashes = Object.fromEntries(Object.entries(local).map(([path, val]) => [path, val.hash]));
      const scopedRemote = Object.fromEntries(Object.entries(remote.data.entries).filter(([path]) => this.shouldSync(path)));
      const scopedBaseline = Object.fromEntries(Object.entries(this.state.baseline || {}).filter(([path]) => this.shouldSync(path)));
      const operations = planChanges(hashes, scopedRemote, scopedBaseline);
      // Don't allow a deleted directory/file or a new path to collide on Windows.
      caseCollision([...new Set([...Object.keys(local), ...Object.keys(scopedRemote)])]);
      if (!operations.length) {
        this.state.baseline = Object.fromEntries(Object.entries(scopedRemote).map(([path, entry]) => [path, entry.deleted ? null : entry.blob]));
        this.state.remoteSeen ||= !!remote.rev;
        this.state.lastSync = new Date().toISOString();
        await this.saveData(this.state);
        new Notice('Synced Vault: already up to date.');
        return;
      }
      if (!await new PreviewModal(this.app, operations).confirm()) return new Notice('Synced Vault: preview cancelled. No files changed.');
      new Notice('Synced Vault: applying approved operations…');

      // Phase 1: upload immutable payloads before publishing new manifest.
      const modified = clone(remote.data);
      const pendingLocal = [];
      if (operations.some(op => op.type === 'push' || op.type === 'tombstone')) await client.ensureRemoteFolders();
      for (const op of operations) {
        if (op.type === 'push') {
          const bytes = await this.readLocal(op.path);
          if (await hashBytes(bytes) !== op.hash) throw new Error('Local file changed after preview: ' + op.path);
          await client.uploadBlob(op.hash, bytes);
          modified.entries[op.path] = {blob:op.hash, size:bytes.byteLength, changed:new Date().toISOString(), device:this.state.deviceId};
        } else if (op.type === 'tombstone') {
          modified.entries[op.path] = {deleted:true, changed:new Date().toISOString(), device:this.state.deviceId};
        } else {
          pendingLocal.push(op);
        }
      }

      // Phase 2: stage and verify remote downloads before touching local files.
      const staged = new Map();
      for (const op of pendingLocal) {
        await this.assertLocalUnchanged(op.path, local[op.path]?.hash || null);
        if (op.type !== 'pull' && op.type !== 'conflict') continue;
        const entry = modified.entries[op.path];
        if (entry && !entry.deleted) staged.set(op.path, await client.downloadBlob(entry.blob, entry.size));
      }
      // Phase 3: CAS commit. If another device uploaded meanwhile, stop safely.
      if (operations.some(op => op.type === 'push' || op.type === 'tombstone')) {
        await client.commitManifest(modified, remote.rev);
      } else {
        const now = await client.metadata(client.base + '/manifest.json');
        if ((now?.rev || null) !== remote.rev) throw new Error('Dropbox state changed after the preview. Nothing was applied locally. Run sync again.');
      }
      // Phase 4: preserve local conflicts BEFORE replacing/removing originals.
      const reserved = new Set([...Object.keys(local), ...Object.keys(modified.entries)]);
      for (const op of pendingLocal) {
        if (op.type !== 'conflict') continue;
        await this.assertLocalUnchanged(op.path, op.hash);
        const original = await this.readLocal(op.path);
        const conflict = this.conflictPath(op.path, reserved);
        await this.writeLocal(conflict, original);
      }
      // Phase 5: apply the verified remote state to the local vault.
      for (const op of pendingLocal) {
        await this.assertLocalUnchanged(op.path, local[op.path]?.hash || null);
        if (op.type === 'pull') await this.writeLocal(op.path, staged.get(op.path));
        if (op.type === 'remove') await this.removeLocal(op.path);
        if (op.type === 'conflict') {
          if (staged.has(op.path)) await this.writeLocal(op.path, staged.get(op.path));
          else await this.removeLocal(op.path);
        }
      }
      this.state.baseline = Object.fromEntries(Object.entries(modified.entries).filter(([path]) => this.shouldSync(path)).map(([path, entry]) => [path, entry.deleted ? null : entry.blob]));
      this.state.remoteSeen = true;
      this.state.lastSync = new Date().toISOString();
      await this.saveData(this.state);
      new Notice(`Synced Vault: done (${operations.length} changes). Conflict copies will sync next time.`, 9000);
    } catch (e) {
      console.error('[Synced Vault]', e);
      new Notice('Synced Vault: ' + errorText(e), 12000);
    } finally {this.running = false;}
  }

  async authorize() {
    if (!this.state.appKey.trim()) throw new Error('Enter your Dropbox App Key first.');
    const verifierBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const verifier = Array.from(verifierBytes, b => b.toString(16).padStart(2, '0')).join('');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    this.state.pendingVerifier = verifier;
    await this.saveData(this.state);
    const params = new URLSearchParams({client_id:this.state.appKey.trim(), response_type:'code', token_access_type:'offline', code_challenge:challenge, code_challenge_method:'S256'});
    window.open('https://www.dropbox.com/oauth2/authorize?' + params.toString(), '_blank');
  }

  async connect(code) {
    if (!this.state.pendingVerifier) throw new Error('Click Open Dropbox Authorization first.');
    const refreshToken = await DropboxClient.authorize(this.state.appKey.trim(), this.state.pendingVerifier, code.trim());
    // Changing account must never silently apply old baseline; require a fresh vault copy.
    if (this.state.refreshToken && this.state.refreshToken !== refreshToken) throw new Error('Dropbox account change is blocked. Back up your vault and reinstall with a new test vault first.');
    this.state.refreshToken = refreshToken;
    this.state.pendingVerifier = '';
    await this.saveData(this.state);
  }
}

class SyncedVaultSettings extends PluginSettingTab {
  constructor(app, plugin) {super(app, plugin); this.plugin = plugin;}
  display() {
    const {containerEl} = this; const p = this.plugin; containerEl.empty();
    containerEl.createEl('h2', {text:'Synced Vault — Dropbox'});
    containerEl.createEl('p', {cls:'synced-vault-danger', text:'EXPERIMENTAL 0.2.1. Back up your vault before syncing. Disable Remotely Save in this vault. All synchronization is manual and previewed.'});
    new Setting(containerEl).setName('Dropbox App Key').setDesc('Create a scoped App Folder app with files.content.read, files.content.write, and files.metadata.read permissions. Never enter the App Secret.').addText(t => t.setPlaceholder('App Key').setValue(p.state.appKey).onChange(async val => {const next = val.trim(); if (p.state.refreshToken && next !== p.state.appKey) {new Notice('App Key cannot be changed after Dropbox authorization.'); this.display(); return;} p.state.appKey = next; await p.saveData(p.state);}));
    new Setting(containerEl).setName('Vault ID').setDesc('Use the EXACT same ID and Dropbox account on Windows and iPhone. One ID per separate vault.').addText(t => t.setValue(p.state.namespace).onChange(async val => { if (p.state.remoteSeen || Object.keys(p.state.baseline).length) {new Notice('Cannot change Vault ID after syncing.'); return;} p.state.namespace = val.trim(); await p.saveData(p.state);}));
    new Setting(containerEl).setName('Authorize Dropbox').setDesc('Dropbox displays a one-time code; copy it to the next field.').addButton(b => b.setButtonText('Open Dropbox').onClick(async () => {try {await p.authorize();} catch(e) {new Notice(errorText(e));}}));
    let authorizationCode = '';
    new Setting(containerEl).setName('Authorization code').addText(t => t.setPlaceholder('Paste Dropbox code here').onChange(value => {authorizationCode = value;})).addButton(b => b.setButtonText('Connect').onClick(async () => {try {await p.connect(authorizationCode); new Notice('Dropbox connected.'); this.display();} catch(e) {new Notice(errorText(e), 10000);}}));
    new Setting(containerEl).setName('Sync .obsidian settings').setDesc('OFF by default. If enabled, includes most .obsidian settings and plugins, but excludes workspace layout, this plugin’s credentials, and Remotely Save settings. Enable consistently on both devices.').addToggle(toggle => toggle.setValue(p.state.syncConfig).onChange(async value => {if (Object.keys(p.state.baseline).length) {new Notice('Configuration sync scope cannot be changed after syncing in v0.2.1.'); this.display(); return;} p.state.syncConfig = value; await p.saveData(p.state);}));
    new Setting(containerEl).setName('Review and sync').setDesc('Never automatically applies deletions; shows a full preview first.').addButton(b => b.setButtonText('Preview sync').setCta().onClick(() => p.sync()));
    containerEl.createEl('p', {cls:'synced-vault-note', text:(p.state.refreshToken ? 'Connected to Dropbox.' : 'Not connected.') + (p.state.lastSync ? ' Last successful sync: ' + new Date(p.state.lastSync).toLocaleString() : '')});
    containerEl.createEl('p', {cls:'synced-vault-note', text:'Limit: 100 MiB per file. Remote deletions use persistent tombstones. Files under .trash and .git are excluded; visible Trash is included.'});
  }
}

module.exports = SyncedVault;
// Pure helpers exported for deterministic, offline regression tests.
module.exports.__test = {planChanges, safePath, validateManifest, caseCollision, escapeDropboxHeader, DropboxClient, PreviewModal, MAX_FILE};
