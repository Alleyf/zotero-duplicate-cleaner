var pluginSource = await IOUtils.readUTF8('C:\\Users\\Administrator\\Desktop\\master\\workspace\\zotero-dedup-plugin\\bootstrap.js');
var helpers = eval('(function(){' + pluginSource + ';return {mergeOrphanPDFs, attachmentFingerprint};})()');
var created = [];
var collection;
var fixturePath = PathUtils.join(Zotero.getTempDirectory().path, 'codex-dedup-fixture-' + Date.now() + '.pdf');
var result;
try {
  var sourceAttachment = await Zotero.Items.getByLibraryAndKeyAsync(1, '28V22S2Z');
  var sourceBytes = await IOUtils.read(await sourceAttachment.getFilePathAsync());
  var suffix = new TextEncoder().encode('\n% isolated dedup fixture ' + Date.now() + '\n');
  var fixtureBytes = new Uint8Array(sourceBytes.length + suffix.length);
  fixtureBytes.set(sourceBytes); fixtureBytes.set(suffix, sourceBytes.length);
  await IOUtils.write(fixturePath, fixtureBytes);
  collection = new Zotero.Collection();
  collection.libraryID = 1;
  collection.name = '__Codex dedup isolated verification__';
  await collection.saveTx();
  var parent = new Zotero.Item('journalArticle');
  parent.libraryID = 1;
  parent.setField('title', '__Codex isolated dedup parent__');
  parent.setField('abstractNote', 'Metadata must survive');
  parent.setCreators([{firstName:'Fixture',lastName:'Author',creatorType:'author'}]);
  await parent.saveTx(); created.push(parent.id);
  var retained = await Zotero.Attachments.importFromFile({file: fixturePath, parentItemID: parent.id, contentType:'application/pdf'});
  var orphan = await Zotero.Attachments.importFromFile({file: fixturePath, libraryID:1, contentType:'application/pdf',collections:[collection.id]});
  created.push(orphan.id);
  orphan.addTag('__fixture_keep_tag__', 0); await orphan.saveTx();
  var hash = await helpers.attachmentFingerprint(retained);
  await helpers.mergeOrphanPDFs(Zotero, 1, {hash,parentID:parent.id,retainedID:retained.id,items:[orphan]});
  result = {
    orphanTrashed: (await Zotero.Items.getAsync(orphan.id)).deleted,
    parentSurvives: !(await Zotero.Items.getAsync(parent.id)).deleted,
    retainedSurvives: !(await Zotero.Items.getAsync(retained.id)).deleted,
    metadataRetained: parent.getField('abstractNote') === 'Metadata must survive',
    collectionRetained: parent.getCollections().includes(collection.id),
    tagRetained: retained.hasTag('__fixture_keep_tag__'),
    retainedFileExists: Boolean(await retained.getFilePathAsync()),
    orphanFileStillExists: Boolean(await orphan.getFilePathAsync())
  };
  if (Object.values(result).some(value => !value)) throw new Error('Fixture assertion failed: ' + JSON.stringify(result));
} finally {
  for (var id of created.reverse()) {
    var fixtureItem = await Zotero.Items.getAsync(id);
    if (fixtureItem) await fixtureItem.eraseTx();
  }
  if (collection?.id) await collection.eraseTx();
  await IOUtils.remove(fixturePath, {ignoreAbsent:true});
}
return {passed:result, fixturesRemoved:true};
