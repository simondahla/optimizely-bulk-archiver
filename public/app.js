var PAGE_SIZE = 25;
var items = [];
var allItems = []; // everything fetched, unfiltered - lets the Active/Archived toggle re-filter without another API call
var viewMode = 'active'; // 'active' | 'archived' - drives both the list filter and which bulk action (archive vs unarchive) is wired up
var selected = new Set();
var currentPage = 1;
var projectId = '';
// Running experiments are hidden by default: this tool is for cleaning up dead/unused tests,
// not for touching ones actively serving traffic. A running test has to be paused in Optimizely
// itself before it's a candidate for archiving here.
var EXCLUDE = ['archived', 'concluded', 'running'];
// GET /experiments has no server-side "type" filter (not in the API spec) --
// restrict to classic A/B tests client-side instead of relying on a query param that's silently ignored.
var INCLUDE_TYPES = ['a/b'];
// Safety: never allow selecting an experiment whose parent campaign could still be live.
// 'running' is already excluded above and never reaches the list at all; 'campaign_paused'
// is shown (so you can see it exists) but locked, since the campaign can be resumed any time.
var LOCKED_STATUSES = ['campaign_paused'];
// Safety: experiments created within this window are flagged "new" and excluded from
// "Select page" / "Select all" so a fresh test never gets swept up by accident. They can
// still be archived individually if you deliberately check their box.
var NEW_DAYS = 14;

// Restore project ID from localStorage on load
document.addEventListener('DOMContentLoaded', function() {
  var savedProject = localStorage.getItem('optimizely_project_id');
  if (savedProject) document.getElementById('project').value = savedProject;

  document.getElementById('project').addEventListener('change', function() {
    localStorage.setItem('optimizely_project_id', this.value.trim());
  });
});

function findItem(id) { return items.find(function(i) { return i.id === id; }); }

function isLocked(item) { return item && LOCKED_STATUSES.indexOf(item.status) !== -1; }

function isNew(item) {
  if (!item || !item.created) return false;
  var ageMs = Date.now() - new Date(item.created).getTime();
  return ageMs < NEW_DAYS * 24 * 60 * 60 * 1000;
}

// Re-derives `items` from the already-fetched `allItems` for the current viewMode.
// No extra API call needed since fetchOptimizations() already pulls every status.
function computeItems() {
  return allItems.filter(function(e) {
    if (INCLUDE_TYPES.indexOf(e.type || 'a/b') === -1) return false;
    return viewMode === 'archived' ? e.status === 'archived' : EXCLUDE.indexOf(e.status) === -1;
  }).sort(function(a, b) {
    return new Date(a.last_modified) - new Date(b.last_modified);
  });
}

function updateStatusMessage() {
  if (viewMode === 'archived') {
    setStatus(items.length + ' archived A/B test' + (items.length === 1 ? '' : 's') + ' found.', 'ok');
  } else {
    var hidden = allItems.length - items.length;
    setStatus(items.length + ' active A/B tests found' + (hidden ? ' (' + hidden + ' archived/concluded/running/non-A-B hidden)' : '') + '.', 'ok');
  }
}

function appendLog(text, cls) {
  var el = document.getElementById('log');
  var line = document.createElement('span');
  line.className = cls || '';
  line.textContent = text + '\n';
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function logReq(method, url)  { appendLog('-> ' + method + ' ' + url, 'req'); }
function logRes(status, body) { appendLog('<- ' + status + ' ' + body, status >= 400 ? 'err' : 'res'); }
function logInfo(msg)         { appendLog('   ' + msg, 'info'); }
function logErr(msg)          { appendLog('X  ' + msg, 'err'); }

function pageCount() { return Math.ceil(items.length / PAGE_SIZE); }
function pageItems() { return items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE); }

function setStatus(msg, type) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (type ? ' ' + type : '');
}

function updateToolbar() {
  document.getElementById('selCount').textContent = selected.size + ' selected';
  document.getElementById('bulkActionBtn').disabled = selected.size === 0;
}

function updateBulkActionButton() {
  var btn = document.getElementById('bulkActionBtn');
  if (viewMode === 'archived') {
    btn.textContent = 'Unarchive selected';
    btn.className = 'primary';
  } else {
    btn.textContent = 'Archive selected';
    btn.className = 'danger';
  }
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  selected.clear();
  currentPage = 1;
  items = computeItems();
  document.getElementById('modeActiveBtn').classList.toggle('active', mode === 'active');
  document.getElementById('modeArchivedBtn').classList.toggle('active', mode === 'archived');
  updateBulkActionButton();
  updateStatusMessage();
  render();
  updateToolbar();
}

function setPageSize(val) {
  PAGE_SIZE = parseInt(val, 10) || 25;
  currentPage = 1;
  render();
}

function toggleAll(val) {
  items.forEach(function(item) {
    if (val && (isLocked(item) || isNew(item))) return; // bulk-select never grabs locked or new items
    val ? selected.add(item.id) : selected.delete(item.id);
  });
  render(); updateToolbar();
}

function togglePage(val) {
  pageItems().forEach(function(item) {
    if (val && (isLocked(item) || isNew(item))) return;
    val ? selected.add(item.id) : selected.delete(item.id);
  });
  render(); updateToolbar();
}

function toggleItem(id) {
  var item = findItem(id);
  if (isLocked(item)) return; // locked items can never be selected, even individually
  selected.has(id) ? selected.delete(id) : selected.add(id);
  updateToolbar();
  var cb = document.querySelector('[data-id="' + id + '"]');
  if (cb) cb.checked = selected.has(id);
}

function goPage(p) { currentPage = p; render(); }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function render() {
  var pg = pageItems();
  var listEl    = document.getElementById('list');
  var pagerWrap = document.getElementById('pagerWrap');
  var pagerEl   = document.getElementById('pager');

  if (!items.length) { listEl.innerHTML = ''; pagerWrap.style.display = 'none'; return; }

  listEl.innerHTML = '<div class="list">' + pg.map(function(item) {
    var status = item.status || 'unknown';
    var locked = isLocked(item);
    var fresh  = isNew(item);
    var rowStyle = ' style="' + (fresh ? 'border-left:3px solid #f59e0b;' : '') + (locked ? 'cursor:default;opacity:0.7;' : '') + '"';
    return '<div class="item"' + rowStyle + (locked ? '' : ' onclick="toggleItem(' + item.id + ')"') + '>' +
      '<input type="checkbox" data-id="' + escHtml(item.id) + '" ' + (selected.has(item.id) ? 'checked' : '') +
        (locked ? ' disabled title="Locked: parent campaign is paused and could resume at any time"' : '') +
        ' onclick="event.stopPropagation();toggleItem(' + item.id + ')">' +
      '<div class="item-info">' +
        '<div class="item-name"><a href="https://app.optimizely.com/v2/projects/' + escHtml(projectId) + '/experiments/' + escHtml(item.id) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:inherit;text-decoration:none;border-bottom:1px solid #d0d0d0;">' + escHtml(item.name || 'Untitled') + '</a>' +
          (locked ? ' <span title="Campaign can resume at any time" style="font-size:11px;color:#92400e;">&#128274; locked</span>' : '') +
          (fresh ? ' <span title="Created within the last ' + NEW_DAYS + ' days" style="font-size:11px;color:#b45309;font-weight:600;">NEW</span>' : '') +
        '</div>' +
        '<div class="item-meta">ID: ' + escHtml(item.id) + (item.last_modified ? ' &nbsp;·&nbsp; Modified: ' + new Date(item.last_modified).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '') + '</div>' +
      '</div>' +
      '<span class="badge badge-' + escHtml(status) + '">' + escHtml(status) + '</span>' +
    '</div>';
  }).join('') + '</div>';

  var total = pageCount();
  if (total <= 1) { pagerWrap.style.display = 'none'; return; }

  var pages = [];
  for (var i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= currentPage - 2 && i <= currentPage + 2)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  var html = '<button class="pg" onclick="goPage(' + Math.max(1, currentPage - 1) + ')"' + (currentPage === 1 ? ' disabled' : '') + '>&lsaquo;</button>';
  pages.forEach(function(p) {
    if (p === '...') {
      html += '<span style="padding:0 4px;line-height:30px;color:#999;">…</span>';
    } else {
      html += '<button class="pg' + (p === currentPage ? ' active' : '') + '" onclick="goPage(' + p + ')">' + p + '</button>';
    }
  });
  html += '<button class="pg" onclick="goPage(' + Math.min(total, currentPage + 1) + ')"' + (currentPage === total ? ' disabled' : '') + '>&rsaquo;</button>';
  html += '<span class="pager-info">' + ((currentPage - 1) * PAGE_SIZE + 1) + '-' + Math.min(currentPage * PAGE_SIZE, items.length) + ' of ' + items.length + '</span>';
  pagerWrap.style.display = 'block';
  pagerEl.innerHTML = html;
}

function apiHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function fetchOptimizations() {
  var token     = document.getElementById('token').value.trim();
  projectId = document.getElementById('project').value.trim();
  if (!token || !projectId) { setStatus('Enter a token and project ID.', 'err'); return; }

  // Persist project ID for next visit
  localStorage.setItem('optimizely_project_id', projectId);

  setStatus('Fetching...');
  document.getElementById('fetchBtn').disabled = true;
  document.getElementById('toolbar').style.display = 'none';
  items = []; selected.clear(); currentPage = 1;
  render();

  try {
    var page = 1, all = [];
    while (true) {
      var url = '/api/v2/experiments?project_id=' + projectId + '&per_page=100&page=' + page;
      logReq('GET', url);
      var res  = await fetch(url, { headers: apiHeaders(token) });
      var text = await res.text();
      logRes(res.status, text.slice(0, 120) + (text.length > 120 ? '...' : ''));
      if (!res.ok) throw new Error('API error ' + res.status + ': ' + text);
      var data = JSON.parse(text);
      if (!data.length) { logInfo('No more results'); break; }
      all = all.concat(data);
      logInfo(data.length + ' records on page ' + page + ' (total: ' + all.length + ')');
      if (data.length < 100) break;
      page++;
    }
    allItems = all;
    viewMode = 'active';
    document.getElementById('modeActiveBtn').classList.add('active');
    document.getElementById('modeArchivedBtn').classList.remove('active');
    updateBulkActionButton();
    items = computeItems();
    var hidden = allItems.length - items.length;
    logInfo(items.length + ' shown, ' + hidden + ' filtered out');
    updateStatusMessage();
    if (allItems.length) {
      document.getElementById('toolbar').style.display = 'flex';
      document.getElementById('viewToggle').style.display = 'flex';
    }
    render();
  } catch(e) {
    logErr(e.message);
    setStatus(e.message, 'err');
  }
  document.getElementById('fetchBtn').disabled = false;
}

var BULK_ACTIONS = {
  archive: {
    method: 'DELETE',
    url: function(id) { return '/api/v2/experiments/' + id; },
    body: null,
    progressVerb: 'Archiving',
    doneVerb: 'archived',
    newStatus: 'archived'
  },
  unarchive: {
    method: 'PATCH',
    url: function(id) { return '/api/v2/experiments/' + id + '?action=unarchive'; },
    body: '{}',
    progressVerb: 'Unarchiving',
    doneVerb: 'unarchived',
    newStatus: 'paused' // action=unarchive always lands the experiment back in "paused"
  }
};

async function bulkAction() {
  var kind  = viewMode === 'archived' ? 'unarchive' : 'archive';
  var cfg   = BULK_ACTIONS[kind];
  var token = document.getElementById('token').value.trim();
  var ids   = Array.from(selected);
  if (!ids.length) return;

  if (kind === 'archive') {
    // Belt-and-suspenders: strip out anything locked that shouldn't be in `selected` in the
    // first place (e.g. its status changed after fetch but before you clicked archive).
    var lockedIds = ids.filter(function(id) { return isLocked(findItem(id)); });
    if (lockedIds.length) {
      ids = ids.filter(function(id) { return lockedIds.indexOf(id) === -1; });
      lockedIds.forEach(function(id) { selected.delete(id); });
      logInfo(lockedIds.length + ' locked item(s) removed from selection automatically');
    }
    if (!ids.length) { render(); updateToolbar(); return; }
  }

  var confirmMsg = (kind === 'archive' ? 'Archive' : 'Unarchive') + ' ' + ids.length +
    ' experiment' + (ids.length === 1 ? '' : 's') + '?';
  if (kind === 'archive') {
    var newOnes = ids.map(findItem).filter(isNew);
    if (newOnes.length) {
      confirmMsg += '\n\nWarning: ' + newOnes.length + ' of these were created within the last ' +
        NEW_DAYS + ' days:\n' + newOnes.map(function(i) { return '  - ' + (i.name || i.id); }).join('\n') +
        '\n\nArchiving is not immediately reversible from this tool. Continue?';
    }
  }
  if (!confirm(confirmMsg)) return;

  document.getElementById('bulkActionBtn').disabled = true;
  document.getElementById('fetchBtn').disabled = true;
  var prog = document.getElementById('progress');
  prog.style.display = 'block';
  setStatus('');

  var done = 0, failed = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    prog.textContent = cfg.progressVerb + '... ' + done + ' / ' + ids.length;
    var url = cfg.url(id);
    logReq(cfg.method, url);
    try {
      var opts = { method: cfg.method, headers: apiHeaders(token) };
      if (cfg.body !== null) opts.body = cfg.body;
      var res  = await fetch(url, opts);
      var text = await res.text();
      logRes(res.status, text.slice(0, 120) + (text.length > 120 ? '...' : ''));
      if (kind === 'archive' && res.status === 410) { logInfo(id + ' was already archived'); }
      else if (!res.ok) throw new Error(res.status + ': ' + text);
      var item = findItem(id);
      if (item) item.status = cfg.newStatus;
      selected.delete(id);
      done++;
    } catch(e) {
      logErr('Failed ' + id + ': ' + e.message);
      failed.push(id);
      done++;
    }
  }

  items = computeItems();

  prog.style.display = 'none';
  if (currentPage > pageCount()) currentPage = Math.max(1, pageCount());

  if (failed.length) {
    setStatus((done - failed.length) + ' ' + cfg.doneVerb + '. Failed IDs: ' + failed.join(', '), 'err');
  } else {
    setStatus(done + ' experiment' + (done === 1 ? '' : 's') + ' ' + cfg.doneVerb + '.', 'ok');
  }

  updateToolbar();
  render();
  document.getElementById('fetchBtn').disabled = false;
}
