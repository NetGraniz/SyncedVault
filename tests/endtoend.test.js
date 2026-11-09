'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const enc = new TextEncoder();
const dec = new TextDecoder();
const copy = x => JSON.parse(JSON.stringify(x));

function engine() {
  class TFile { constructor(path, bytes) {this.path = path; this.stat = {size:bytes.byteLength};} }
  class Plugin {
    constructor(app) {this.app=app;}
    async loadData() {return this.app.data;}
    async saveData(data) {this.app.data=copy(data);}
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
  }
  class PluginSettingTab {}
  class Modal {constructor(app) {this.app=app;}}
  const module = {exports:{}};
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  vm.runInNewContext(source, {module, TextEncoder, TextDecoder, URLSearchParams, btoa, ArrayBuffer, Uint8Array, console,
    globalThis:{crypto:webcrypto}, require(name) {
      assert.equal(name, 'obsidian');
      return {Plugin, PluginSettingTab, Modal, TFile, requestUrl:()=>{throw new Error('unexpected network');}, Setting:class {}, Notice:class {}, normalizePath:p=>p};
    }
  });
  module.exports.__test.PreviewModal.prototype.confirm = async () => true;
  const state = {rev:null, entries:{}, blobs:new Map(), counter:0};
  const C = module.exports.__test.DropboxClient;
  C.prototype.getManifest = async function() {return {rev:state.rev, data:{version:1, entries:copy(state.entries)}};};
  C.prototype.ensureRemoteFolders = async function() {};
  C.prototype.uploadBlob = async function(hash,bytes) {state.blobs.set(hash,bytes);};
  C.prototype.downloadBlob = async function(hash) {return state.blobs.get(hash);};
  C.prototype.commitManifest = async function(manifest,rev) {
    if (state.rev !== rev) throw new Error('revision conflict');
    state.rev = 'v'+(++state.counter); state.entries = copy(manifest.entries); return state.rev;
  };
  C.prototype.metadata = async function() {return state.rev ? {rev:state.rev} : null;};

  function makeApp(initial = {}) {
    const files = new Map(Object.entries(initial).map(([k,v])=>[k,enc.encode(v).buffer]));
    const folders = new Set();
    const vault = {
      configDir:'.obsidian',
      getFiles:()=>[...files].map(([name,bytes])=>new TFile(name,bytes)),
      getAbstractFileByPath:p=>files.has(p)?new TFile(p,files.get(p)):null,
      readBinary:async file=>files.get(file.path),
      createBinary:async (p,bytes)=>{files.set(p,bytes);},
      modifyBinary:async (f,bytes)=>{files.set(f.path,bytes);},
      delete:async file=>{files.delete(file.path);},
      adapter:{
        exists:async p=>files.has(p)||folders.has(p),
        mkdir:async p=>{folders.add(p);},
        readBinary:async p=>files.get(p),
        writeBinary:async (p,bytes)=>{files.set(p,bytes);},
        remove:async p=>{files.delete(p);},
      }
    };
    return {vault, files, data:null};
  }
  async function pluginFor(app) {
    const plugin = new module.exports(app);
    await plugin.onload();
    plugin.state.appKey='test-key';
    plugin.state.refreshToken='test-refresh';
    await plugin.saveData(plugin.state);
    return plugin;
  }
  return {state, makeApp, pluginFor, DropboxClient:C};
}

test('Windows to iPhone, then Windows deletion, then iPhone removal', async () => {
  const {state, makeApp, pluginFor} = engine();
  const windows = makeApp({'Notes/hello.md':'Hello world'});
  const iphone = makeApp();
  const win = await pluginFor(windows), ios = await pluginFor(iphone);
  await win.sync();
  assert.equal(!!state.entries['Notes/hello.md'].blob, true);
  await ios.sync();
  assert.equal(dec.decode(iphone.files.get('Notes/hello.md')), 'Hello world');
  windows.files.delete('Notes/hello.md');
  await win.sync();
  assert.equal(state.entries['Notes/hello.md'].deleted, true);
  await ios.sync();
  assert.equal(iphone.files.has('Notes/hello.md'), false);
});

test('offline iPhone edit is preserved when PC deletes same note', async () => {
  const {state, makeApp, pluginFor} = engine();
  const windows = makeApp({'Notes/hello.md':'Initial'});
  const iphone = makeApp();
  const win = await pluginFor(windows), ios = await pluginFor(iphone);
  await win.sync();
  await ios.sync();
  iphone.files.set('Notes/hello.md',enc.encode('Offline iPhone edit').buffer);
  windows.files.delete('Notes/hello.md');
  await win.sync();
  await ios.sync();
  assert.equal(state.entries['Notes/hello.md'].deleted, true);
  assert.equal(iphone.files.has('Notes/hello.md'), false);
  const conflict = [...iphone.files.keys()].find(p=>p.startsWith('Sync Conflicts/'));
  assert.ok(conflict, 'offline edit was saved to a conflict copy');
  assert.equal(dec.decode(iphone.files.get(conflict)), 'Offline iPhone edit');
  await ios.sync();
  await win.sync();
  assert.equal(dec.decode(windows.files.get(conflict)), 'Offline iPhone edit');
});

test('new local edit during Dropbox download is not silently overwritten', async () => {
  const {makeApp, pluginFor, DropboxClient} = engine();
  const windows = makeApp({'Notes/hello.md':'Original'});
  const iphone = makeApp();
  const win = await pluginFor(windows), ios = await pluginFor(iphone);
  await win.sync();
  await ios.sync();
  windows.files.set('Notes/hello.md', enc.encode('Updated on PC').buffer);
  await win.sync();
  const originalDownload = DropboxClient.prototype.downloadBlob;
  let raced = false;
  DropboxClient.prototype.downloadBlob = async function(...args) {
    if (!raced) { raced = true; iphone.files.set('Notes/hello.md', enc.encode('Changed during sync').buffer); }
    return originalDownload.apply(this, args);
  };
  // sync() reports failures via Notice; the important assertion is that
  // the local note remains intact, and is saved as a conflict on retry.
  await ios.sync();
  assert.equal(dec.decode(iphone.files.get('Notes/hello.md')), 'Changed during sync');
  await ios.sync();
  assert.equal(dec.decode(iphone.files.get('Notes/hello.md')), 'Updated on PC');
  assert.equal([...iphone.files.values()].some(x => dec.decode(x) === 'Changed during sync'), true);
});
