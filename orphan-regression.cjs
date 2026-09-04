const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(__dirname + '/bootstrap.js', 'utf8');

function fixture() {
  const content = new TextEncoder().encode('%PDF-1.4 identical test bytes');
  const files = new Map([['child.pdf', content], ['orphan.pdf', content]]);
  function item(id, regular, path, parentID) {
    return {
      id, key: 'TEST' + id, libraryID: 1, deleted: false, parentItemID: parentID,
      attachmentContentType: regular ? '' : 'application/pdf',
      fields: { title: 'Test paper' }, tags: [], collections: [], annotations: [], relations: {}, note: '',
      isRegularItem: () => regular, isAttachment: () => !regular, isFileAttachment: () => !regular,
      getField(field) { return this.fields[field] || ''; },
      getCreators: () => regular ? [{ lastName: 'Author' }] : [],
      getFilePathAsync: async () => path,
      getAnnotations() { return this.annotations; }, getNotes: () => [],
      getNote() { return this.note; }, getRelations() { return this.relations; },
      getCollections() { return this.collections; },
      addToCollection(value) { if (!this.collections.includes(value)) this.collections.push(value); },
      getTags() { return this.tags; },
      hasTag(value) { return this.tags.some(tag => tag.tag === value); },
      getTagType(value) { return this.tags.find(tag => tag.tag === value)?.type; },
      addTag(tag, type) { this.tags = this.tags.filter(entry => entry.tag !== tag); this.tags.push({ tag, type }); },
      save: async () => true
    };
  }
  const parent = item(1, true);
  const child = item(2, false, 'child.pdf', 1);
  const orphan = item(3, false, 'orphan.pdf');
  orphan.collections = [99]; orphan.tags = [{ tag: 'retain-me', type: 0 }];
  const items = [parent, child, orphan];
  const zotero = {
    Items: { getAll: async () => items.filter(entry => !entry.deleted), trash: async ids => {
      for (const id of Array.isArray(ids) ? ids : [ids]) items.find(entry => entry.id === id).deleted = true;
    } }, DB: { executeTransaction: async operation => operation() }
  };
  const context = vm.createContext({ crypto: webcrypto, Uint8Array, IOUtils: { stat: async path => {
    if (!files.has(path)) throw new Error('unconfirmed inaccessible path');
    return {type:'regular',size:files.get(path).length};
  }, read: async path => {
    if (!files.has(path)) throw new Error('missing file');
    return files.get(path);
  } } });
  vm.runInContext(source, context);
  const group = async () => ({ items: [orphan], parentID: 1, retainedID: 2, hash: await context.attachmentFingerprint(child) });
  return { context, zotero, files, items, parent, child, orphan, group };
}

test('identical orphan is trashed, parent/child and category/tag retained', async () => {
  const env = fixture();
  await env.context.mergeOrphanPDFs(env.zotero, 1, await env.group());
  assert.equal(env.orphan.deleted, true);
  assert.equal(env.parent.deleted, false);
  assert.equal(env.child.deleted, false);
  assert.deepEqual(env.parent.collections, [99]);
  assert.ok(env.child.tags.some(tag => tag.tag === 'retain-me'));
  assert.equal(env.files.size, 2);
});

for (const scenario of ['changed file', 'missing retained file', 'annotation', 'embedded note', 'already child', 'deleted parent', 'own child']) {
  test('refuses unsafe cleanup: ' + scenario, async () => {
    const env = fixture();
    const group = await env.group();
    if (scenario === 'changed file') env.files.set('orphan.pdf', new Uint8Array([1, 2, 3]));
    if (scenario === 'missing retained file') env.files.delete('child.pdf');
    if (scenario === 'annotation') env.orphan.annotations = [4];
    if (scenario === 'embedded note') env.orphan.note = '<p>Important note</p>';
    if (scenario === 'already child') env.orphan.parentItemID = 1;
    if (scenario === 'deleted parent') env.parent.deleted = true;
    if (scenario === 'own child') group.items = [env.child];
    await assert.rejects(env.context.mergeOrphanPDFs(env.zotero, 1, group));
    assert.equal(env.orphan.deleted, false);
    assert.equal(env.child.deleted, false);
  });
}

test('metadata score gives richer record priority', () => {
  const env = fixture();
  const sparse = { ...env.parent, id: 0, fields: { title: 'filename' }, getCreators: () => [] };
  env.parent.fields.DOI = '10.1234/test'; env.parent.fields.abstractNote = 'Abstract';
  assert.ok(env.context.richest(env.parent, sparse) < 0);
});

test('missing, unknown and URL attachments are distinguished', async () => {
  const env = fixture();
  assert.equal(await env.context.pdfFileState(env.child), 'available');
  env.files.delete('child.pdf');
  assert.equal(await env.context.pdfFileState(env.child), 'unknown');
  env.child.getFilePathAsync = async () => false;
  assert.equal(await env.context.pdfFileState(env.child), 'missing');
  env.child.isFileAttachment = () => false;
  assert.equal(await env.context.pdfFileState(env.child), 'unknown');
});

test('valid PDF beats a richer record without available PDF', () => {
  const env = fixture();
  const rich = {...env.parent,id:4,fields:{title:'Title',DOI:'10.test/doi',abstractNote:'Abstract'}};
  const status = new Map([[1,{available:[env.child]}],[4,{available:[]}]]);
  assert.ok(env.context.preferredRegular(env.parent,rich,status) < 0);
});

test('missing child with notes is retained despite available alternative', async () => {
  const env = fixture();
  env.orphan.parentItemID = env.parent.id;
  env.orphan.getFilePathAsync = async () => false;
  env.orphan.note = '<p>Unique note</p>';
  const removed = await env.context.trashMissingGroupPDFs(env.zotero,1,env.parent,[env.orphan.id]);
  assert.equal(removed,0);
  assert.equal(env.orphan.deleted,false);
});

test('missing child is not removed when no usable alternative exists', async () => {
  const env = fixture();
  env.orphan.parentItemID = env.parent.id;
  env.orphan.getFilePathAsync = async () => false;
  env.child.getFilePathAsync = async () => false;
  const removed = await env.context.trashMissingGroupPDFs(env.zotero,1,env.parent,[env.orphan.id]);
  assert.equal(removed,0);
  assert.equal(env.orphan.deleted,false);
});

test('URL attachments never invoke file-only annotation API', () => {
  const env = fixture();
  env.orphan.isFileAttachment = () => false;
  env.orphan.getAnnotations = () => { throw new Error('file-only API'); };
  assert.equal(env.context.protectedAttachment(env.orphan, env.items), true);
});
