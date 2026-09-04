var allItems = await Zotero.Items.getAll(1, false, false);
var topItems = await Zotero.Items.getAll(1, true, false);
var byID = new Map(allItems.map(item => [item.id, item]));
var buckets = new Map();
var missing = 0;
var failed = 0;
for (var item of allItems) {
  if (!item.isAttachment() || item.attachmentContentType !== 'application/pdf') continue;
  try {
    var path = await item.getFilePathAsync();
    if (!path) { missing++; continue; }
    var bytes = await IOUtils.read(path);
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    if (!buckets.has(hash)) buckets.set(hash, []);
    buckets.get(hash).push(item);
  } catch (error) { failed++; }
}
var groups = [];
for (var [hash, attachments] of buckets) {
  var children = attachments.filter(item => item.parentItemID && byID.get(item.parentItemID)?.isRegularItem());
  var orphans = attachments.filter(item => !item.parentItemID);
  if (!children.length || !orphans.length) continue;
  groups.push({ hash, parentKeys: [...new Set(children.map(item => byID.get(item.parentItemID).key))], childKeys: children.map(item => item.key), orphanKeys: orphans.map(item => item.key), annotatedOrphans: orphans.filter(item => item.getAnnotations().length || item.getNotes().length).map(item => item.key) });
}
return { total: allItems.length, top: topItems.length, childAttachments: allItems.filter(item => item.isAttachment() && item.parentItemID).length, missing, failed, exactGroups: groups.length, orphanCount: groups.reduce((count, group) => count + group.orphanKeys.length, 0), groups };
