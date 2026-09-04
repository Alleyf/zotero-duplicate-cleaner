function groupLocationModel(zotero, group, allItems) {
  let byID = new Map(allItems.map(item => [item.id, item]));
  for (let item of group.items) if (!byID.has(item.id)) byID.set(item.id, item);
  let details = [];
  let model = { resources: [], destination: null, details };
  function libraryName(item) {
    try { return zotero.Libraries.get(item.libraryID).name || '未知文献库（' + item.libraryID + '）'; }
    catch (error) { return '未知文献库（' + item.libraryID + '）'; }
  }
  function label(item) {
    return item.key + ' · ' + (item.getField('title') || '无标题');
  }
  function directCollections(item) {
    try { return item.getCollections(); }
    catch (error) { return null; }
  }
  function collectionPath(collectionID, libraryID) {
    let names = [];
    let visited = new Set();
    while (collectionID) {
      if (visited.has(collectionID)) { names.unshift('未知分类（层级循环）'); break; }
      visited.add(collectionID);
      let collection;
      try { collection = zotero.Collections.get(collectionID); } catch (error) {}
      if (!collection || collection.libraryID !== libraryID) {
        names.unshift('未知分类（ID ' + collectionID + '）');
        break;
      }
      names.unshift(collection.name || '未命名分类');
      collectionID = collection.parentID;
    }
    return names.join(' / ');
  }
  function ancestry(item) {
    let chain = [];
    let current = item;
    let visited = new Set([item.id]);
    while (current.parentItemID) {
      let parent = byID.get(current.parentItemID);
      if (!parent || parent.deleted || parent.libraryID !== item.libraryID || visited.has(parent.id)) {
        return { owner: null, chain, unknown: '父条目无法确认（ID ' + current.parentItemID + '）' };
      }
      visited.add(parent.id);
      chain.unshift(parent);
      current = parent;
    }
    return { owner: current, chain };
  }
  function pathValues(collectionIDs, libraryID) {
    if (collectionIDs === null) return ['未知分类（读取失败）'];
    if (!collectionIDs.length) return ['未分类'];
    return [...new Set(collectionIDs.map(id => collectionPath(id, libraryID)))];
  }
  function paths(collectionIDs, libraryID) {
    return pathValues(collectionIDs, libraryID).join('；');
  }
  function describe(item, role, action) {
    if (!item) return;
    let source = ancestry(item);
    let location = source.owner ? paths(directCollections(source.owner), item.libraryID) : '未知分类：' + source.unknown;
    let parentText = source.chain.length ? '；父条目：' + source.chain.map(label).join(' → ') + '；分类继承自父条目' : '';
    model.resources.push({ role, key: item.key, title: item.getField('title') || '无标题', library: libraryName(item),
      paths: source.owner ? pathValues(directCollections(source.owner), item.libraryID) : ['未知分类：' + source.unknown],
      parents: source.chain.map(label), action });
    details.push(role + '：' + label(item) + '；文献库：' + libraryName(item) + '；分类：' + location + parentText + '；' + action);
  }
  function recycle(item) { return '预计移入「' + libraryName(item) + ' / 回收站」'; }
  function destination(target, donors) {
    if (!target) { model.destination = {title:'保留条目无法确认',key:'',library:'未知文献库',paths:['未知分类']}; details.push('预计处理后保留条目分类：未知（保留条目无法确认）'); return; }
    let owner = ancestry(target).owner;
    if (!owner) { model.destination = {title:'父条目无法确认',key:'',library:libraryName(target),paths:['未知分类']}; details.push('预计处理后保留条目分类：未知（父条目无法确认）'); return; }
    let memberships = directCollections(owner);
    if (memberships !== null) {
      memberships = [...memberships];
      for (let donor of donors) {
        let additions = directCollections(donor);
        if (additions === null) { memberships = null; break; }
        memberships.push(...additions);
      }
    }
    details.push('预计处理后保留条目分类：' + label(owner) + '；文献库：' + libraryName(owner) + '；' + paths(memberships, owner.libraryID) + '（保留原分类，并合入被合并资源的分类归属）');
    model.destination = {title:owner.getField('title') || '无标题',key:owner.key,library:libraryName(owner),paths:pathValues(memberships,owner.libraryID)};
  }
  if (group.type === 'invalidResource') {
    let target = group.items[0];
    describe(target, '待清理资源', recycle(target));
    for (let child of allItems.filter(item => !item.deleted && item.parentItemID === target.id)) {
      describe(child, '同时清理的子资源', recycle(child));
    }
    return model;
  }
  if (group.type === 'regular') {
    let retained = group.items[0];
    let donors = group.items.slice(1);
    describe(retained, '保留条目', '预计保留，分类归属见下方');
    for (let donor of donors) describe(donor, '合并来源条目', '元信息与资源归入 ' + retained.key + '；' + recycle(donor));
    let groupIDs = new Set(group.items.map(item => item.id));
    for (let child of allItems.filter(item => !item.deleted && groupIDs.has(item.parentItemID))) {
      describe(child, '条目所含资源', '预计归属保留条目 ' + retained.key + '；失效 PDF 仅在复核符合清理条件时移入回收站');
    }
    destination(retained, donors);
    return model;
  }
  let retained = byID.get(group.retainedID);
  let donors = group.items.filter(item => item.id !== group.retainedID);
  if (group.type === 'orphan') {
    let parent = byID.get(group.parentID);
    describe(parent, '保留条目', '预计保留，接收独立 PDF 的分类归属');
    describe(retained, '保留 PDF', '预计保留在原父条目下');
    for (let donor of donors) describe(donor, '重复独立 PDF', recycle(donor));
    destination(parent, donors);
  } else {
    describe(retained, '保留资源', '预计保留在原位置，分类归属见下方');
    for (let donor of donors) describe(donor, '重复资源', recycle(donor));
    destination(retained, donors);
  }
  return model;
}
function groupLocationDetails(zotero, group, allItems) {
  return groupLocationModel(zotero, group, allItems).details;
}
