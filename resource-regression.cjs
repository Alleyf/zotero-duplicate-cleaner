const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(__dirname + '/resource-cleanup.js', 'utf8');
let counter = 0;
function item(type, options = {}) {
  return Object.assign({ id: ++counter, key: 'K' + counter, libraryID: 1, itemType: type, parentItemID: null,
    deleted: false, tags: [], collections: [], relations: {}, note: '', bytes: 'pdf', state: 'available', attachmentSyncState: 2,
    attachmentContentType: 'application/pdf', isAttachment() { return this.itemType === 'attachment'; },
    isRegularItem() { return this.itemType === 'journalArticle'; }, isNote() { return this.itemType === 'note'; },
    isFileAttachment() { return !this.url; }, getNote() { return this.note; }, getRelations() { return this.relations; },
    getField() { return this.key; }, getTags() { return this.tags; }, getCollections() { return this.collections; },
    addTag(tag, type) { this.tags.push({ tag, type }); }, addToCollection(value) { this.collections.push(value); },
    async save() {}, async getFilePathAsync() { if (this.state === 'error') throw Error('unreadable'); return this.state === 'missing' ? false : this.key; }
  }, options);
}
function setup(items) {
  const zotero = { Items: { getAll: async () => items, trash: async id => { items.find(item => item.id === id).deleted = true; } },
    DB: { executeTransaction: async action => action() } };
  const context = { IOUtils: { stat: async () => ({ type: 'regular' }) },
    attachmentFingerprint: async item => { if (item.state !== 'available') throw Error('missing'); return crypto.createHash('sha256').update(item.bytes).digest('hex'); },
    protectedAttachment: (item, all) => !!item.protected || Object.keys(item.relations).length > 0 || all.some(child => child.parentItemID === item.id && !child.deleted) };
  vm.createContext(context); vm.runInContext(source, context);
  return { zotero, scan: mode => context.resourceScan(zotero, 1, items, null, mode), apply: group => context.resourceApply(zotero, 1, group) };
}
async function run() {
  let passed = 0;
  async function test(name, action) { await action(); console.log('PASS ' + name); passed++; }
  await test('same parent PDF only; excludes cross parent', async () => {
    let first = item('journalArticle'); let second = item('journalArticle');
    let items = [first, second, item('attachment', { parentItemID: first.id }), item('attachment', { parentItemID: first.id }), item('attachment', { parentItemID: second.id })];
    assert.equal((await setup(items).scan()).groups.length, 1);
  });
  await test('top level PDFs deduplicate and preserve tags and collections', async () => {
    let items = [item('attachment'), item('attachment', { tags: [{ tag: 'keep', type: 0 }], collections: [9] })];
    let context = setup(items); let group = (await context.scan()).groups[0];
    assert.equal(await context.apply(group), 1); assert.equal(items[1].deleted, true);
    assert.equal(items[0].tags[0].tag, 'keep'); assert.equal(items[0].collections[0], 9);
  });
  await test('top PDF candidates defer to existing child versus orphan flow', async () => {
    let parent = item('journalArticle');
    let items = [parent, item('attachment'), item('attachment'), item('attachment', { parentItemID: parent.id })];
    assert.equal((await setup(items).scan()).groups.length, 0);
  });
  await test('exact note HTML; different parents, images and empty notes excluded', async () => {
    let items = [item('note', { note: '<p>text</p>' }), item('note', { note: '<p>text</p>' }),
      item('note', { note: '<p>text</p>', parentItemID: 100 }), item('note', { note: '<b>text</b>' }),
      item('note'), item('note'), item('note', { note: '<img src="a">' }), item('note', { note: '<img src="a">' })];
    let context = setup(items); let groups = (await context.scan()).groups;
    assert.equal(groups.length, 1); assert.equal(await context.apply(groups[0]), 1);
  });
  await test('invalid scan distinguishes absent files from URL, download pending and errors', async () => {
    let parent = item('journalArticle'); let missingParent = item('journalArticle');
    let items = [parent, missingParent, item('attachment', { parentItemID: missingParent.id, state: 'missing' }),
      item('attachment', { state: 'missing' }), item('attachment', { state: 'error' }),
      item('attachment', { state: 'missing', url: true }), item('attachment', { state: 'missing', attachmentSyncState: 1 })];
    assert.equal((await setup(items).scan('invalid')).groups.length, 3);
  });
  await test('invalid parents containing notes or protected missing attachments survive', async () => {
    let first = item('journalArticle'); let second = item('journalArticle');
    let items = [first, second, item('note', { parentItemID: first.id, note: 'unique' }),
      item('attachment', { parentItemID: second.id, state: 'missing', protected: true })];
    assert.equal((await setup(items).scan('invalid')).groups.length, 0);
  });
  await test('stale invalid group rechecks added attachment inside transaction', async () => {
    let parent = item('journalArticle'); let items = [parent]; let context = setup(items);
    let group = (await context.scan('invalid')).groups[0];
    context.zotero.DB.executeTransaction = async action => { items.push(item('attachment', { parentItemID: parent.id })); await action(); };
    await assert.rejects(context.apply(group), /重新扫描/); assert.equal(parent.deleted, false);
  });
  await test('PDF bytes rechecked inside transaction', async () => {
    let items = [item('attachment'), item('attachment')]; let context = setup(items); let group = (await context.scan()).groups[0];
    context.zotero.DB.executeTransaction = async action => { items[1].bytes = 'different'; await action(); };
    await assert.rejects(context.apply(group), /重新扫描/); assert.equal(items[1].deleted, false);
  });
  await test('new PDF annotation prevents deletion', async () => {
    let items = [item('attachment'), item('attachment')]; let context = setup(items); let group = (await context.scan()).groups[0];
    items[1].protected = true; await assert.rejects(context.apply(group), /重新扫描/);
  });
  await test('missing record recovered before apply survives', async () => {
    let items = [item('attachment', { state: 'missing' })]; let context = setup(items); let group = (await context.scan('invalid')).groups[0];
    items[0].state = 'available'; await assert.rejects(context.apply(group), /重新扫描/);
  });
  await test('invalid parent trashes missing child records explicitly', async () => {
    let parent = item('journalArticle'); let child = item('attachment', { parentItemID: parent.id, state: 'missing' });
    let context = setup([parent, child]); let groups = (await context.scan('invalid')).groups;
    assert.equal(groups.length, 1); await context.apply(groups[0]);
    assert.equal(parent.deleted, true); assert.equal(child.deleted, true);
  });
  await test('missing child with valid sibling eligible individually', async () => {
    let parent = item('journalArticle'); let child = item('attachment', { parentItemID: parent.id, state: 'missing' });
    let context = setup([parent, child, item('attachment', { parentItemID: parent.id })]);
    let groups = (await context.scan('invalid')).groups; assert.equal(groups.length, 1);
    assert.equal(groups[0].items[0].id, child.id); await context.apply(groups[0]); assert.equal(parent.deleted, false);
  });
  console.log(passed + ' resource regression tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
