function resourceRelations(item) {
  return Object.values(item.getRelations()).some(value => Array.isArray(value) ? value.length : Boolean(value));
}
function resourceChildren(item, items) {
  return items.filter(child => !child.deleted && child.parentItemID === item.id);
}
function resourceProtected(item, items) {
  if (item.isAttachment()) return protectedAttachment(item, items);
  return resourceRelations(item) || resourceChildren(item, items).length > 0
    || /<(?:img|object|embed)\b/i.test(item.getNote());
}
async function resourceFileState(zotero, item) {
  if (!item.isFileAttachment()) return 'unknown';
  let storage = zotero.Sync && zotero.Sync.Storage;
  let local = storage && storage.Local;
  let pendingStates = [local && local.SYNC_STATE_TO_DOWNLOAD, local && local.SYNC_STATE_FORCE_DOWNLOAD,
    storage && storage.SYNC_STATE_TO_DOWNLOAD, storage && storage.SYNC_STATE_FORCE_DOWNLOAD, 1, 4].filter(value => value !== undefined);
  if (pendingStates.includes(item.attachmentSyncState)) return 'unknown';
  try {
    let path = await item.getFilePathAsync();
    if (path === false) return 'missing';
    if (!path) return 'unknown';
    let info = await IOUtils.stat(path);
    return info.type === 'regular' ? 'available' : 'unknown';
  } catch (error) {
    return error.name === 'NotFoundError' ? 'missing' : 'unknown';
  }
}
function resourceSnapshot(item, items) {
  return JSON.stringify({ parent: item.parentItemID || null, type: item.itemType,
    children: resourceChildren(item, items).map(child => child.id).sort((first, second) => first - second) });
}
async function resourceInvalidReason(zotero, item, items) {
  if (item.deleted || resourceRelations(item)) return null;
  if (item.isAttachment()) {
    if (resourceProtected(item, items) || (item.parentItemID && !items.some(parent => parent.id === item.parentItemID && !parent.deleted))) return null;
    return await resourceFileState(zotero, item) === 'missing' ? '附件文件已不存在' : null;
  }
  if (!item.isRegularItem()) return null;
  let children = resourceChildren(item, items);
  if (children.some(child => !child.isAttachment() || resourceProtected(child, items))) return null;
  if (!children.length) return '条目没有附件';
  for (let child of children) {
    if (await resourceFileState(zotero, child) !== 'missing') return null;
  }
  return '条目的所有附件文件均已不存在';
}
async function resourceScan(zotero, libraryID, allItems, onProgress, mode = 'duplicates') {
  let liveItems = allItems.filter(item => !item.deleted && item.libraryID === libraryID);
  let liveIDs = new Set(liveItems.map(item => item.id));
  let items = liveItems.filter(item => !item.parentItemID || liveIDs.has(item.parentItemID));
  let groups = [];
  let skipped = [];
  if (mode === 'invalid') {
    let invalidParentIDs = new Set();
    let ordered = [...items].sort((first, second) => Number(second.isRegularItem()) - Number(first.isRegularItem()));
    for (let item of ordered) {
      if (invalidParentIDs.has(item.parentItemID)) continue;
      let reason = await resourceInvalidReason(zotero, item, items);
      if (reason) {
        if (item.isRegularItem()) invalidParentIDs.add(item.id);
        groups.push({ type: 'invalidResource', items: [item], reason,
          title: reason + ' · ' + (item.getField('title') || item.key), details: [item.key + '；移入回收站'],
          snapshot: resourceSnapshot(item, items) });
      }
    }
    return { groups, skipped };
  }
  let candidates = new Map();
  for (let item of items) {
    let type;
    let signature;
    if (item.isAttachment() && item.attachmentContentType === 'application/pdf' && item.isFileAttachment()) {
      try { signature = await attachmentFingerprint(item); }
      catch (error) { skipped.push(item.key + '：无法读取 PDF'); continue; }
      type = 'pdfResource';
    } else if (item.isNote()) {
      signature = String(item.getNote() || '');
      if (!signature.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160|#xA0);/gi, ' ').trim() || resourceProtected(item, items)) continue;
      type = 'noteResource';
    } else continue;
    let key = JSON.stringify([type, item.parentItemID || null, signature]);
    if (!candidates.has(key)) candidates.set(key, { type, signature, items: [] });
    candidates.get(key).items.push(item);
    if (onProgress) onProgress('已检查资源 ' + item.key);
  }
  for (let candidate of candidates.values()) {
    if (candidate.items.length < 2) continue;
    if (candidate.type === 'pdfResource' && !candidate.items[0].parentItemID
      && [...candidates.values()].some(other => other.type === 'pdfResource' && other.signature === candidate.signature && other.items[0].parentItemID)) continue;
    candidate.items.sort((first, second) => Number(resourceProtected(second, items)) - Number(resourceProtected(first, items)) || first.id - second.id);
    let retained = candidate.items[0];
    let donors = candidate.items.slice(1).filter(item => !resourceProtected(item, items));
    if (!donors.length) continue;
    groups.push({ type: candidate.type, items: [retained, ...donors], retainedID: retained.id,
      signature: candidate.signature, parentID: retained.parentItemID || null,
      title: (candidate.type === 'pdfResource' ? '重复 PDF · ' : '重复笔记 · ') + (retained.getField('title') || retained.key),
      details: [(candidate.type === 'pdfResource' ? 'PDF 内容完全相同' : '笔记 HTML 完全相同') + '；保留 ' + retained.key,
        ...donors.map(item => '移入回收站：' + item.key)] });
  }
  return { groups, skipped };
}
async function resourceCurrent(zotero, libraryID) {
  return (await zotero.Items.getAll(libraryID, false, false)).filter(item => !item.deleted && item.libraryID === libraryID);
}
async function resourceValidatePair(zotero, libraryID, group, donorID) {
  let items = await resourceCurrent(zotero, libraryID);
  let retained = items.find(item => item.id === group.retainedID);
  let donor = items.find(item => item.id === donorID);
  if (!retained || !donor || retained.id === donor.id
    || (retained.parentItemID || null) !== group.parentID || (donor.parentItemID || null) !== group.parentID
    || resourceProtected(donor, items)) throw new Error('资源或父子关系已变化，请重新扫描');
  if (group.type === 'pdfResource') {
    if (![retained, donor].every(item => item.isAttachment() && item.isFileAttachment() && item.attachmentContentType === 'application/pdf')
      || await attachmentFingerprint(retained) !== group.signature || await attachmentFingerprint(donor) !== group.signature) throw new Error('PDF 内容已变化，请重新扫描');
  } else if (![retained, donor].every(item => item.isNote() && !resourceProtected(item, items) && item.getNote() === group.signature)) {
    throw new Error('笔记内容已变化，请重新扫描');
  }
  return { retained, donor, items };
}
async function resourceApply(zotero, libraryID, group) {
  let removed = 0;
  if (group.type === 'invalidResource') {
    async function validate() {
      let items = await resourceCurrent(zotero, libraryID);
      let item = items.find(candidate => candidate.id === group.items[0].id);
      if (!item || resourceSnapshot(item, items) !== group.snapshot
        || await resourceInvalidReason(zotero, item, items) !== group.reason) throw new Error('条目或文件状态已变化，请重新扫描');
      return { item, items };
    }
    await validate();
    await zotero.DB.executeTransaction(async () => {
      let { item, items } = await validate();
      for (let child of resourceChildren(item, items)) {
        await zotero.Items.trash(child.id);
      }
      await zotero.Items.trash(item.id);
      removed++;
    });
    return removed;
  }
  if (!['pdfResource', 'noteResource'].includes(group.type)) throw new Error('未知资源类型');
  for (let reference of group.items) {
    if (reference.id === group.retainedID) continue;
    await resourceValidatePair(zotero, libraryID, group, reference.id);
    await zotero.DB.executeTransaction(async () => {
      let { retained, donor, items } = await resourceValidatePair(zotero, libraryID, group, reference.id);
      for (let tag of donor.getTags()) retained.addTag(tag.tag, tag.type);
      let collectionTarget = retained.parentItemID ? items.find(item => item.id === retained.parentItemID) : retained;
      if (!collectionTarget) throw new Error('父条目不存在，请重新扫描');
      for (let collectionID of donor.getCollections()) collectionTarget.addToCollection(collectionID);
      await retained.save();
      if (collectionTarget !== retained) await collectionTarget.save();
      await zotero.Items.trash(donor.id);
      removed++;
    });
  }
  return removed;
}
