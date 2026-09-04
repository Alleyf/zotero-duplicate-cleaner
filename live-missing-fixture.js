var pluginSource = await IOUtils.readUTF8('C:\\Users\\Administrator\\Desktop\\master\\workspace\\zotero-dedup-plugin\\bootstrap.js');
var helpers = eval('(function(){' + pluginSource + ';return {mergeRegularGroup, pdfFileState};})()');
var created = [];
var fixturePath = PathUtils.join(Zotero.getTempDirectory().path, 'codex-missing-fixture-' + Date.now() + '.pdf');
var result;
try {
  var sourceAttachment = await Zotero.Items.getByLibraryAndKeyAsync(1, '28V22S2Z');
  var bytes = await IOUtils.read(await sourceAttachment.getFilePathAsync());
  var suffix = new TextEncoder().encode('\n% isolated missing PDF test ' + Date.now() + '\n');
  var content = new Uint8Array(bytes.length + suffix.length);
  content.set(bytes); content.set(suffix, bytes.length);
  await IOUtils.write(fixturePath, content);
  async function createParent(title) {
    var item = new Zotero.Item('journalArticle'); item.libraryID = 1;
    item.setField('title', title); await item.saveTx(); created.push(item.id); return item;
  }
  async function attach(parent, missing) {
    var attachment = await Zotero.Attachments.importFromFile({file:fixturePath,parentItemID:parent.id,contentType:'application/pdf'});
    if (missing) {
      var path = await attachment.getFilePathAsync();
      if (!path.includes('\\' + attachment.key + '\\')) throw new Error('Unexpected fixture path');
      await IOUtils.remove(path);
    }
    return attachment;
  }
  var rich = await createParent('__Codex missing fixture duplicate__');
  rich.setField('abstractNote', 'Preserve donor abstract');
  rich.setCreators([{firstName:'Fixture',lastName:'Author',creatorType:'author'}]);
  await rich.saveTx();
  var missingPDF = await attach(rich, true);
  var viable = await createParent('__Codex missing fixture duplicate__');
  var livePDF = await attach(viable, false);
  var unique = await createParent('__Codex missing fixture unique__');
  var uniquePDF = await attach(unique, true);
  var outcome = await helpers.mergeRegularGroup(Zotero, 1, [rich, viable]);
  result = {
    validPDFParentChosen:outcome.primaryID === viable.id,
    richDuplicateTrashed:(await Zotero.Items.getAsync(rich.id)).deleted,
    viableParentSurvives:!(await Zotero.Items.getAsync(viable.id)).deleted,
    donorAbstractPreserved:viable.getField('abstractNote') === 'Preserve donor abstract',
    donorCreatorsPreserved:viable.getCreators()[0]?.lastName === 'Author',
    missingRecordTrashed:(await Zotero.Items.getAsync(missingPDF.id)).deleted,
    actualPDFSurvives:await helpers.pdfFileState(livePDF) === 'available',
    uniqueRecordUnchanged:!unique.deleted && !uniquePDF.deleted,
    removed:outcome.removed
  };
  if (Object.entries(result).some(([key,value])=>key !== 'removed' && value !== true)) throw new Error(JSON.stringify(result));
} finally {
  for (var id of created.reverse()) {
    var fixtureItem = await Zotero.Items.getAsync(id);
    if (fixtureItem) await fixtureItem.eraseTx();
  }
  await IOUtils.remove(fixturePath, {ignoreAbsent:true});
}
return {passed:result,fixturesRemoved:true};
