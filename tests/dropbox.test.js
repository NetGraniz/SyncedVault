'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const enc = new TextEncoder();
const dec = new TextDecoder();
const files = new Map();
const folders = new Set();
let revCounter = 0;
let refreshes = 0;

function result(status, obj, bytes) {
  const text = JSON.stringify(obj || {});
  return {status, json:obj || {}, text, arrayBuffer:bytes || enc.encode(text).buffer};
}
async function mockedRequest({url, headers, body}) {
  if (url.endsWith('/oauth2/token')) {refreshes++; return result(200, {access_token:'fake-access'});}
  if (url.endsWith('/files/create_folder_v2')) {
    const arg = JSON.parse(body);
    if (folders.has(arg.path)) return result(409, {error_summary:'path/conflict'});
    folders.add(arg.path);
    return result(200, {metadata:{'.tag':'folder', path_display:arg.path}});
  }
  if (url.endsWith('/files/get_metadata')) {
    const arg = JSON.parse(body);
    if (folders.has(arg.path)) return result(200, {'.tag':'folder'});
    if (files.has(arg.path)) return result(200, {'.tag':'file', rev:files.get(arg.path).rev});
    return result(409, {error_summary:'path/not_found'});
  }
  if (url.endsWith('/files/upload')) {
    const arg = JSON.parse(headers['Dropbox-API-Arg']);
    const existing = files.get(arg.path);
    if (existing && (arg.mode === 'add' || arg.mode?.update !== existing.rev)) return result(409, {error_summary:'path/conflict'});
    if (!existing && arg.mode?.['.tag'] === 'update') return result(409, {error_summary:'path/not_found'});
    const rev = 'r' + (++revCounter);
    files.set(arg.path, {rev, bytes:body});
    return result(200, {'.tag':'file', rev});
  }
  if (url.endsWith('/files/download')) {
    const arg = JSON.parse(headers['Dropbox-API-Arg']);
    const value = files.get(arg.path);
    return value ? result(200, {}, value.bytes) : result(409, {error_summary:'path/not_found'});
  }
  throw new Error('Unexpected Dropbox request: ' + url);
}

function load() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const module = {exports:{}};
  class Plugin {}
  class PluginSettingTab {}
  class Modal {}
  class TFile {}
  vm.runInNewContext(source, {module, TextEncoder, TextDecoder, URLSearchParams, btoa, ArrayBuffer, Uint8Array,
    globalThis:{crypto:webcrypto}, require(id) {
      if (id !== 'obsidian') throw new Error('unexpected module');
      return {Plugin, PluginSettingTab, Modal, TFile, requestUrl:mockedRequest, Notice:class {}, Setting:class {}, normalizePath:p=>p};
    }
  });
  return module.exports.__test.DropboxClient;
}

test('first Dropbox sync creates remote folders, immutable blobs, and a CAS manifest', async () => {
  files.clear(); folders.clear(); revCounter=0; refreshes=0;
  const DropboxClient = load();
  const client = new DropboxClient('testapp', 'test-refresh', 'main');
  const missing = await client.getManifest();
  assert.equal(missing.rev, null);
  await client.ensureRemoteFolders();
  assert.deepEqual([...folders], ['/vaults','/vaults/main','/vaults/main/blobs']);
  const bytes = enc.encode('A note').buffer;
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  await client.uploadBlob(hash, bytes);
  const state = {version:1, entries:{'note.md':{blob:hash, size:6}}};
  const revision = await client.commitManifest(state, null);
  assert.equal(typeof revision, 'string');
  const downloaded = await client.getManifest();
  assert.equal(downloaded.rev, revision);
  assert.equal(downloaded.data.entries['note.md'].blob, hash);
  assert.equal(dec.decode(await client.downloadBlob(hash, 6)), 'A note');
  assert.equal(refreshes, 1);
});

test('stale Dropbox revision cannot overwrite a newer device manifest', async () => {
  const DropboxClient = load();
  const client = new DropboxClient('testapp', 'test-refresh', 'main');
  const old = await client.getManifest();
  const a = {version:1, entries:{'deleted.md':{deleted:true}}};
  await client.commitManifest(a, old.rev);
  await assert.rejects(client.commitManifest({version:1, entries:{}}, old.rev), /changed on another device/);
  const latest = await client.getManifest();
  assert.equal(latest.data.entries['deleted.md'].deleted, true);
});

test('immutable blob re-upload checks integrity instead of overwriting', async () => {
  const DropboxClient = load();
  const client = new DropboxClient('testapp', 'test-refresh', 'main');
  const bytes = enc.encode('A note').buffer;
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  await client.uploadBlob(hash, bytes); // already exists, verified
  await assert.rejects(client.uploadBlob(hash, enc.encode('Tampered!').buffer), /integrity check/);
});
