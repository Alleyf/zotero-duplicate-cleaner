var folder = 'C:\\Users\\Administrator\\Desktop\\master\\workspace\\zotero-dedup-plugin\\';
var source = await IOUtils.readUTF8(folder + 'resource-cleanup.js') + '\n' + await IOUtils.readUTF8(folder + 'bootstrap.js');
var helpers = eval('(function(){' + source + ';return {resourceScan,resourceApply};})()');
var roots = [];
var fixturePath = PathUtils.join(Zotero.getTempDirectory().path, 'codex-resource-test-' + Date.now() + '.pdf');
var result = {};
try {
  var original = await Zotero.Items.getByLibraryAndKeyAsync(1, '28V22S2Z');
  var bytes = await IOUtils.read(await original.getFilePathAsync());
  var suffix = new TextEncoder().encode('\n% resource fixture ' + Date.now() + '\n');
  var content = new Uint8Array(bytes.length + suffix.length); content.set(bytes); content.set(suffix, bytes.length);
  await IOUtils.write(fixturePath, content);
  async function parent(title) {
    var item = new Zotero.Item('journalArticle'); item.libraryID = 1;
    item.setField('title', '__Codex resource test__' + title); await item.saveTx(); roots.push(item.id); return item;
  }
  async function note(parentItem, text) {
    var item = new Zotero.Item('note'); item.libraryID = 1; item.parentItemID = parentItem.id;
    item.setNote(text); await item.saveTx(); return item;
  }
  var owner = await parent(' duplicates');
  var firstPDF = await Zotero.Attachments.importFromFile({file:fixturePath,parentItemID:owner.id,contentType:'application/pdf'});
  var secondPDF = await Zotero.Attachments.importFromFile({file:fixturePath,parentItemID:owner.id,contentType:'application/pdf'});
  var firstNote = await note(owner, '<p>Same full note</p>');
  var secondNote = await note(owner, '<p>Same full note</p>');
  var uniqueNote = await note(owner, '<p>Different note must survive</p>');
  var empty = await parent(' no attachments');
  var missing = await parent(' missing attachment');
  var missingPDF = await Zotero.Attachments.importFromFile({file:fixturePath,parentItemID:missing.id,contentType:'application/pdf'});
  var missingPath = await missingPDF.getFilePathAsync();
  if (!missingPath.includes('\\' + missingPDF.key + '\\')) throw new Error('Unexpected fixture path');
  await IOUtils.remove(missingPath);
  var protectedParent = await parent(' protected note');
  await note(protectedParent, '<p>Unique information</p>');
  async function fixtureItems() {
    var all = await Zotero.Items.getAll(1,false,false);
    return all.filter(item => roots.includes(item.id) || roots.includes(item.parentItemID));
  }
  var duplicates = await helpers.resourceScan(Zotero,1,await fixtureItems(),null,'duplicates');
  var pdfGroup = duplicates.groups.find(group=>group.type === 'pdfResource');
  var noteGroup = duplicates.groups.find(group=>group.type === 'noteResource');
  if (!pdfGroup || !noteGroup) throw new Error('Missing fixture duplicate groups');
  await helpers.resourceApply(Zotero,1,pdfGroup);
  await helpers.resourceApply(Zotero,1,noteGroup);
  var invalid = await helpers.resourceScan(Zotero,1,await fixtureItems(),null,'invalid');
  var emptyGroup = invalid.groups.find(group=>group.items[0].id === empty.id);
  var missingGroup = invalid.groups.find(group=>group.items[0].id === missing.id);
  if (!emptyGroup || !missingGroup) throw new Error('Missing invalid fixture groups');
  await helpers.resourceApply(Zotero,1,emptyGroup);
  await helpers.resourceApply(Zotero,1,missingGroup);
  result = {
    onePDFRetained:!firstPDF.deleted && secondPDF.deleted,
    oneNoteRetained:!firstNote.deleted && secondNote.deleted,
    uniqueNoteRetained:!uniqueNote.deleted,
    emptyParentTrashed:empty.deleted,
    missingParentTrashed:missing.deleted,
    missingChildTrashed:missingPDF.deleted,
    protectedParentUnlisted:!invalid.groups.some(group=>group.items[0].id === protectedParent.id),
    actualFileSurvives:Boolean(await firstPDF.getFilePathAsync())
  };
  if (Object.values(result).some(value=>!value)) throw new Error(JSON.stringify(result));
} finally {
  for (var id of roots.reverse()) {
    var item = await Zotero.Items.getAsync(id);
    if (item) await item.eraseTx();
  }
  await IOUtils.remove(fixturePath,{ignoreAbsent:true});
}
return {passed:result,fixturesRemoved:true};
