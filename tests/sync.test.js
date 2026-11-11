'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

function load(requestUrl = async () => {throw new Error('mock network not configured');}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  class Plugin {}
  class ItemView {}
  class PluginSettingTab {}
  class Modal {}
  class TFile {}
  const exports = {exports:{}};
  const context = {module:exports, TextEncoder, TextDecoder, URLSearchParams, btoa, ArrayBuffer, Uint8Array,
    globalThis:{crypto:webcrypto}, require(id) { if (id !== 'obsidian') throw new Error('Unexpected ' + id);
      return {Plugin, PluginSettingTab, ItemView, Modal, TFile, requestUrl, Notice:class {}, Setting:class {}, normalizePath:p=>p};
    }
  };
  vm.runInNewContext(source, context, {filename:'main.js'});
  return exports.exports.__test;
}

const {planChanges, validateManifest, safePath, caseCollision, removeCaseVariantTombstones, escapeDropboxHeader} = load();
const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64), h3 = 'c'.repeat(64);
const plan = (local, remote, baseline) => Array.from(planChanges(local, remote, baseline), x => x.type + ':' + x.path);

test('first upload produces a push, not a deletion', () => {
  assert.deepEqual(plan({'hello.md':h1}, {}, {}), ['push:hello.md']);
});
test('first join downloads remote file', () => {
  assert.deepEqual(plan({}, {'hello.md':{blob:h1, size:2}}, {}), ['pull:hello.md']);
});
test('matching remote file never duplicates', () => {
  assert.deepEqual(plan({'hello.md':h1}, {'hello.md':{blob:h1, size:2}}, {}), []);
});
test('local deletion is a tombstone and remote deletion removes the local original', () => {
  assert.deepEqual(plan({}, {'hello.md':{blob:h1}}, {'hello.md':h1}), ['tombstone:hello.md']);
  assert.deepEqual(plan({'hello.md':h1}, {'hello.md':{deleted:true}}, {'hello.md':h1}), ['remove:hello.md']);
});
test('old offline iPhone cannot resurrect Windows tombstoned note', () => {
  assert.deepEqual(plan({'hello.md':h1}, {'hello.md':{deleted:true}}, {}), ['conflict:hello.md']);
});
test('same path edited on both devices keeps a local conflict copy', () => {
  assert.deepEqual(plan({'hello.md':h2}, {'hello.md':{blob:h3}}, {'hello.md':h1}), ['conflict:hello.md']);
});
test('remote deletion during local edit keeps a local conflict copy', () => {
  assert.deepEqual(plan({'hello.md':h2}, {'hello.md':{deleted:true}}, {'hello.md':h1}), ['conflict:hello.md']);
});
test('local deletion plus remote edit restores the remote changed note', () => {
  assert.deepEqual(plan({}, {'hello.md':{blob:h2}}, {'hello.md':h1}), ['pull:hello.md']);
});
test('manifest rejects path traversal and excessive size', () => {
  assert.throws(() => validateManifest({version:1, entries:{'../outside.md':{blob:h1, size:10}}}, '.obsidian'), /Unsafe/);
  assert.throws(() => validateManifest({version:1, entries:{'file.md':{blob:h1, size:200*1024*1024}}}, '.obsidian'), /size/);
});
test('case-colliding paths on Windows are rejected', () => {
  assert.throws(() => caseCollision(['Hello.md', 'hello.md']), /colliding/);
});

test('a deleted casing variant does not permanently reserve a live path', () => {
  const entries = {
    'Note.md': {deleted:true},
    'note.md': {blob:h1, size:2},
  };
  assert.doesNotThrow(() => validateManifest({version:1, entries}, '.obsidian'));
  removeCaseVariantTombstones(entries, 'note.md');
  assert.deepEqual(Object.keys(entries), ['note.md']);
});

test('two live case-colliding manifest paths remain invalid', () => {
  assert.throws(() => validateManifest({version:1, entries:{
    'Note.md': {blob:h1, size:2},
    'note.md': {blob:h1, size:2},
  }}, '.obsidian'), /colliding/);
});
test('unsafe configuration and trash internals are excluded', () => {
  assert.equal(safePath('.obsidian/plugins/synced-vault/data.json'), false);
  assert.equal(safePath('.obsidian/workspace-mobile.json'), false);
  assert.equal(safePath('.trash/file.md'), false);
  assert.equal(safePath('Trash/xyz/entry.json'), true);
  assert.equal(safePath('Images/photo.png'), true);
  assert.equal(safePath('Notes/meeting: 1.md'), false);
  assert.equal(safePath('Notes/CON.md'), false);
});
test('unicode Dropbox arguments are safely encoded for HTTP headers', () => {
  assert.equal(escapeDropboxHeader({path:'/Заметки.md'}).includes('З'), false);
  assert.equal(JSON.parse(escapeDropboxHeader({path:'/Заметки.md'})).path, '/Заметки.md');
});
