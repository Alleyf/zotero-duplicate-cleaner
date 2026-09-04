var windows = new Set();
var panelStates = new Map();
var stopped = false;
var htmlNamespace = 'http://www.w3.org/1999/xhtml';
var pluginRootURI = '';
var pdfHashCache = new Map();
var activeJobs = 0;

function metadataRichness(item) {
  let fields = ['title', 'DOI', 'date', 'publicationTitle', 'abstractNote', 'volume', 'issue', 'pages', 'publisher', 'url', 'ISBN', 'ISSN'];
  return fields.reduce((score, field) => score + (String(item.getField(field) || '').trim() ? 1 : 0), 0)
    + (item.getCreators().length ? 3 : 0);
}
function richest(first, second) {
  return metadataRichness(second) - metadataRichness(first) || first.id - second.id;
}
async function pdfFileState(item) {
  if (!item.isAttachment() || item.attachmentContentType !== 'application/pdf'
    || (typeof item.isFileAttachment === 'function' && !item.isFileAttachment())) return 'unknown';
  try {
    let path = await item.getFilePathAsync();
    if (path === false) return 'missing';
    if (!path) return 'unknown';
    let info = await IOUtils.stat(path);
    return info.type === 'regular' && info.size > 0 ? 'available' : 'unknown';
  } catch (error) { return 'unknown'; }
}
async function regularPDFStatus(items, allItems) {
  let statuses = new Map(items.map(item => [item.id, { available: [], missing: [], unknown: [] }]));
  for (let attachment of allItems) {
    let status = statuses.get(attachment.parentItemID);
    if (!status || attachment.deleted || !attachment.isAttachment() || attachment.attachmentContentType !== 'application/pdf') continue;
    status[await pdfFileState(attachment)].push(attachment);
  }
  return statuses;
}
function preferredRegular(first, second, statuses) {
  return Number(statuses.get(second.id).available.length > 0) - Number(statuses.get(first.id).available.length > 0)
    || richest(first, second);
}
async function fillMissingMetadata(zotero, primary, donors) {
  let changed = false;
  for (let fieldID of zotero.ItemFields.getItemTypeFields(primary.itemTypeID)) {
    let field = zotero.ItemFields.getName(fieldID);
    if (String(primary.getField(field) || '').trim()) continue;
    let donor = donors.find(item => item.itemTypeID === primary.itemTypeID && String(item.getField(field) || '').trim());
    if (!donor) continue;
    primary.setField(field, donor.getField(field));
    changed = true;
  }
  if (!primary.getCreators().length) {
    let donor = donors.find(item => item.itemTypeID === primary.itemTypeID && item.getCreators().length);
    if (donor) { primary.setCreators(donor.getCreators()); changed = true; }
  }
  if (changed) await primary.saveTx();
}
async function trashMissingGroupPDFs(zotero, libraryID, primary, missingIDs) {
  let removed = 0;
  let current = await zotero.Items.getAll(libraryID, false, false);
  for (let attachmentID of missingIDs) {
    let attachment = current.find(item => item.id === attachmentID);
    if (!attachment || attachment.deleted || attachment.parentItemID !== primary.id || protectedAttachment(attachment, current)) continue;
    if (await pdfFileState(attachment) !== 'missing') continue;
    let statuses = await regularPDFStatus([primary], current);
    let retained = statuses.get(primary.id).available[0];
    if (!retained) continue;
    await zotero.DB.executeTransaction(async () => {
      if (primary.deleted || attachment.deleted || retained.deleted || attachment.parentItemID !== primary.id
        || retained.parentItemID !== primary.id || protectedAttachment(attachment, current)
        || await pdfFileState(attachment) !== 'missing' || await pdfFileState(retained) !== 'available') return;
      for (let tag of attachment.getTags()) retained.addTag(tag.tag, tag.type);
      for (let collectionID of attachment.getCollections()) primary.addToCollection(collectionID);
      await retained.save();
      await primary.save();
      await zotero.Items.trash(attachment.id);
      removed++;
    });
  }
  return removed;
}
async function mergeRegularGroup(zotero, libraryID, items) {
  let current = await zotero.Items.getAll(libraryID, false, false);
  let statuses = await regularPDFStatus(items, current);
  items.sort((first, second) => preferredRegular(first, second, statuses));
  let primary = items[0];
  let donors = items.slice(1).sort(richest);
  let missingIDs = [...statuses.values()].flatMap(status => status.missing.map(item => item.id));
  await fillMissingMetadata(zotero, primary, donors);
  await zotero.Items.merge(primary, donors);
  let removed = await trashMissingGroupPDFs(zotero, libraryID, primary, missingIDs);
  return { primaryID: primary.id, removed };
}
async function attachmentFingerprint(item) {
  let path = await item.getFilePathAsync();
  if (!path) throw new Error(item.key + '：文件不存在');
  let info = await IOUtils.stat(path);
  if (!info.size) throw new Error(item.key + '：文件为空');
  let cacheKey = item.id + ':' + path + ':' + info.size + ':' + info.lastModifiedMs;
  let cached = pdfHashCache.get(cacheKey);
  if (cached) return cached;
  let bytes = await IOUtils.read(path);
  if (!bytes.length) throw new Error(item.key + '：文件为空');
  let digest = await crypto.subtle.digest('SHA-256', bytes);
  let hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (pdfHashCache.size >= 4096) pdfHashCache.clear();
  pdfHashCache.set(cacheKey, hash);
  return hash;
}
function protectedAttachment(item, items) {
  if (typeof item.isFileAttachment === 'function' && !item.isFileAttachment()) return true;
  let note = String(item.getNote() || '');
  return items.some(child => !child.deleted && child.parentItemID === item.id)
    || item.getAnnotations().length > 0 || item.getNotes().length > 0
    || Object.values(item.getRelations()).some(relations => Array.isArray(relations) ? relations.length > 0 : Boolean(relations))
    || Boolean(note.replace(/<[^>]*>/g, '').trim()) || /<(?:img|object|embed)\b/i.test(note);
}
async function mergeOrphanPDFs(zotero, libraryID, group) {
  let current = await zotero.Items.getAll(libraryID, false, false);
  for (let reference of group.items) {
    let byID = new Map(current.map(item => [item.id, item]));
    let parent = byID.get(group.parentID);
    let retained = byID.get(group.retainedID);
    let orphan = byID.get(reference.id);
    if (!parent || parent.deleted || !parent.isRegularItem() || !retained || retained.deleted || !retained.isAttachment() || retained.attachmentContentType !== 'application/pdf' || retained.parentItemID !== parent.id) throw new Error('保留条目或附件已变化，请重新扫描');
    if (!orphan || orphan.deleted) continue;
    if (!orphan.isAttachment() || orphan.attachmentContentType !== 'application/pdf' || orphan.parentItemID || protectedAttachment(orphan, current)) throw new Error(orphan.key + '：附件关系或批注／笔记已变化，请重新扫描');
    if (await attachmentFingerprint(retained) !== group.hash || await attachmentFingerprint(orphan) !== group.hash) throw new Error(orphan.key + '：文件内容已变化，请重新扫描');
    await zotero.DB.executeTransaction(async () => {
      if (parent.deleted || retained.deleted || retained.parentItemID !== parent.id || orphan.deleted || orphan.parentItemID || protectedAttachment(orphan, current)) throw new Error('条目状态已变化，请重新扫描');
      for (let collectionID of orphan.getCollections()) parent.addToCollection(collectionID);
      for (let tag of orphan.getTags()) retained.addTag(tag.tag, tag.type);
      await parent.save();
      await retained.save();
      await zotero.Items.trash(orphan.id);
    });
  }
}

async function waitForRecognition(zotero, win, ids, timeoutMs, onProgress) {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => win.setTimeout(resolve, 2000));
    let current = await zotero.Items.getAsync(ids);
    let done = current.filter(entry => !entry || entry.deleted || entry.parentItemID).length;
    if (onProgress) onProgress('元数据识别进度：' + done + ' / ' + ids.length + '…');
    if (done === ids.length) return true;
  }
  return false;
}

function openPanel(window) {
  let existing = panelStates.get(window);
  if (existing) { existing.scanButton.focus(); return; }
  let document = window.document;
  let zotero = window.Zotero;
  let groups = [];
  let scannedItems = [];
  let skippedFiles = [];
  let scanMode = 'duplicates';
  let busy = false;
  let cancelled = false;
  let libraryIDs = typeof window.ZoteroPane.getSelectedLibraryIDs === 'function'
    ? window.ZoteroPane.getSelectedLibraryIDs()
    : [window.ZoteroPane.getSelectedLibraryID()];
  if (libraryIDs.length > 1) throw new Error('请先在左侧选中一个文献库或分类');
  let libraryID = libraryIDs[0] || zotero.Libraries.userLibraryID;
  function element(tag, text, parent) {
    let node = document.createElementNS(htmlNamespace, tag);
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  let backdrop = element('div', '', document.documentElement);
  backdrop.id = 'zotero-dedup-panel';
  backdrop.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:14px sans-serif;color:#222;');
  let panel = element('section', '', backdrop);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '重复清理');
  panel.setAttribute('style', 'box-sizing:border-box;width:1100px;max-width:94vw;height:800px;max-height:92vh;display:flex;flex-direction:column;background:#fff;padding:20px;border:1px solid #888;border-radius:8px;box-shadow:0 8px 32px #555;');
  let flowStyle = element('style', '.zotero-dedup-flow{display:flex;align-items:stretch;gap:10px;margin-top:12px;padding:12px;overflow-x:auto;background:#f7f9fc;border:1px solid #d9e1ec;border-radius:7px}.zotero-dedup-flow-column{min-width:240px;display:flex;flex-direction:column;gap:7px}.zotero-dedup-flow-column.process-column,.zotero-dedup-flow-column.single-column{justify-content:center}.zotero-dedup-flow-title{font-size:11px;font-weight:700;color:#536176;text-transform:uppercase}.zotero-dedup-flow-node{padding:9px 10px;border:1px solid #cbd8e8;border-radius:6px;background:#fff;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}.zotero-dedup-flow-name{display:inline;font-weight:700;color:#1f3553}.zotero-dedup-flow-role{display:inline-block;margin:0 6px 0 0;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;background:#e8f1ff;color:#24558f}.zotero-dedup-flow-path{display:block;margin-top:6px;padding-top:5px;border-top:1px solid #e4e9f0;font-size:11px;color:#536176}.zotero-dedup-flow-node.source{border-left:4px solid #4c82c3}.zotero-dedup-flow-node.process{border-left:4px solid #9b6bd3;background:#faf7ff}.zotero-dedup-flow-node.keep{border-left:4px solid #258451;background:#f0f9f3}.zotero-dedup-flow-node.remove{border-left:4px solid #c45b5b;background:#fff6f6}.zotero-dedup-flow-arrow{display:flex;align-items:center;font-size:25px;color:#8493a7}.zotero-dedup-flow-cluster{padding:7px;border:1px dashed #b8c9df;border-radius:6px;background:#f8fbff}.zotero-dedup-flow-cluster-title{margin-bottom:5px;font-size:11px;color:#536176;font-weight:600}.zotero-dedup-flow-toggle{padding:5px 9px;font:inherit;cursor:pointer}', panel);
  let dark = element('style', '@media (prefers-color-scheme: dark){#zotero-dedup-panel{background:rgba(0,0,0,.55)!important}#zotero-dedup-panel section{background:#1a2130!important;border-color:#3b4a63!important;color:#dde3ee!important;box-shadow:0 8px 32px rgba(0,0,0,.55)!important}#zotero-dedup-panel h2{color:#e9eef7!important}#zotero-dedup-panel a{color:#8ab4ff!important}#zotero-dedup-search{background:#232c3d!important;color:#dde3ee!important;border-color:#43536f!important}#zotero-dedup-groups{background:#141a26!important;border-color:#3b4a63!important}#zotero-dedup-status{background:#232c3d!important;color:#c3ccdc!important}#zotero-dedup-counts,#zotero-dedup-statistics{color:#9fb0c8!important}#zotero-dedup-statistics{background:#232c3d!important;border-color:#3b4a63!important}.zotero-dedup-group{background:#1e2637!important;border-color:#3b4a63!important;box-shadow:none!important}.zotero-dedup-group>label{color:#e2e8f2!important}.zotero-dedup-group button,.zotero-dedup-flow-toggle{background:#232c3d!important;color:#9cc0f5!important;border-color:#43536f!important}.zotero-dedup-group button:hover{background:#2c3a52!important}.zotero-dedup-resource{background:#232c3d!important;border-color:#3b4a63!important;box-shadow:none!important}.zotero-dedup-flow{background:#1e2637!important;border-color:#3b4a63!important}.zotero-dedup-flow-node{background:#232c3d!important;border-color:#43536f!important}.zotero-dedup-flow-node.source{background:#22314a!important}.zotero-dedup-flow-node.process{background:#2c2440!important}.zotero-dedup-flow-node.keep{background:#1d3529!important;border-color:#2e6b4a!important}.zotero-dedup-flow-node.remove{background:#3a2427!important;border-color:#7a3f42!important}.zotero-dedup-flow-arrow{color:#7d8da6!important}.zotero-dedup-flow-cluster{background:#202c42!important}.zotero-dedup-flow-cluster-title,.zotero-dedup-flow-title{color:#9fb0c8!important}.zotero-dedup-destination{background:#1d3529!important}.zotero-dedup-locations details{background:#1e2637!important;border-color:#3b4a63!important}#zotero-dedup-panel [style*="color:#536176"],#zotero-dedup-panel [style*="color:#64748b"],#zotero-dedup-panel [style*="color:#334155"],#zotero-dedup-panel [style*="color:#44546a"],#zotero-dedup-panel [style*="color:#234771"],#zotero-dedup-panel [style*="color:#183452"],#zotero-dedup-panel [style*="color:#1f3553"],#zotero-dedup-panel [style*="color:#5c6470"]{color:#b6c2d6!important}#zotero-dedup-panel [style*="color:#17623a"]{color:#7fd0a2!important}#zotero-dedup-panel [style*="color:#82550b"]{color:#e0b45f!important}#zotero-dedup-panel [style*="color:#24558f"]{color:#9cc0f5!important}#zotero-dedup-panel [style*="background:#f0f5fc"]{background:#223049!important;border-color:#3b5175!important;color:#b9cdee!important}#zotero-dedup-panel [style*="background:#dff2e6"]{background:#1d3529!important;color:#7fd0a2!important}#zotero-dedup-panel [style*="background:#fff0d5"]{background:#3a2f1d!important;color:#e0b45f!important}#zotero-dedup-panel [style*="background:#e8f1ff"]{background:#22314a!important;color:#9cc0f5!important}#zotero-dedup-panel [style*="background:#f8fafc"]{background:#232c3d!important}#zotero-dedup-panel [style*="background:#f8fbff"]{background:#202c42!important}}', panel);
  let polish = element('style', '.zotero-dedup-group{box-shadow:0 2px 8px rgba(31,53,83,.06)!important;background:#fff!important;border-color:#d7e0ec!important}.zotero-dedup-group>label{color:#183452!important}.zotero-dedup-group button{border:1px solid #b8c7da;border-radius:6px;background:#fff;color:#24558f}.zotero-dedup-group button:hover{background:#eef5ff}.zotero-dedup-resource{box-shadow:inset 3px 0 0 #dce8f6}.zotero-dedup-destination{box-shadow:0 1px 5px rgba(37,132,81,.08)}#zotero-dedup-groups{background:#f5f7fb!important;border:0!important;border-radius:8px!important}#zotero-dedup-status{color:#536176!important;padding:8px 10px;background:#f8fafc;border-radius:6px}#zotero-dedup-counts{font-weight:600}.zotero-dedup-flow-toggle{background:#f5f8fc!important}', panel);
  let header = element('div', '', panel);
  header.setAttribute('style', 'display:flex;gap:12px;align-items:center;margin-bottom:12px;');
  let icon = element('img', '', header);
  icon.src = pluginRootURI + 'icons/icon.svg';
  icon.width = 40; icon.height = 40; icon.alt = '';
  element('h2', '文献资源整理', header).setAttribute('style', 'margin:0;font-size:20px;');
  let authorLink = element('a', '作者：Alleyf', header);
  authorLink.href = 'https://github.com/Alleyf';
  authorLink.target = '_blank';
  authorLink.rel = 'noreferrer';
  authorLink.setAttribute('style', 'margin-left:auto;color:#24558f;font-size:12px;text-decoration:none;');
  authorLink.title = '打开 Alleyf 的 GitHub 主页';
  let rules = element('details', '', panel);
  rules.setAttribute('style', 'margin-bottom:12px;font-size:12px;color:#536176;');
  element('summary', '扫描范围与处理规则', rules).setAttribute('style', 'cursor:pointer;');
  element('p', '范围：当前文献库（含所有分类）。普通条目按类型及 DOI／完整标题匹配；独立 PDF 与条目内 PDF 按文件内容匹配。', rules);
  element('p', '重复普通条目优先保留有可用 PDF 的条目，再比较元信息；合并时补齐空白元信息。有可用 PDF 保留时，同组确认失效的 PDF 记录移入回收站。含批注、笔记或关联记录的附件跳过。', rules);
  let toolbar = element('div', '', panel);
  toolbar.setAttribute('style', 'display:flex;gap:8px;flex-wrap:wrap;');
  let searchBar = element('div', '', panel);
  searchBar.setAttribute('style', 'display:flex;gap:8px;align-items:center;margin-top:12px;');
  let search = element('input', '', searchBar);
  search.id = 'zotero-dedup-search';
  search.type = 'search';
  search.placeholder = '按资源名称搜索当前扫描结果';
  search.setAttribute('aria-label', '按资源名称搜索当前扫描结果');
  search.setAttribute('style', 'flex:1;min-width:0;padding:8px 10px;font:inherit;border:1px solid #aab5c5;border-radius:6px;');
  let searchClear = element('button', '清空搜索', searchBar);
  searchClear.id = 'zotero-dedup-search-clear';
  searchClear.type = 'button';
  searchClear.setAttribute('style', 'padding:8px 10px;font:inherit;');
  let counts = element('div', '', panel);
  counts.id = 'zotero-dedup-counts';
  counts.setAttribute('role', 'status');
  counts.setAttribute('style', 'margin-top:8px;color:#536176;font-size:12px;');
  function button(id, text, action) {
    let node = element('button', text, toolbar);
    node.id = 'zotero-dedup-' + id;
    node.type = 'button';
    node.setAttribute('style', 'padding:7px 12px;font:inherit;cursor:pointer;');
    node.addEventListener('click', action);
    return node;
  }
  let status = element('p', '点击“扫描重复”开始。', panel);
  status.id = 'zotero-dedup-status';
  status.setAttribute('role', 'status');
  status.setAttribute('style', 'white-space:pre-wrap;');
  let statistics = element('div', '', panel);
  statistics.id = 'zotero-dedup-statistics';
  statistics.hidden = true;
  statistics.setAttribute('style', 'margin:10px 0;padding:10px 12px;border:1px solid #d9e1ec;border-radius:7px;background:#f7f9fc;color:#334155;line-height:1.7;');
  let list = element('div', '', panel);
  list.id = 'zotero-dedup-groups';
  list.setAttribute('style', 'flex:1;min-height:0;overflow:auto;border:1px solid #ccc;padding:10px;');
  let noResults = element('p', '没有匹配的资源名称，请更换关键词或清空搜索。', panel);
  noResults.id = 'zotero-dedup-no-results';
  noResults.hidden = true;
  function updateCounts() {
    let visible = groups.filter(group => !group.row.hidden);
    counts.textContent = '显示 ' + visible.length + ' / 共 ' + groups.length + ' 组／项 · 已选 ' + visible.filter(group => group.checkbox.checked).length + ' · 全选与处理仅作用于当前搜索结果';
    noResults.hidden = !groups.length || visible.length > 0;
  }
  function filterGroups() {
    let query = search.value.trim().toLocaleLowerCase();
    for (let group of groups) {
      group.row.hidden = Boolean(query && !group.searchText.includes(query));
      if (group.row.hidden) group.checkbox.checked = false;
    }
    updateCounts();
  }
  search.addEventListener('input', filterGroups);
  searchClear.addEventListener('click', () => { search.value = ''; filterGroups(); search.focus(); });
  updateCounts();
  function report(message, error) {
    status.textContent = message;
    status.style.color = error ? '#b42318' : '#333';
  }
  function setBusy(value) {
    busy = value;
    for (let control of toolbar.children) control.disabled = value;
    let closeButton = toolbar.querySelector('#zotero-dedup-close');
    if (closeButton) closeButton.disabled = false;
    search.disabled = value;
    searchClear.disabled = value;
    for (let control of list.querySelectorAll('input,button')) control.disabled = value;
  }
  function selection(value) {
    for (let group of groups) if (!group.row.hidden) group.checkbox.checked = value;
    updateCounts();
  }
  function candidateKey(item) {
    let doi = (item.getField('DOI') || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
    let title = (item.getField('title') || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return doi || title ? item.itemTypeID + ':' + (doi ? 'doi:' + doi : 'title:' + title) : null;
  }
  function addGroup(group, heading, details) {
    let model = groupLocationModel(zotero, group, scannedItems);
    let row = element('div', '', list);
    row.className = 'zotero-dedup-group';
    row.setAttribute('style', 'padding:14px;margin-bottom:12px;border:1px solid #dce2ea;border-radius:8px;background:#fff;');
    let label = element('label', '', row);
    label.setAttribute('style', 'display:flex;gap:8px;align-items:flex-start;font-weight:600;line-height:1.5;overflow-wrap:anywhere;');
    let checkbox = element('input', '', label);
    checkbox.type = 'checkbox';
    checkbox.disabled = busy;
    checkbox.addEventListener('change', updateCounts);
    element('span', heading, label);
    let flowToggle = element('button', '查看资源流图', row);
    flowToggle.type = 'button';
    flowToggle.className = 'zotero-dedup-flow-toggle';
    flowToggle.setAttribute('style', 'margin-top:9px;');
    let flow = element('div', '', row);
    flow.className = 'zotero-dedup-flow';
    flow.hidden = false;
    function flowNode(parent, text, className, role, path) {
      let node = element('div', '', parent);
      node.className = 'zotero-dedup-flow-node ' + className;
      element('span', text, node).className = 'zotero-dedup-flow-name';
      if (role) element('span', role, node).className = 'zotero-dedup-flow-role';
      if (path) element('span', path, node).className = 'zotero-dedup-flow-path';
      return node;
    }
    function renderFlow() {
      flow.replaceChildren();
      let source = element('div', '', flow); source.className = 'zotero-dedup-flow-column' + (model.resources.length === 1 ? ' single-column' : '');
      element('div', '合并前资源', source).className = 'zotero-dedup-flow-title';
      let clusters = new Map();
      for (let resource of model.resources) {
        let key = resource.parents.length ? resource.parents.join(' → ') : '独立资源';
        if (!clusters.has(key)) clusters.set(key, []);
        clusters.get(key).push(resource);
      }
      let recognizeMode = group.type === 'orphanMetadata';
      for (let [key, resources] of clusters) {
        let holder = resources.length > 1 || key !== '独立资源' ? element('div', '', source) : source;
        if (holder !== source) { holder.className = 'zotero-dedup-flow-cluster'; element('div', key, holder).className = 'zotero-dedup-flow-cluster-title'; }
        for (let resource of resources) {
          flowNode(holder, resource.title, recognizeMode || resource.role.includes('保留') ? 'source' : 'remove', resource.role, resource.paths[0] || '未分类');
        }
      }
      let arrow1 = element('div', '→', flow); arrow1.className = 'zotero-dedup-flow-arrow';
      let process = element('div', '', flow); process.className = 'zotero-dedup-flow-column process-column';
      element('div', '处理过程', process).className = 'zotero-dedup-flow-title';
      let processText = ({regular:'条目类型 + DOI／标题匹配', orphan:'PDF 文件内容 SHA-256 匹配', pdfResource:'PDF 文件内容 SHA-256 匹配', noteResource:'笔记 HTML 内容匹配', invalidResource:'确认无附件或本地文件缺失', orphanMetadata:'调用 Zotero 内置 PDF 元数据识别'})[group.type] || '重复资源判定';
      flowNode(process, processText, 'process', '判定规则', recognizeMode ? '为独立 PDF 创建新父条目' : '保留元信息更完整且文件可用的资源');
      let arrow2 = element('div', '→', flow); arrow2.className = 'zotero-dedup-flow-arrow';
      let outcome = element('div', '', flow); outcome.className = 'zotero-dedup-flow-column';
      element('div', '合并后结果', outcome).className = 'zotero-dedup-flow-title';
      if (recognizeMode) {
        flowNode(outcome, '将创建新父条目', 'keep', '元数据识别', '选中的独立 PDF 将归入新建父条目');
      } else {
        let retained = model.resources.filter(resource => resource.role.includes('保留'));
        if (retained.length) flowNode(outcome, '保留 ' + retained.length + ' 项资源', 'keep', '元信息与文件可用', retained.map(resource => resource.paths[0] || '未分类').filter((path, index, paths) => paths.indexOf(path) === index).join(String.fromCharCode(10)));
        let removed = model.resources.filter(resource => !resource.role.includes('保留'));
        if (removed.length) flowNode(outcome, '重复资源移入回收站', 'remove', '待清理', removed.length + ' 项');
        if (model.destination) flowNode(outcome, '归属分类', 'keep', '合并后位置', model.destination.paths.join(String.fromCharCode(10)));
      }
      if (outcome.querySelectorAll('.zotero-dedup-flow-node').length === 1) outcome.classList.add('single-column');
    }
    renderFlow();
    flowToggle.addEventListener('click', () => {
      flow.hidden = !flow.hidden;
      flowToggle.textContent = flow.hidden ? '查看资源流图' : '隐藏资源流图';
      if (!flow.hidden && !flow.childNodes.length) renderFlow();
    });
    function paths(parent, values) {
      let container = element('div', '', parent);
      container.className = 'zotero-dedup-paths';
      container.setAttribute('style', 'display:flex;flex-direction:column;gap:5px;margin-top:6px;');
      for (let path of values.length ? values : ['未分类']) {
        element('div', path, container).setAttribute('style', 'align-self:flex-start;max-width:100%;box-sizing:border-box;padding:4px 8px;border:1px solid #c9d6e8;border-radius:5px;background:#f0f5fc;color:#234771;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;');
      }
    }
    let locations = element('div', '', row);
    locations.className = 'zotero-dedup-locations';
    locations.setAttribute('style', 'margin-top:12px;display:flex;flex-direction:column;gap:8px;');
    let groupedResources = new Map();
    let resourcesToRender = group.type === 'orphan'
      ? model.resources.filter(resource => !resource.role.includes('保留条目'))
      : model.resources;
    for (let resource of resourcesToRender) {
      let parentKey = resource.parents.length ? resource.parents.join(' → ') : '';
      if (!groupedResources.has(parentKey)) groupedResources.set(parentKey, []);
      groupedResources.get(parentKey).push(resource);
    }
    for (let [parentKey, resources] of groupedResources) {
      let resourceContainer = locations;
      if (parentKey) {
        let parentDetails = element('details', '', locations);
        parentDetails.open = true;
        parentDetails.setAttribute('style', 'border:1px solid #cbd8e8;border-radius:6px;background:#f8fbff;');
        let parentSummary = element('summary', '父条目：' + parentKey + '（' + resources.length + ' 个子资源）', parentDetails);
        parentSummary.setAttribute('style', 'padding:9px 12px;cursor:pointer;font-weight:600;color:#234771;');
        resourceContainer = element('div', '', parentDetails);
        resourceContainer.setAttribute('style', 'padding:0 10px 10px;');
      }
      for (let resource of resources) {
      let card = element('div', '', resourceContainer);
      card.className = 'zotero-dedup-resource';
      card.setAttribute('style', 'padding:10px 12px;background:#f8fafc;border:1px solid #e1e6ee;border-radius:6px;');
      let meta = element('div', '', card);
      meta.setAttribute('style', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;');
      let retained = resource.role.includes('保留');
      element('span', resource.role, meta).setAttribute('style', 'padding:2px 7px;border-radius:4px;font-size:12px;font-weight:600;background:' + (retained ? '#dff2e6;color:#17623a;' : '#fff0d5;color:#82550b;'));
      element('span', resource.library, meta).setAttribute('style', 'color:#64748b;font-size:12px;');
      element('span', resource.key, meta).setAttribute('style', 'margin-left:auto;color:#64748b;font-size:11px;');
      element('div', resource.title, card).setAttribute('style', 'margin-top:7px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;');
      for (let parent of resource.parents) element('div', '所属条目：' + parent, card).setAttribute('style', 'margin-top:4px;font-size:12px;color:#536176;overflow-wrap:anywhere;');
      element('div', '当前分类', card).setAttribute('style', 'margin-top:8px;font-size:11px;color:#64748b;');
      paths(card, resource.paths);
      element('div', resource.action, card).setAttribute('style', 'margin-top:8px;padding-top:7px;border-top:1px solid #e1e6ee;font-size:12px;color:#44546a;line-height:1.5;');
      }
    }
    if (model.destination) {
      let destination = element('div', '', row);
      destination.className = 'zotero-dedup-destination';
      destination.setAttribute('style', 'margin-top:10px;padding:10px 12px;border-left:3px solid #258451;background:#f0f9f3;border-radius:4px;');
      element('div', '合并后保留位置', destination).setAttribute('style', 'font-weight:600;color:#17623a;');
      element('div', model.destination.title, destination).setAttribute('style', 'margin-top:5px;overflow-wrap:anywhere;');
      element('div', model.destination.library, destination).setAttribute('style', 'margin-top:4px;font-size:12px;color:#536176;');
      paths(destination, model.destination.paths);
    }
    let evidence = element('details', '', row);
    evidence.setAttribute('style', 'margin-top:10px;font-size:12px;color:#536176;');
    element('summary', '判定依据', evidence).setAttribute('style', 'cursor:pointer;');
    for (let text of details) element('div', text, evidence).setAttribute('style', 'margin-top:6px;line-height:1.5;overflow-wrap:anywhere;');
    let searchText = [heading, ...model.resources.flatMap(resource => [resource.title, resource.key, ...resource.parents])].join(' ').toLocaleLowerCase();
    groups.push({ ...group, checkbox, row, searchText });
    filterGroups();
  }
  async function scan() {
    groups = [];
    skippedFiles = [];
    list.replaceChildren();
    updateCounts();
    let items = await zotero.Items.getAll(libraryID, false, false);
    scannedItems = items;
    if (scanMode === 'invalid') {
      let resources = await resourceScan(zotero, libraryID, items, report, 'invalid');
      for (let group of resources.groups) addGroup({ ...group, resource: true }, group.title, group.details);
      if (!groups.length) element('p', '未发现可清理的无附件／附件缺失条目。', list);
      if (resources.skipped.length) element('p', '跳过：' + resources.skipped.join('；'), list);
      return groups.length;
    }
    if (scanMode === 'orphanMetadata') {
      let orphanPDFs = items.filter(item => !item.deleted && item.isAttachment() && item.attachmentContentType === 'application/pdf' && !item.parentItemID && !(typeof item.isLinkedFile === 'function' && item.isLinkedFile()));
      for (let item of orphanPDFs) addGroup({ type: 'orphanMetadata', items: [item], key: item.key }, '待识别孤儿 PDF · ' + (item.getField('title') || item.attachmentFilename || item.key), ['将调用 Zotero 内置 PDF 元数据识别并尝试创建父条目。']);
      if (!groups.length) element('p', '未发现可识别的独立 PDF。', list);
      return groups.length;
    }
    let byID = new Map(items.map(item => [item.id, item]));
    let candidates = new Map();
    for (let item of items) {
      if (item.deleted || !item.isRegularItem()) continue;
      let key = candidateKey(item);
      if (!key) continue;
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(item);
    }
    let allStatuses = await regularPDFStatus(items.filter(item => !item.deleted && item.isRegularItem()), items);
    for (let items of candidates.values()) {
      if (items.length < 2) continue;
      let statuses = allStatuses;
      items.sort((first, second) => preferredRegular(first, second, statuses));
      addGroup({ type: 'regular', items, key: candidateKey(items[0]) }, '普通条目候选 · ' + items.length + ' 条：' + items[0].getField('title'),
        items.map((item, index) => (index ? '合并：' : '保留：') + item.key + '（ID ' + item.id + '） · ' + (item.getField('date') || '无日期') + ' · ' + (item.getField('firstCreator') || '无作者') + ' · 元信息评分 ' + metadataRichness(item)
          + ' · PDF 可用 ' + statuses.get(item.id).available.length + '／缺失 ' + statuses.get(item.id).missing.length + '／待确认 ' + statuses.get(item.id).unknown.length));
    }
    let pdfs = new Map();
    for (let item of items) {
      if (item.deleted || !item.isAttachment() || item.attachmentContentType !== 'application/pdf') continue;
      let parent = item.parentItemID ? byID.get(item.parentItemID) : null;
      if (item.parentItemID && (!parent || parent.deleted || !parent.isRegularItem())) continue;
      if (!parent && protectedAttachment(item, items)) { skippedFiles.push(item.key + '：含批注、笔记或关联记录'); continue; }
      try {
        report('正在核对 PDF 内容：' + item.key);
        let hash = await attachmentFingerprint(item);
        if (!pdfs.has(hash)) pdfs.set(hash, { children: [], orphans: [] });
        pdfs.get(hash)[parent ? 'children' : 'orphans'].push(item);
      } catch (error) { skippedFiles.push(item.key + '：' + error.message); }
    }
    for (let [hash, matches] of pdfs) {
      if (!matches.children.length || !matches.orphans.length) continue;
      matches.children.sort((first, second) => richest(byID.get(first.parentItemID), byID.get(second.parentItemID)) || first.id - second.id);
      let retained = matches.children[0];
      let parent = byID.get(retained.parentItemID);
      addGroup({ type: 'orphan', hash, parentID: parent.id, retainedID: retained.id, items: matches.orphans }, '内容相同的独立 PDF · ' + parent.getField('title'),
        ['保留条目：' + parent.key + ' · 元信息评分 ' + metadataRichness(parent), '保留附件：' + retained.key, '移入回收站的独立 PDF：' + matches.orphans.map(item => item.key).join('、')]);
    }
    let resources = await resourceScan(zotero, libraryID, items, report, 'duplicates');
    for (let group of resources.groups) addGroup({ ...group, resource: true }, group.title, group.details);
    skippedFiles.push(...resources.skipped);
    if (!groups.length) element('p', '未发现符合上述规则的重复资源。', list);
    if (skippedFiles.length) {
      let skipped = element('details', '', list);
      element('summary', '查看跳过的 ' + skippedFiles.length + ' 个资源及原因', skipped);
      for (let reason of skippedFiles) element('p', reason, skipped);
    }
    return groups.length;
  }
  let scanButton = button('scan', '扫描重复', async () => {
    if (busy) return;
    setBusy(true);
    scanMode = 'duplicates';
    report('正在扫描…');
    try { report('发现 ' + await scan() + ' 组候选重复，请核对后选择。'); }
    catch (error) { report('扫描失败：' + error.message, true); zotero.logError(error); }
    finally { setBusy(false); }
  });
  button('invalid', '扫描无效项', async () => {
    if (busy) return;
    setBusy(true);
    scanMode = 'invalid';
    report('正在检查附件状态…');
    try { report('发现 ' + await scan() + ' 项清理候选。无附件不代表文献无价值，请核对后选择。'); }
    catch (error) { report('检查失败：' + error.message, true); zotero.logError(error); }
    finally { setBusy(false); }
  });
  button('recognize-orphans', '扫描孤儿 PDF并建父条目', async () => {
    if (busy) return;
    setBusy(true);
    scanMode = 'orphanMetadata';
    report('正在扫描独立孤儿 PDF…');
    try {
      report('发现 ' + await scan() + ' 个孤儿 PDF，请勾选后点击“处理选中”。');
    } catch (error) { report('扫描失败：' + error, true); }
    finally { setBusy(false); }
  });
  button('statistics', '统计概览', async () => {
    if (busy) return;
    setBusy(true);
    try {
      let items = await zotero.Items.getAll(libraryID, false, false);
      let regular = items.filter(item => item.isRegularItem());
      let attachments = items.filter(item => item.isAttachment());
      let pdfs = attachments.filter(item => item.attachmentContentType === 'application/pdf');
      let notes = items.filter(item => item.isNote());
      let orphanPDFs = pdfs.filter(item => !item.parentItemID);
      let invalid = 0;
      for (let item of regular) {
        let children = item.getAttachments().map(id => zotero.Items.get(id)).filter(Boolean);
        let localPaths = await Promise.all(children.filter(child => child.isFileAttachment()).map(child => child.getFilePathAsync()));
        if (!children.length || (localPaths.length > 0 && localPaths.every(path => !path))) invalid++;
      }
      statistics.textContent = '条目 ' + regular.length + ' · 附件 ' + attachments.length + ' · PDF ' + pdfs.length + ' · 笔记 ' + notes.length + ' · 独立孤儿 PDF ' + orphanPDFs.length + ' · 无附件／文件缺失条目 ' + invalid;
      statistics.hidden = false;
      report('统计完成。');
    } catch (error) { report('统计失败：' + error, true); }
    finally { setBusy(false); }
  });
  button('all', '全选搜索结果', () => selection(true));
  button('none', '取消选择搜索结果', () => selection(false));
  button('merge', '处理选中', async () => {
    if (busy) return;
    let selected = groups.filter(group => !group.row.hidden && group.checkbox.checked);
    if (!selected.length) { report('请先选择需要合并的重复组。'); return; }
    if (!zotero.Libraries.get(libraryID).editable) { report('当前文献库没有编辑权限。', true); return; }
    let confirmation = scanMode === 'invalid'
      ? '将把选中的 ' + selected.length + ' 项无附件或附件缺失记录移入回收站，包括其列出的子附件。它们不一定是重复文献。请确认不再需要这些记录。'
      : scanMode === 'orphanMetadata'
      ? '将对选中的 ' + selected.length + ' 个独立 PDF 调用 Zotero 内置元数据识别，并尝试创建父条目。请确认继续。'
      : '将合并选中的 ' + selected.length + ' 组重复资源，保留列表中的主条目／PDF／笔记，并将重复记录移入回收站。缺失 PDF 的重复条目优先淘汰，空白元信息先补齐。';
    if (!Services.prompt.confirm(window, '确认处理', confirmation)) return;
    setBusy(true);
    let merged = 0;
    let failures = [];
    try {
      let groupPriority = type => type === 'orphanMetadata' ? 0 : type === 'orphan' ? 1 : 2;
      let orderedSelected = selected.sort((first, second) => groupPriority(first.type) - groupPriority(second.type));
      let recognizeIDs = [];
      for (let groupIndex = 0; groupIndex < orderedSelected.length; groupIndex++) {
        let group = orderedSelected[groupIndex];
        try {
          if (group.resource) { await resourceApply(zotero, libraryID, group); merged++; continue; }
          if (group.type === 'orphanMetadata') {
            if (typeof window.ZoteroPane.selectItems !== 'function' || typeof window.ZoteroPane.recognizeSelected !== 'function') throw new Error('当前 Zotero 未提供内置 PDF 识别接口');
            let batch = orderedSelected.slice(groupIndex, groupIndex + 10).filter(candidate => candidate.type === 'orphanMetadata');
            let batchIDs = batch.flatMap(candidate => candidate.items.map(item => item.id));
            window.ZoteroPane.selectItems(batchIDs);
            await new Promise(resolve => window.setTimeout(resolve, 250));
            await window.ZoteroPane.recognizeSelected();
            merged += batch.length;
            recognizeIDs.push(...batchIDs);
            groupIndex += batch.length - 1;
            continue;
          }
          if (group.type === 'orphan') { await mergeOrphanPDFs(zotero, libraryID, group); merged++; continue; }
          let items = await zotero.Items.getAsync(group.items.map(item => item.id));
          items = items.filter(item => item && !item.deleted && item.isRegularItem() && item.libraryID === libraryID);
          if (items.length < 2) continue;
          if (items.some(item => item.itemTypeID !== items[0].itemTypeID)) throw new Error('条目类型已变化，请重新扫描');
          if (items.some(item => candidateKey(item) !== group.key)) throw new Error('条目信息已变化，请重新扫描');
          report('正在合并：' + items[0].getField('title'));
          await mergeRegularGroup(zotero, libraryID, items);
          merged++;
        } catch (error) { failures.push(error.message); zotero.logError(error); }
      }
      if (recognizeIDs.length) {
        report('已提交 ' + recognizeIDs.length + ' 个 PDF 进行元数据识别，等待完成…');
        let overallTimeout = 30000 + 20000 * Math.ceil(recognizeIDs.length / 10);
        let completed = await waitForRecognition(zotero, window, recognizeIDs, overallTimeout, progress => report(progress));
        if (!completed) report('部分 PDF 未在限定时间内识别完成（常见于无 DOI 的扫描件或中文文献），识别仍在后台继续，可稍后重新扫描查看。', true);
      }
      let remaining = await scan();
      report('已处理 ' + merged + ' 组／项；剩余 ' + remaining + ' 个候选。' + (failures.length ? '\n失败 ' + failures.length + ' 组：' + failures.join('；') : ''), failures.length > 0);
    } catch (error) { report('已合并 ' + merged + ' 组；重新扫描失败：' + error.message, true); zotero.logError(error); }
    finally { setBusy(false); }
  });
  function close() {
    cancelled = true;
    dispose();
  }
  function keydown(event) {
    if (!backdrop.contains(event.target)) return;
    event.stopPropagation();
    if (event.key === 'Tab') {
      let controls = [...backdrop.querySelectorAll('button:not(:disabled), input:not(:disabled), summary')].filter(control => !control.closest('[hidden]'));
      if (!controls.length) { event.preventDefault(); return; }
      let index = controls.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0].focus(); }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy && search.value) { search.value = ''; filterGroups(); search.focus(); }
      else close();
    }
  }
  function dispose() {
    document.removeEventListener('keydown', keydown, true);
    backdrop.remove();
    panelStates.delete(window);
  }
  button('close', '关闭', close);
  document.addEventListener('keydown', keydown, true);
  panelStates.set(window, { scanButton, dispose });
  scanButton.focus();
}
function addMenu(window) {
  let popup = window.document.getElementById('menu_ToolsPopup') || window.document.querySelector('#menu_ToolsPopup, menupopup[id*="ToolsPopup"], menupopup[anonid="toolsPopup"]');
  if (!popup || window.document.getElementById('zotero-dedup-tools-menu')) return;
  let item = window.document.createXULElement('menuitem');
  item.id = 'zotero-dedup-tools-menu';
  item.setAttribute('label', '文献资源整理');
  item.classList.add('menuitem-iconic');
  item.setAttribute('image', pluginRootURI + 'icons/icon.svg');
  item.style.listStyleImage = 'url("' + pluginRootURI + 'icons/icon.svg")';
  item.addEventListener('command', () => {
    try { openPanel(window); }
    catch (error) { window.Zotero.logError(error); Services.prompt.alert(window, '重复清理加载失败', String(error)); }
  });
  popup.appendChild(item);
  windows.add(window);
}
function ensureMenu(window, attempt = 0) {
  if (stopped) return;
  addMenu(window);
  if (!window.document.getElementById('zotero-dedup-tools-menu') && attempt < 12) {
    window.setTimeout(() => ensureMenu(window, attempt + 1), 500);
  }
}
function removeMenu(window) {
  let panel = panelStates.get(window);
  if (panel) panel.dispose();
  let item = window.document.getElementById('zotero-dedup-tools-menu');
  if (item) item.remove();
  windows.delete(window);
}
async function startup(data, reason) {
  pluginRootURI = typeof data.rootURI === 'string' ? data.rootURI : data.rootURI.spec;
  stopped = false;
  if (typeof Zotero !== 'undefined') await Zotero.initializationPromise;
  if (stopped) return;
  for (let window of Services.wm.getEnumerator('navigator:browser')) {
    let previousMenu = window.document.getElementById('zotero-dedup-tools-menu');
    if (previousMenu) previousMenu.remove();
    ensureMenu(window);
  }
}
function onMainWindowLoad({ window }) { if (!stopped) ensureMenu(window); }
function onMainWindowUnload({ window }) { removeMenu(window); }
function shutdown(data, reason) { stopped = true; for (let window of windows) removeMenu(window); }
function install(data, reason) {}
function uninstall(data, reason) {}
