const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(__dirname + '/resource-locations.js', 'utf8'), context);
const collections = new Map([
  [1, { name: 'TKG', libraryID: 1, parentID: false }],
  [2, { name: 'Survey', libraryID: 1, parentID: 1 }],
  [3, { name: 'Reasoning', libraryID: 1, parentID: 1 }],
  [4, { name: 'Deep', libraryID: 1, parentID: 2 }]
]);
const zotero = { Libraries: { get: () => ({ name: '我的文献库' }) }, Collections: { get: id => collections.get(id) } };
function item(id, memberships = [], parentItemID = null) {
  return { id, key: 'K' + id, libraryID: 1, parentItemID, getField: () => 'Title ' + id, getCollections: () => memberships };
}
function describe(group, items) { return context.groupLocationDetails(zotero, group, items).join('\n'); }
let passed = 0;
function test(name, action) { action(); passed++; console.log('PASS ' + name); }
test('all nested collection memberships are rendered', () => {
  let first = item(1, [4, 3]); let second = item(2, [2]);
  let text = describe({ type: 'regular', items: [first, second] }, [first, second]);
  assert.match(text, /TKG \/ Survey \/ Deep；TKG \/ Reasoning/);
  assert.match(text, /预计处理后保留条目分类：K1/);
  assert.match(text, /元信息与资源归入 K1/);
});
test('children inherit parent collections and show parent chain', () => {
  let parent = item(1, [2]); let pdf = item(2, [], 1); let note = item(3, [], 2); let duplicate = item(4, [], 2);
  let text = describe({ type: 'noteResource', retainedID: 3, items: [note, duplicate] }, [parent, pdf, note, duplicate]);
  assert.match(text, /父条目：K1 · Title 1 → K2 · Title 2；分类继承自父条目/);
  assert.match(text, /分类：TKG \/ Survey/);
});
test('orphan source and retained destination classification union', () => {
  let parent = item(1, [2]); let retained = item(2, [], 1); let orphan = item(3, [3]);
  let text = describe({ type: 'orphan', parentID: 1, retainedID: 2, items: [orphan] }, [parent, retained, orphan]);
  assert.match(text, /重复独立 PDF：K3.*分类：TKG \/ Reasoning/);
  assert.match(text, /预计处理后保留条目分类：K1.*TKG \/ Survey；TKG \/ Reasoning/);
  assert.match(text, /预计移入「我的文献库 \/ 回收站」/);
  assert.deepEqual(parent.getCollections(), [2]);
});
test('invalid target and all direct children go to library recycle bin', () => {
  let parent = item(1, [2]); let pdf = item(2, [], 1); let unrelated = item(3, [3]);
  let text = describe({ type: 'invalidResource', items: [parent] }, [parent, pdf, unrelated]);
  assert.match(text, /待清理资源：K1/);
  assert.match(text, /同时清理的子资源：K2/);
  assert.equal((text.match(/预计移入「我的文献库 \/ 回收站」/g) || []).length, 2);
  assert.doesNotMatch(text, /K3/);
});
test('unfiled and unknown collections remain distinguishable', () => {
  let first = item(1); let second = item(2, [999]);
  let text = describe({ type: 'regular', items: [first, second] }, [first, second]);
  assert.match(text, /K1.*分类：未分类/);
  assert.match(text, /未知分类（ID 999）/);
  let child = item(3, [], 777);
  text = describe({ type: 'invalidResource', items: [child] }, [child]);
  assert.match(text, /未知分类：父条目无法确认/);
  assert.doesNotMatch(text, /未分类/);
});
test('regular group shows attachments transferred from donor', () => {
  let first = item(1, [2]); let second = item(2, [3]); let child = item(3, [], 2);
  let text = describe({ type: 'regular', items: [first, second] }, [first, second, child]);
  assert.match(text, /条目所含资源：K3.*分类：TKG \/ Reasoning.*预计归属保留条目 K1/);
});
test('structured model keeps titles and individual collection paths separate', () => {
  let parent = item(1, [4, 3]); let pdf = item(2, [], 1); let orphan = item(3, [2]);
  const model = context.groupLocationModel(zotero, {type:'orphan',parentID:1,retainedID:2,items:[orphan]}, [parent,pdf,orphan]);
  assert.equal(model.resources[1].title, 'Title 2');
  assert.equal(model.resources[1].paths.length, 2);
  assert.equal(model.resources[1].paths[0], 'TKG / Survey / Deep');
  assert.equal(model.resources[1].parents[0], 'K1 · Title 1');
  assert.equal(model.destination.paths.length, 3);
  assert.equal(model.destination.title, 'Title 1');
});
test('invalid model lists resource actions without a misleading retained destination', () => {
  const parent = item(1); const model = context.groupLocationModel(zotero,{type:'invalidResource',items:[parent]},[parent]);
  assert.equal(model.destination, null);
  assert.equal(model.resources[0].paths[0], '未分类');
  assert.match(model.resources[0].action,/回收站/);
});
console.log(passed + ' location checks passed');
