'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

class Element {
  constructor(tag = 'div', options = {}) {
    this.tag = tag;
    this.text = options.text || '';
    this.cls = options.cls || '';
    this.children = [];
    this.listeners = {};
    this.disabled = false;
  }
  empty() {this.children = [];}
  addClass(cls) {this.cls += ' ' + cls;}
  createEl(tag, options) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options) {return this.createEl('div', options);}
  addEventListener(event, callback) {this.listeners[event] = callback;}
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

function setup(saved = {}) {
  const settings = {opened:0, tab:null, open() {this.opened++;}, openTabById(id) {this.tab=id;}};
  const commands = {};
  const registry = {};
  const leaves = [];
  const app = {
    data:saved,
    setting:settings,
    workspace:{
      getLeavesOfType(type) {return leaves.filter(leaf => leaf.type === type);},
      getLeftLeaf(split) {assert.equal(split, true); return makeLeaf();},
      getLeaf() {return makeLeaf();},
      async revealLeaf() {},
    },
  };
  function makeLeaf() {
    const leaf = {
      type:null, view:null,
      async setViewState({type}) {
        this.type = type;
        this.view = registry[type](this);
        await this.view.onOpen();
      },
    };
    leaves.push(leaf);
    return leaf;
  }
  class Plugin {
    constructor(application) {this.app=application;}
    async loadData() {return this.app.data;}
    async saveData(data) {this.app.data={...data};}
    registerView(type, factory) {registry[type]=factory;}
    addRibbonIcon() {}
    addCommand(command) {commands[command.id]=command;}
    addSettingTab() {}
  }
  class ItemView {constructor(leaf) {this.leaf=leaf;this.contentEl=new Element();}}
  class PluginSettingTab {}
  class Modal {}
  class TFile {}
  const module = {exports:{}};
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  vm.runInNewContext(source, {module, TextEncoder, TextDecoder, URLSearchParams, btoa, ArrayBuffer, Uint8Array,
    globalThis:{crypto:webcrypto}, require(name) {
      assert.equal(name, 'obsidian');
      return {Plugin, ItemView, PluginSettingTab, Modal, TFile, Setting:class {}, Notice:class {},
        requestUrl:()=>{throw new Error('unexpected network');}, normalizePath:p=>p};
    }
  });
  return {app, commands, settings, leaves, PluginClass:module.exports};
}

test('opens a sidebar tab showing Dropbox authorization and last sync', async () => {
  const {app, commands, leaves, PluginClass} = setup({
    refreshToken:'test-refresh', lastSync:'2026-11-09T12:00:00.000Z',
  });
  const plugin = new PluginClass(app);
  await plugin.onload();
  assert.ok(commands['open-panel'], 'panel command is registered');
  await commands['open-panel'].callback();
  assert.equal(leaves.length, 1);
  const view = leaves[0].view;
  assert.equal(view.getDisplayText(), 'Synced Vault');
  assert.ok(view.contentEl.find(element => element.text === 'Connected to Dropbox'));
  assert.ok(view.contentEl.find(element => element.text === 'Last sync'));
  const sync = view.contentEl.find(element => element.text === 'Sync now');
  assert.ok(sync);
  assert.equal(sync.disabled, false);
  await commands['open-panel'].callback();
  assert.equal(leaves.length, 1, 'opening panel twice reuses existing tab');
});

test('Sync now triggers the existing sync command; Settings opens plugin settings', async () => {
  const {app, settings, PluginClass} = setup({refreshToken:'test-refresh'});
  const plugin = new PluginClass(app);
  await plugin.onload();
  await plugin.openPanel();
  const view = app.workspace.getLeavesOfType('synced-vault-panel')[0].view;
  let calls = 0;
  plugin.sync = () => {calls++;};
  view.contentEl.find(element => element.text === 'Sync now').listeners.click();
  assert.equal(calls, 1);
  view.contentEl.find(element => element.text === 'Settings').listeners.click();
  assert.equal(settings.opened, 1);
  assert.equal(settings.tab, 'synced-vault');
});

test('panel disables sync when disconnected or already syncing', async () => {
  const {app, PluginClass} = setup({});
  const plugin = new PluginClass(app);
  await plugin.onload();
  await plugin.openPanel();
  const view = app.workspace.getLeavesOfType('synced-vault-panel')[0].view;
  assert.equal(view.contentEl.find(element => element.text === 'Sync now').disabled, true);
  assert.ok(view.contentEl.find(element => element.text === 'Not connected'));

  plugin.state.refreshToken = 'test-refresh';
  plugin.running = true;
  plugin.refreshPanel();
  assert.equal(view.contentEl.find(element => element.text === 'Sync in progress…').disabled, true);
  plugin.running = false;
  plugin.refreshPanel();
  assert.equal(view.contentEl.find(element => element.text === 'Sync now').disabled, false);
});
