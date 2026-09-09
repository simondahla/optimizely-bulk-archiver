var PAGE_SIZE = 25;
var items = [];
var allItems = []; // everything fetched for the current entity, unfiltered - lets the Active/Archived toggle re-filter without another API call
var viewMode = 'active'; // 'active' | 'archived' - drives both the list filter and which bulk action (archive vs unarchive) is wired up
var entity = 'experiments'; // 'experiments' | 'pages' | 'events' - key into ENTITIES
var selected = new Set();
var currentPage = 1;
var projectId = '';
var sortKey = 'last_modified:desc'; // field:direction — see setSort()
var filterText = '';   // live name search
var filterStatus = ''; // status/type dropdown
var lastFailed = [];   // ids from the previous bulk run that errored, for "Retry failed"

// Raw API results per entity, so switching tabs doesn't refetch. Cleared when the project ID changes.
var cache = {};
var cacheProject = '';
// id -> [experiment names] for pages and events still referenced by a non-archived experiment.
var usage = { pages: {}, events: {} };

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
// Safety: items created within this window are flagged "new" and excluded from
// "Select page" / "Select all" so a fresh one never gets swept up by accident. They can
// still be archived individually if you deliberately check their box.
var NEW_DAYS = 14;

// How many archive/unarchive requests are in flight at once, and how hard we retry.
// The Optimizely REST API returns 429 with rate-limit headers; a 429 pauses every worker,
// not just the one that hit it, so a retry doesn't immediately re-trigger the limit.
var CONCURRENCY = 4;
var MAX_RETRIES = 4;
var rateLimitUntil = 0;

// ---------------------------------------------------------------------------
// Entity registry
//
// Everything that differs between experiments, pages and events lives here: the
// list endpoint, the archive/unarchive requests, the status vocabulary, the row
// metadata and the user-facing nouns. The list, filter, sort, pager, selection
// and bulk machinery below is entity-agnostic and reads from cfg().
//
// Note the shape difference: experiments carry a `status` enum, pages and events
// carry an `archived` boolean. And an event's archive URL depends on the event —
// custom events hang off the project, click events off their parent page — so the
// url/body builders take the whole item, not just an id.
// ---------------------------------------------------------------------------

function eventUrl(item) {
  // Custom events are project-scoped; click (in-page) events live under their page.
  if (item.event_type === 'custom' || !item.page_id) {
    return '/api/v2/projects/' + projectId + '/custom_events/' + item.id;
  }
  return '/api/v2/pages/' + item.page_id + '/events/' + item.id;
}

// Locks anything a non-archived experiment still points at. Archiving a page a live
// test targets, or an event it measures, silently breaks that test.
function usageLock(kind) {
  return function(item) {
    var names = usage[kind][item.id];
    if (!names || !names.length) return null;
    return {
      label: 'in use',
      title: 'In use by ' + names.length + ' experiment' + (names.length === 1 ? '' : 's') + ': ' +
             names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '')
    };
  };
}

function dateStr(v) {
  return new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

var ENTITIES = {
  experiments: {
    label: 'Experiments',
    singular: 'experiment',
    plural: 'experiments',
    listPath: function() { return '/api/v2/experiments?project_id=' + projectId; },
    isCandidate: function(i) { return INCLUDE_TYPES.indexOf(i.type || 'a/b') !== -1; },
    isArchived: function(i) { return i.status === 'archived'; },
    isActive: function(i) { return EXCLUDE.indexOf(i.status) === -1; },
    hiddenNote: 'archived/concluded/running/non-A-B hidden',
    filterField: 'status',
    filterInArchived: false,
    statusFilters: [['', 'All statuses'], ['paused', 'Paused'], ['not_started', 'Not started'], ['campaign_paused', 'Campaign paused']],
    badge: function(i) { return i.status || 'unknown'; },
    lock: function(i) {
      return LOCKED_STATUSES.indexOf(i.status) !== -1
        ? { label: 'locked', title: 'Locked: parent campaign is paused and could resume at any time' }
        : null;
    },
    deepLink: function(i) { return 'https://app.optimizely.com/v2/projects/' + projectId + '/experiments/' + i.id; },
    meta: function(i) { return i.variations ? ['Variants: ' + i.variations.length] : []; },
    archive: {
      method: 'DELETE',
      url: function(i) { return '/api/v2/experiments/' + i.id; },
      body: null,
      apply: function(i) { i.status = 'archived'; }
    },
    unarchive: {
      method: 'PATCH',
      url: function(i) { return '/api/v2/experiments/' + i.id + '?action=unarchive'; },
      body: function() { return '{}'; },
      apply: function(i) { i.status = 'paused'; } // action=unarchive always lands the experiment back in "paused"
    }
  },

  pages: {
    label: 'Pages',
    singular: 'page',
    plural: 'pages',
    listPath: function() { return '/api/v2/pages?project_id=' + projectId; },
    isCandidate: function() { return true; },
    isArchived: function(i) { return i.archived === true; },
    isActive: function(i) { return i.archived !== true; },
    hiddenNote: 'archived hidden',
    filterField: 'page_type',
    filterInArchived: true,
    statusFilters: [['', 'All page types'], ['single_url', 'Single URL'], ['url_set', 'URL set'], ['global', 'Global']],
    badge: function(i) { return i.archived ? 'archived' : 'active'; },
    lock: usageLock('pages'),
    deepLink: function(i) { return 'https://app.optimizely.com/v2/projects/' + projectId + '/implementation/pages/' + i.id; },
    meta: function(i) {
      var m = [];
      if (i.page_type) m.push('Type: ' + i.page_type);
      if (i.category && i.category !== 'other') m.push('Category: ' + i.category);
      if (i.edit_url) m.push(i.edit_url);
      return m;
    },
    // PATCH {"archived": true} rather than DELETE: DELETE on a page is documented as a
    // delete, and this tool only ever promises an archive you can undo.
    archive: {
      method: 'PATCH',
      url: function(i) { return '/api/v2/pages/' + i.id; },
      body: function() { return '{"archived":true}'; },
      apply: function(i) { i.archived = true; }
    },
    unarchive: {
      method: 'PATCH',
      url: function(i) { return '/api/v2/pages/' + i.id; },
      body: function() { return '{"archived":false}'; },
      apply: function(i) { i.archived = false; }
    }
  },

  events: {
    label: 'Events',
    singular: 'event',
    plural: 'events',
    listPath: function() { return '/api/v2/events?project_id=' + projectId + '&include_classic=false'; },
    // Pageview events *are* pages in Optimizely. Showing them here too would list the
    // same object twice and make "archive" mean something different depending on the tab.
    isCandidate: function(i) { return i.event_type !== 'pageview'; },
    isArchived: function(i) { return i.archived === true; },
    isActive: function(i) { return i.archived !== true; },
    hiddenNote: 'archived and pageview events hidden — pageview events are Pages',
    filterField: 'event_type',
    filterInArchived: true,
    statusFilters: [['', 'All event types'], ['click', 'Click'], ['custom', 'Custom']],
    badge: function(i) { return i.archived ? 'archived' : (i.event_type || 'unknown'); },
    lock: usageLock('events'),
    deepLink: function() { return 'https://app.optimizely.com/v2/projects/' + projectId + '/implementation/events'; },
    meta: function(i) {
      var m = [];
      if (i.event_type) m.push('Type: ' + i.event_type);
      if (i.page_id) m.push('Page: ' + i.page_id);
      if (i.key) m.push('Key: ' + i.key);
      return m;
    },
    archive: {
      method: 'DELETE',
      url: eventUrl,
      body: null,
      apply: function(i) { i.archived = true; }
    },
    unarchive: {
      method: 'PATCH',
      url: eventUrl,
      body: function() { return '{"archived":false}'; },
      apply: function(i) { i.archived = false; }
    }
  }
};

function cfg() { return ENTITIES[entity]; }

// Restore project ID from localStorage on load
document.addEventListener('DOMContentLoaded', function() {
  var savedProject = localStorage.getItem('optimizely_project_id');
  if (savedProject) document.getElementById('project').value = savedProject;

  document.getElementById('project').addEventListener('change', function() {
    localStorage.setItem('optimizely_project_id', this.value.trim());
  });

  renderStatusFilter();
});

function findItem(id) { return items.find(function(i) { return i.id === id; }); }

// Locks apply to archiving only; the archived view is where you undo, so nothing is locked there.
function lockOf(item) { return item && viewMode === 'active' ? cfg().lock(item) : null; }
function isLocked(item) { return !!lockOf(item); }

function isNew(item) {
  if (!item || !item.created) return false;
  var ageMs = Date.now() - new Date(item.created).getTime();
  return ageMs < NEW_DAYS * 24 * 60 * 60 * 1000;
}

// Re-derives `items` from the already-fetched `allItems` for the current viewMode,
// then applies the active text/status filters and sort. No extra API call needed.
function computeItems() {
  var c = cfg();
  var text = filterText.toLowerCase();
  var parts = sortKey.split(':');
  var sortField = parts[0], sortDir = parts[1];
  return allItems.filter(function(e) {
    if (!c.isCandidate(e)) return false;
    if (viewMode === 'archived' ? !c.isArchived(e) : !c.isActive(e)) return false;
    if (text && (e.name || '').toLowerCase().indexOf(text) === -1) return false;
    if (filterStatus && (viewMode !== 'archived' || c.filterInArchived) && e[c.filterField] !== filterStatus) return false;
    return true;
  }).sort(function(a, b) {
    var va, vb;
    if (sortField === 'name') {
      va = (a.name || '').toLowerCase();
      vb = (b.name || '').toLowerCase();
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = new Date(a[sortField] || 0).getTime();
    vb = new Date(b[sortField] || 0).getTime();
    return sortDir === 'asc' ? va - vb : vb - va;
  });
}

function setSort(val) {
  sortKey = val;
  currentPage = 1;
  items = computeItems();
  render();
}

function setFilterText(val) {
  filterText = val.trim();
  currentPage = 1;
  items = computeItems();
  render();
  updateToolbar();
}

function setFilterStatus(val) {
  filterStatus = val;
  currentPage = 1;
  items = computeItems();
  render();
  updateToolbar();
}

function renderStatusFilter() {
  var sel = document.getElementById('statusFilter');
  sel.innerHTML = cfg().statusFilters.map(function(o) {
    return '<option value="' + escHtml(o[0]) + '">' + escHtml(o[1]) + '</option>';
  }).join('');
  sel.value = filterStatus;
}

function updateStatusMessage() {
  var c = cfg();
  var baseCount = allItems.filter(function(e) {
    if (!c.isCandidate(e)) return false;
    return viewMode === 'archived' ? c.isArchived(e) : c.isActive(e);
  }).length;
  var prefix = items.length !== baseCount ? items.length + ' of ' + baseCount : '' + items.length;
  var noun = c.singular + (items.length === 1 ? '' : 's');
  if (viewMode === 'archived') {
    setStatus(prefix + ' archived ' + noun + ' found.', 'ok');
  } else {
    var hidden = allItems.length - baseCount;
    setStatus(prefix + ' active ' + noun + ' found' + (hidden ? ' (' + hidden + ' ' + c.hiddenNote + ')' : '') + '.', 'ok');
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

function trunc(text) { return text.slice(0, 120) + (text.length > 120 ? '...' : ''); }

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

function showRetryButton(show) {
  document.getElementById('retryBtn').style.display = show ? '' : 'none';
}

// Swaps the whole tab over: different endpoint, different vocabulary, different
// safety rules. Results already fetched for a tab are reused rather than refetched.
function setEntity(name) {
  if (name === entity || !ENTITIES[name]) return;
  entity = name;
  selected.clear();
  currentPage = 1;
  viewMode = 'active';
  filterText = ''; filterStatus = ''; sortKey = 'last_modified:desc';
  lastFailed = [];
  showRetryButton(false);
  document.getElementById('searchInput').value = '';
  document.getElementById('sortSelect').value = 'last_modified:desc';
  renderStatusFilter();
  document.getElementById('statusFilter').style.display = '';
  document.getElementById('modeActiveBtn').classList.add('active');
  document.getElementById('modeArchivedBtn').classList.remove('active');
  Object.keys(ENTITIES).forEach(function(k) {
    document.getElementById('tab-' + k).classList.toggle('active', k === entity);
  });
  updateBulkActionButton();

  allItems = cache[entity] || [];
  items = computeItems();
  var loaded = !!cache[entity];
  ['toolbar', 'viewToggle', 'filterBar'].forEach(function(id) {
    document.getElementById(id).style.display = loaded ? 'flex' : 'none';
  });
  if (loaded) updateStatusMessage();
  else setStatus('Click Fetch to load ' + cfg().plural + '.');
  render();
  updateToolbar();
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  selected.clear();
  currentPage = 1;
  filterStatus = '';
  document.getElementById('statusFilter').value = '';
  document.getElementById('statusFilter').style.display = (mode === 'archived' && !cfg().filterInArchived) ? 'none' : '';
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
  var c = cfg();
  var pg = pageItems();
  var listEl    = document.getElementById('list');
  var pagerWrap = document.getElementById('pagerWrap');
  var pagerEl   = document.getElementById('pager');

  if (!items.length) { listEl.innerHTML = ''; pagerWrap.style.display = 'none'; return; }

  listEl.innerHTML = '<div class="list">' + pg.map(function(item) {
    var status = c.badge(item);
    var lock   = lockOf(item);
    var fresh  = isNew(item);
    var meta   = ['ID: ' + escHtml(item.id)].concat(c.meta(item).map(escHtml));
    if (item.created)       meta.push('Created: ' + dateStr(item.created));
    if (item.last_modified) meta.push('Modified: ' + dateStr(item.last_modified));
    var rowStyle = ' style="' + (fresh ? 'border-left:3px solid #f59e0b;' : '') + (lock ? 'cursor:default;opacity:0.7;' : '') + '"';
    return '<div class="item"' + rowStyle + (lock ? '' : ' onclick="toggleItem(' + item.id + ')"') + '>' +
      '<input type="checkbox" data-id="' + escHtml(item.id) + '" ' + (selected.has(item.id) ? 'checked' : '') +
        (lock ? ' disabled title="' + escHtml(lock.title) + '"' : '') +
        ' onclick="event.stopPropagation();toggleItem(' + item.id + ')">' +
      '<div class="item-info">' +
        '<div class="item-name"><a href="' + escHtml(c.deepLink(item)) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:inherit;text-decoration:none;border-bottom:1px solid #d0d0d0;">' + escHtml(item.name || 'Untitled') + '</a>' +
          (lock ? ' <span class="lock-tag" title="' + escHtml(lock.title) + '">&#128274; ' + escHtml(lock.label) + '</span>' : '') +
          (fresh ? ' <span class="new-tag" title="Created within the last ' + NEW_DAYS + ' days">NEW</span>' : '') +
        '</div>' +
        '<div class="item-meta">' + meta.join(' &nbsp;·&nbsp; ') + '</div>' +
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

// ---------------------------------------------------------------------------
// Request plumbing: retry + rate limiting
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

function retryDelay(res, attempt) {
  var after = res.headers.get('Retry-After');
  if (after) {
    var secs = parseInt(after, 10);
    if (!isNaN(secs)) return Math.min(secs * 1000, 60000);
  }
  var reset = res.headers.get('X-RateLimit-Reset');
  if (reset) {
    var stamp = parseInt(reset, 10);
    if (!isNaN(stamp)) {
      var ms = (stamp > 1e10 ? stamp : stamp * 1000) - Date.now(); // header is seconds or ms since epoch
      if (ms > 0) return Math.min(ms, 60000);
    }
  }
  return Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
}

// Retries 429s and 5xxs; anything else is returned to the caller as-is. A 429 sets a
// shared deadline so every in-flight worker backs off together rather than piling on.
async function requestWithRetry(url, opts) {
  var attempt = 0;
  while (true) {
    var wait = rateLimitUntil - Date.now();
    if (wait > 0) await sleep(wait);
    var res = await fetch(url, opts);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      var delay = retryDelay(res, attempt);
      if (res.status === 429) rateLimitUntil = Date.now() + delay;
      logInfo('HTTP ' + res.status + ' on ' + url + ' - retrying in ' + Math.round(delay / 1000) + 's (' + (attempt + 1) + '/' + MAX_RETRIES + ')');
      await sleep(delay);
      attempt++;
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchAll(path, token) {
  var page = 1, all = [];
  var sep = path.indexOf('?') === -1 ? '?' : '&';
  while (true) {
    var url = path + sep + 'per_page=100&page=' + page;
    logReq('GET', url);
    var res  = await requestWithRetry(url, { headers: apiHeaders(token) });
    var text = await res.text();
    logRes(res.status, trunc(text));
    if (!res.ok) throw new Error('API error ' + res.status + ': ' + text);
    var data = JSON.parse(text);
    if (!data.length) { logInfo('No more results'); break; }
    all = all.concat(data);
    logInfo(data.length + ' records on page ' + page + ' (total: ' + all.length + ')');
    if (data.length < 100) break;
    page++;
  }
  return all;
}

// A page or event is unsafe to archive while any non-archived experiment still points
// at it. Build the id -> experiment-names index once per project.
function buildUsage(experiments) {
  var u = { pages: {}, events: {} };
  function add(bucket, id, name) {
    if (!id) return;
    var list = bucket[id] || (bucket[id] = []);
    if (list.indexOf(name) === -1) list.push(name);
  }
  experiments.forEach(function(e) {
    if (e.status === 'archived') return;
    var name = e.name || ('Experiment ' + e.id);
    (e.page_ids || []).forEach(function(pid) { add(u.pages, pid, name); });
    (e.changes || []).forEach(function(ch) { add(u.pages, ch.page_id, name); });
    (e.variations || []).forEach(function(v) {
      (v.actions || []).forEach(function(a) { add(u.pages, a.page_id, name); });
    });
    (e.metrics || []).forEach(function(m) { add(u.events, m.event_id, name); });
  });
  return u;
}

async function fetchOptimizations() {
  var token     = document.getElementById('token').value.trim();
  projectId = document.getElementById('project').value.trim();
  if (!token || !projectId) { setStatus('Enter a token and project ID.', 'err'); return; }

  // Persist project ID for next visit
  localStorage.setItem('optimizely_project_id', projectId);
  if (projectId !== cacheProject) { cache = {}; usage = { pages: {}, events: {} }; cacheProject = projectId; }

  setStatus('Fetching...');
  document.getElementById('fetchBtn').disabled = true;
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('filterBar').style.display = 'none';
  filterText = ''; filterStatus = ''; sortKey = 'last_modified:desc';
  lastFailed = []; showRetryButton(false);
  document.getElementById('searchInput').value = '';
  renderStatusFilter();
  document.getElementById('sortSelect').value = 'last_modified:desc';
  items = []; selected.clear(); currentPage = 1;
  render();

  try {
    var all = await fetchAll(cfg().listPath(), token);
    cache[entity] = all;
    allItems = all;

    // Pages and events need the experiment list too, to know what's still wired up.
    if (entity !== 'experiments') {
      if (!cache.experiments) {
        logInfo('Cross-referencing experiments for the in-use lock...');
        cache.experiments = await fetchAll('/api/v2/experiments?project_id=' + projectId, token);
      }
      usage = buildUsage(cache.experiments);
      logInfo(Object.keys(usage.pages).length + ' page(s) and ' + Object.keys(usage.events).length +
              ' event(s) are referenced by non-archived experiments and will be locked');
    }

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
      document.getElementById('filterBar').style.display = 'flex';
      document.getElementById('statusFilter').style.display = '';
    }
    render();
  } catch(e) {
    logErr(e.message);
    setStatus(e.message, 'err');
  }
  document.getElementById('fetchBtn').disabled = false;
}

// ---------------------------------------------------------------------------
// Bulk archive / unarchive
// ---------------------------------------------------------------------------

// Runs `action` over every id with CONCURRENCY requests in flight. Workers share one
// cursor, so a slow request doesn't stall the others.
async function runBulk(ids, action, kind, onProgress) {
  var next = 0, done = 0, failed = [];

  async function worker() {
    while (true) {
      var i = next++;
      if (i >= ids.length) return;
      var id   = ids[i];
      var item = findItem(id);
      if (!item) { failed.push(id); done++; onProgress(done, failed.length); continue; }
      var url = action.url(item);
      logReq(action.method, url);
      try {
        var opts = { method: action.method, headers: apiHeaders(document.getElementById('token').value.trim()) };
        if (action.body) opts.body = action.body(item);
        var res  = await requestWithRetry(url, opts);
        var text = await res.text();
        logRes(res.status, trunc(text));
        if (kind === 'archive' && res.status === 410) { logInfo(id + ' was already archived'); }
        else if (!res.ok) throw new Error(res.status + ': ' + text);
        action.apply(item);
        selected.delete(id);
      } catch(e) {
        logErr('Failed ' + id + ': ' + e.message);
        failed.push(id);
      }
      done++;
      onProgress(done, failed.length);
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(CONCURRENCY, ids.length); w++) workers.push(worker());
  await Promise.all(workers);
  return failed;
}

function retryFailed() { bulkAction(lastFailed.slice()); }

async function bulkAction(retryIds) {
  var c      = cfg();
  var kind   = viewMode === 'archived' ? 'unarchive' : 'archive';
  var action = c[kind];
  var ids    = retryIds || Array.from(selected);
  if (!ids.length) return;

  if (kind === 'archive') {
    // Belt-and-suspenders: strip out anything locked that shouldn't be in `selected` in the
    // first place (e.g. an experiment started using it after the fetch).
    var lockedIds = ids.filter(function(id) { return isLocked(findItem(id)); });
    if (lockedIds.length) {
      ids = ids.filter(function(id) { return lockedIds.indexOf(id) === -1; });
      lockedIds.forEach(function(id) { selected.delete(id); });
      logInfo(lockedIds.length + ' locked item(s) removed from selection automatically');
    }
    if (!ids.length) { render(); updateToolbar(); return; }
  }

  var noun = c.singular + (ids.length === 1 ? '' : 's');
  var confirmMsg = (kind === 'archive' ? 'Archive' : 'Unarchive') + ' ' + ids.length + ' ' + noun + '?';
  if (kind === 'archive') {
    if (entity === 'pages') {
      confirmMsg += '\n\nArchiving a page also stops the click events attached to it from being collected.';
    }
    var newOnes = ids.map(findItem).filter(isNew);
    if (newOnes.length) {
      confirmMsg += '\n\nWarning: ' + newOnes.length + ' of these were created within the last ' +
        NEW_DAYS + ' days:\n' + newOnes.map(function(i) { return '  - ' + (i.name || i.id); }).join('\n');
    }
    confirmMsg += '\n\nContinue?';
  }
  if (!confirm(confirmMsg)) return;

  document.getElementById('bulkActionBtn').disabled = true;
  document.getElementById('fetchBtn').disabled = true;
  showRetryButton(false);
  var prog = document.getElementById('progress');
  prog.style.display = 'block';
  setStatus('');
  rateLimitUntil = 0;

  var verb = kind === 'archive' ? 'Archiving' : 'Unarchiving';
  function onProgress(done, failedCount) {
    prog.textContent = verb + '... ' + done + ' / ' + ids.length + (failedCount ? ' (' + failedCount + ' failed)' : '');
  }
  onProgress(0, 0);

  var failed = await runBulk(ids, action, kind, onProgress);

  items = computeItems();
  prog.style.display = 'none';
  if (currentPage > pageCount()) currentPage = Math.max(1, pageCount());

  var succeeded = ids.length - failed.length;
  lastFailed = failed;
  showRetryButton(failed.length > 0);
  var doneVerb = kind === 'archive' ? 'archived' : 'unarchived';
  if (failed.length) {
    setStatus(succeeded + ' ' + doneVerb + ', ' + failed.length + ' failed: ' + failed.join(', '), 'err');
  } else {
    setStatus(succeeded + ' ' + c.singular + (succeeded === 1 ? '' : 's') + ' ' + doneVerb + '.', 'ok');
  }

  updateToolbar();
  render();
  document.getElementById('fetchBtn').disabled = false;
}
