/* My AI Drive — frontend (vanilla JS, no build step) */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('aidrive.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aidrive.' + k, JSON.stringify(v)); } catch { } },
};

async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && !(o.body instanceof FormData) && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch { }
    throw new Error(msg);
  }
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

function toast(msg, err = false, ms = 3800) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
const fail = e => toast(e.message || String(e), true, 6000);

function authorsShort(a) {
  if (!a || !a.length) return 'Unknown authors';
  const last = n => n.split(/\s+/).slice(-1)[0];
  return a.length === 1 ? last(a[0]) : a.length === 2 ? `${last(a[0])} & ${last(a[1])}` : `${last(a[0])} et al.`;
}
function ago(ts) {
  const d = (Date.now() / 1000 - ts);
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago'; if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
  return new Date(ts * 1000).toLocaleDateString();
}

// Small modal replacements for prompt()/confirm() (native dialogs block the page).
function modal({ title, value = null, ok = 'OK', danger = false, body = '' }) {
  return new Promise(res => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:grid;place-items:center;z-index:90';
    wrap.innerHTML = `<div class="card" style="width:min(440px,92vw);box-shadow:var(--shadow)">
      <h3>${esc(title)}</h3>${body ? `<p class="muted small">${body}</p>` : ''}
      ${value !== null ? `<input class="inp" style="width:100%;margin:8px 0" value="${esc(value)}">` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div></div>`;
    document.body.append(wrap);
    const inp = $('input', wrap);
    const done = v => { wrap.remove(); res(v); };
    $('[data-x]', wrap).onclick = () => done(null);
    $('[data-ok]', wrap).onclick = () => done(inp ? inp.value : true);
    wrap.onclick = e => { if (e.target === wrap) done(null); };
    wrap.onkeydown = e => { if (e.key === 'Enter') done(inp ? inp.value : true); if (e.key === 'Escape') done(null); };
    (inp || $('[data-ok]', wrap)).focus(); inp?.select();
  });
}

function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<div data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</div>`).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = e => { const i = e.target.dataset.i; if (i != null) { m.hidden = true; items[i].fn(); } };
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });

// ---------- markdown + citations ----------
const CITE_RE = /\[@([0-9a-f]{6,16})((?:[\s,;]*(?:pp?\.?|page)\s*\d+(?:\s*[-–]\s*\d+)?)?)\]/gi;
function citeLabel(id) {
  const p = S.index.get(id);
  return p ? `${authorsShort(p.authors)}${p.year ? ' ' + p.year : ''}` : id.slice(0, 5);
}
function renderMD(text) {
  const withCites = (text || '').replace(CITE_RE, (m, id, pg) => {
    const n = (pg.match(/\d+/) || [])[0] || '';
    const p = S.index.get(id);
    return `<a class="cite" data-pid="${id}" data-page="${n}" title="${esc(p ? p.title : 'Paper ' + id)}${n ? ' — page ' + n : ''}">${esc(citeLabel(id))}${n ? ' · p.' + n : ''}</a>`;
  });
  return DOMPurify.sanitize(marked.parse(withCites, { breaks: false, gfm: true }));
}
document.addEventListener('click', e => {
  const c = e.target.closest('a.cite');
  if (c) { e.preventDefault(); openPaper(c.dataset.pid, { page: +c.dataset.page || null, tab: 'read' }); }
});

// ---------- global state ----------
const S = {
  view: store.get('view', 'library'),     // library | discover | team | chat | chats | notes | note | vocab | jobs | plan | settings
  libView: store.get('libView', 'all'),   // all | starred | unread | nopdf
  folder: store.get('folder', null),
  sort: store.get('sort', 'added'),
  q: '',
  papers: [],
  index: new Map(),                        // id → paper (all papers, for citation labels)
  selected: new Set(),
  lastClicked: null,
  current: store.get('current', null),     // paper open in preview
  pvTab: store.get('pvTab', 'read'),
  readChat: store.get('readChat', false),  // chat column next to the PDF in the Read tab
  chatId: store.get('chatId', null),
  noteId: null,
  app: { folders: [], counts: {}, agent: {}, nus: {} },
  settings: {},
  chats: [],
  jobs: [],
  discover: store.get('discover', { topics: '', per_topic: 15, year_from: '', year_to: '', sort: 'relevance', oa_only: false, use_proxy: true, folder_per_topic: true, folder_base: 'Searches' }),
  discoverResults: null,
  reader: null,
};

// ---------- boot ----------
async function boot() {
  const theme = store.get('theme', 'auto');
  if (theme !== 'auto') document.documentElement.dataset.theme = theme;
  const cw = store.get('readChatW', null);
  if (cw) document.documentElement.style.setProperty('--chat-w', cw + 'px');
  const w = store.get('previewW', null);
  if (w) document.documentElement.style.setProperty('--preview-w', w + 'px');
  S.settings = await api('/api/settings');
  await Promise.all([refreshState(), refreshIndex(), refreshChats()]);
  await loadPapers();
  renderAll();
  if (S.current && S.index.has(S.current)) { openPaper(S.current, { tab: S.pvTab, keepTab: true }); if (store.get('listCollapsed', false)) setListCollapsed(true); }
  else renderPreview();
  pollJobs();
  wireGlobal();
}

async function refreshState() {
  S.app = await api('/api/state');
  renderPills();
}
async function refreshIndex() {
  const all = await api('/api/papers?view=all');
  S.index = new Map(all.map(p => [p.id, p]));
}
async function refreshChats() { S.chats = await api('/api/chats'); }

async function loadPapers() {
  const params = new URLSearchParams({ view: S.libView, sort: S.sort, q: S.q });
  if (S.folder !== null) params.set('folder', S.folder);
  S.papers = await api('/api/papers?' + params);
  const ids = new Set(S.papers.map(p => p.id));
  for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
}

function go(view, extra = {}) {
  Object.assign(S, extra);
  S.view = view; S.review = null;
  setListCollapsed(false);
  store.set('view', view); store.set('libView', S.libView); store.set('folder', S.folder); store.set('chatId', S.chatId);
  if (view === 'library') loadPapers().then(renderAll); else renderAll();
}

function renderAll() { renderSidebar(); renderCenter(); }

function renderPills() {
  const n = $('#nusPill'), a = $('#agentPill');
  const ns = S.app.nus || {};
  n.className = 'pill ' + (ns.logged_in ? 'ok' : ns.browser_open ? 'warn' : '');
  n.textContent = ns.logged_in ? 'NUS · connected' : ns.browser_open ? 'NUS · sign in' : 'NUS · offline';
  n.title = ns.detail || '';
  a.className = 'pill ' + (S.app.agent?.ok ? 'ok' : 'err');
  const viaApi = S.settings.agent_provider && S.settings.agent_provider !== 'claude';
  a.textContent = S.app.agent?.ok ? 'Agent · ' + (viaApi ? S.app.agent.detail.split(' · ')[0] : 'ready') : 'Agent · not set up';
  a.title = S.app.agent?.detail || '';
}

// ---------- sidebar ----------
function renderSidebar() {
  const c = S.app.counts || {};
  const nav = (key, ic, label, cnt, active, attrs = '') =>
    `<div class="nav ${active ? 'active' : ''}" data-nav="${key}" ${attrs}><span class="ic">${ic}</span><span class="lbl">${esc(label)}</span>${cnt != null ? `<span class="cnt">${cnt || 0}</span>` : ''}</div>`;
  const lib = S.view === 'library';
  let h = `<div class="side-h">Library</div>`;
  h += nav('all', '▤', 'All papers', c.total, lib && S.libView === 'all' && S.folder === null, 'data-drop=""');
  h += nav('starred', '★', 'Starred', c.starred, lib && S.libView === 'starred');
  h += nav('unread', '●', 'Unread', c.unread, lib && S.libView === 'unread');
  h += nav('nopdf', '⚠', 'Missing PDF', c.nopdf, lib && S.libView === 'nopdf');
  h += `<div class="side-h">Folders<button class="iconbtn" data-act="newfolder" title="New folder">+</button></div>`;
  if (!S.app.folders.length) h += `<div class="muted small" style="padding:2px 8px">No folders yet</div>`;
  for (const f of S.app.folders) {
    const depth = f.path.split('/').length - 1;
    const name = f.path.split('/').pop();
    h += `<div class="nav ${lib && S.folder === f.path ? 'active' : ''}" data-folder="${esc(f.path)}" data-drop="${esc(f.path)}" style="padding-left:${8 + depth * 14}px">
      <span class="ic">▸</span><span class="lbl" title="${esc(f.path)}">${esc(name)}</span><span class="cnt">${f.count}</span>
      <button class="iconbtn more" data-fmenu="${esc(f.path)}">⋯</button></div>`;
  }
  h += `<div class="side-h">Research</div>`;
  h += nav('discover', '⌕', 'Find papers (NUS)', null, S.view === 'discover');
  const tm = S.app.team || {};
  const teamNew = tm.enabled && tm.latest > store.get('teamSeen', 0);
  h += `<div class="nav ${S.view === 'team' ? 'active' : ''}" data-nav="team"><span class="ic">⇄</span><span class="lbl">Team</span>${teamNew ? '<span class="dot" title="New from your team"></span>' : ''}</div>`;
  h += nav('chats', '✦', 'AI chats', null, S.view === 'chats' || (S.view === 'chat' && false));
  for (const ch of S.chats.slice(0, 6)) {
    h += `<div class="nav ${S.view === 'chat' && S.chatId === ch.id ? 'active' : ''}" data-chat="${ch.id}" style="padding-left:30px"><span class="lbl small">${esc(ch.title)}</span></div>`;
  }
  h += nav('notes', '✎', 'Notes', null, S.view === 'notes' || S.view === 'note');
  const vc = S.app.vocab || {};
  h += `<div class="nav ${S.view === 'vocab' ? 'active' : ''}" data-nav="vocab"><span class="ic" style="font-size:11px">Aa</span><span class="lbl">Vocabulary</span>${vc.due ? `<span class="badge" title="Due for review">${vc.due}</span>` : `<span class="cnt">${vc.total || 0}</span>`}</div>`;
  const running = S.jobs.filter(j => j.status === 'running').length;
  h += `<div class="nav ${S.view === 'jobs' ? 'active' : ''}" data-nav="jobs"><span class="ic">⇩</span><span class="lbl">Jobs</span>${running ? `<span class="badge">${running}</span>` : ''}</div>`;
  h += nav('settings', '⚙', 'Settings', null, S.view === 'settings');
  $('#sidebar').innerHTML = h;
}

$('#sidebar').addEventListener('click', async e => {
  const fm = e.target.closest('[data-fmenu]');
  if (fm) { e.stopPropagation(); return folderMenu(fm.dataset.fmenu, e.clientX, e.clientY); }
  if (e.target.closest('[data-act="newfolder"]')) return newFolder(S.folder || '');
  const f = e.target.closest('[data-folder]');
  if (f) { S.selected.clear(); return go('library', { folder: f.dataset.folder, libView: 'all' }); }
  const ch = e.target.closest('[data-chat]');
  if (ch) return go('chat', { chatId: ch.dataset.chat });
  const n = e.target.closest('[data-nav]');
  if (!n) return;
  const k = n.dataset.nav;
  if (['all', 'starred', 'unread', 'nopdf'].includes(k)) { S.selected.clear(); go('library', { libView: k, folder: null }); }
  else go(k);
});
$('#sidebar').addEventListener('contextmenu', e => {
  const f = e.target.closest('[data-folder]');
  if (f) { e.preventDefault(); folderMenu(f.dataset.folder, e.clientX, e.clientY); }
});
// drag papers onto folders
$('#sidebar').addEventListener('dragover', e => {
  const t = e.target.closest('[data-drop]');
  if (t && e.dataTransfer.types.includes('text/x-paper-ids')) { e.preventDefault(); $$('.droptarget').forEach(x => x.classList.remove('droptarget')); t.classList.add('droptarget'); }
});
$('#sidebar').addEventListener('dragleave', e => e.target.closest('[data-drop]')?.classList.remove('droptarget'));
$('#sidebar').addEventListener('drop', async e => {
  const t = e.target.closest('[data-drop]');
  $$('.droptarget').forEach(x => x.classList.remove('droptarget'));
  const ids = e.dataTransfer.getData('text/x-paper-ids');
  if (!t || !ids) return;
  e.preventDefault();
  await bulk(JSON.parse(ids), 'move', t.dataset.drop);
  toast(`Moved ${JSON.parse(ids).length} paper(s) to ${t.dataset.drop || 'Library root'}`);
});

function folderMenu(path, x, y) {
  showMenu(x, y, [
    { label: '✦ Ask AI about this folder', fn: () => newChat({ type: 'folder', path }) },
    { label: '∑ Summarise papers without summary', fn: () => summarizeIds(papersInFolder(path)) },
    { label: '⌗ Organise into subfolders with AI', fn: () => organizeIds(papersInFolder(path), path) },
    '-',
    { label: 'New subfolder…', fn: () => newFolder(path + '/') },
    { label: 'Rename…', fn: () => renameFolder(path) },
    { label: 'Delete folder (keeps papers)', danger: true, fn: () => deleteFolder(path) },
  ]);
}
function papersInFolder(path) { return [...S.index.values()].filter(p => p.folder === path || p.folder.startsWith(path + '/')).map(p => p.id); }
async function newFolder(prefix) {
  const v = await modal({ title: 'New folder', value: prefix, ok: 'Create', body: 'Use “/” for subfolders, e.g. <i>Thesis/Chapter 2</i>.' });
  if (!v) return;
  try { const r = await api('/api/folders', { method: 'POST', body: { path: v } }); await refreshState(); go('library', { folder: r.path, libView: 'all' }); } catch (e) { fail(e); }
}
async function renameFolder(path) {
  const v = await modal({ title: 'Rename folder', value: path, ok: 'Rename' });
  if (!v || v === path) return;
  try { await api('/api/folders', { method: 'PATCH', body: { old: path, new: v } }); await afterChange(); if (S.folder === path) go('library', { folder: v }); } catch (e) { fail(e); }
}
async function deleteFolder(path) {
  if (!await modal({ title: `Delete folder “${path}”?`, body: 'Papers inside are not deleted; they move to the parent folder.', ok: 'Delete', danger: true })) return;
  try { await api('/api/folders?path=' + encodeURIComponent(path), { method: 'DELETE' }); if (S.folder === path) S.folder = null; await afterChange(); } catch (e) { fail(e); }
}

async function afterChange() {
  await Promise.all([refreshState(), refreshIndex()]);
  if (S.view === 'library') await loadPapers();
  renderAll();
}

// ---------- center: library ----------
function renderCenter() {
  const c = $('#center');
  ({ library: renderLibrary, discover: renderDiscover, team: renderTeam, chat: renderChatView, chats: renderChats, notes: renderNotes, note: renderNote, vocab: renderVocab, jobs: renderJobs, plan: renderPlan, settings: renderSettings }[S.view] || renderLibrary)(c);
}

function libTitle() {
  if (S.q) return `Search: “${S.q}”`;
  if (S.folder !== null) return S.folder;
  return { all: 'All papers', starred: 'Starred', unread: 'Unread', nopdf: 'Missing PDF' }[S.libView];
}

function renderLibrary(c) {
  const sel = S.selected.size;
  const scopeBtn = S.folder !== null ? 'Ask AI about this folder' : 'Ask AI about these papers';
  c.innerHTML = `
    <div class="viewhead">
      <h1>${esc(libTitle())}<span class="sub">${S.papers.length} paper${S.papers.length === 1 ? '' : 's'}</span></h1>
      <select class="sel" id="sortSel" title="Sort">
        ${[['added', 'Recently added'], ['year', 'Year'], ['title', 'Title'], ['cited', 'Most cited'], ['relevance', 'Relevance']].map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      ${S.papers.length ? `<button class="btn" id="orgAllBtn" title="AI sorts these papers into topic folders and tags them">⌗ Organise</button>
      <button class="btn" id="sumAllBtn" title="Summarise every paper here that has no summary yet">∑ Summarise all</button>
      <button class="btn primary" id="askHereBtn">✦ ${scopeBtn}</button>` : ''}
    </div>
    ${sel ? `<div class="selbar"><b>${sel} selected</b>
      <button class="btn sm primary" data-bulk="ask">✦ Ask AI</button>
      <button class="btn sm" data-bulk="summarize">∑ Summarise</button>
      <button class="btn sm" data-bulk="organize" title="AI picks a folder and tags for each paper">⌗ Organise</button>
      <button class="btn sm" data-bulk="move">Move to…</button>
      <button class="btn sm" data-bulk="tag">Tag…</button>
      ${S.app.team?.enabled ? '<button class="btn sm" data-bulk="share">⇄ Share</button>' : ''}
      <button class="btn sm" data-bulk="star">★ Star</button>
      <button class="btn sm" data-bulk="read">Mark read</button>
      <button class="btn sm" data-bulk="retry">⇩ Retry PDF</button>
      <button class="btn sm danger" data-bulk="delete">Delete</button>
      <button class="btn sm ghost" data-bulk="clear">Clear</button></div>` : ''}
    <div class="viewbody" id="plistWrap">${S.papers.length ? `
      <ul class="plist">${S.papers.map(rowHTML).join('')}</ul>` : emptyLibrary()}
    </div>`;
  $('#sortSel').onchange = e => { S.sort = e.target.value; store.set('sort', S.sort); loadPapers().then(renderCenter); };
  const ask = $('#askHereBtn');
  if (ask) ask.onclick = () => newChat(S.folder !== null && !S.q ? { type: 'folder', path: S.folder } : S.libView === 'all' && !S.q ? { type: 'all' } : { type: 'papers', ids: S.papers.map(p => p.id) });
  const org = $('#orgAllBtn');
  if (org) org.onclick = () => organizeIds(S.papers.map(p => p.id), S.folder !== null && !S.q ? S.folder : '');
  const sum = $('#sumAllBtn');
  if (sum) sum.onclick = () => summarizeIds(S.papers.map(p => p.id));
}

function emptyLibrary() {
  if (S.q) return `<div class="empty"><h3>No matches</h3>Nothing in titles, authors, abstracts or full text matches “${esc(S.q)}”.</div>`;
  return `<div class="empty"><h3>${S.folder !== null ? 'This folder is empty' : 'Your library is empty'}</h3>
    Drop PDFs anywhere on this window, or let the agent find papers for you.<br>
    <button class="btn" onclick="$('#fileInput').click()">⤒ Import PDFs</button>
    <button class="btn primary" onclick="go('discover')">⌕ Find papers by topic</button></div>`;
}

function rowHTML(p) {
  const badges = [];
  if (p.has_pdf) badges.push(`<span class="tag">${p.pages || ''}${p.pages ? 'p' : 'PDF'}</span>`);
  else if (p.dl_status === 'failed') badges.push(`<span class="tag err" title="${esc(p.dl_error)}">no PDF</span>`);
  else if (p.dl_status === 'pending' || p.dl_status === 'downloading') badges.push(`<span class="tag warn">${p.dl_status}…</span>`);
  else badges.push(`<span class="tag err">no PDF</span>`);
  if (p.has_summary) badges.push(`<span class="tag ok">summary</span>`);
  if (p.team_key) badges.push(`<span class="tag" title="Shared with your team">⇄ team</span>`);
  for (const t of p.tags.slice(0, 3)) badges.push(`<span class="tag acc">${esc(t)}</span>`);
  const meta = [authorsShort(p.authors), p.year, p.venue].filter(Boolean).join(' · ');
  const folder = S.folder === null && p.folder ? ` · <span title="Folder">▸ ${esc(p.folder)}</span>` : '';
  return `<li class="prow ${p.id === S.current ? 'active' : ''} ${S.selected.has(p.id) ? 'checked' : ''} ${p.read_status === 'unread' ? 'unread' : ''}" data-pid="${p.id}" draggable="true">
    <input type="checkbox" ${S.selected.has(p.id) ? 'checked' : ''} data-check>
    <span class="star ${p.starred ? 'on' : ''}" data-star>★</span>
    <div style="min-width:0"><div class="ptitle">${esc(p.title)}</div><div class="pmeta">${esc(meta)}${folder}</div>
      ${p.snippet ? `<div class="psnip">${DOMPurify.sanitize(p.snippet, { ALLOWED_TAGS: ['mark'] })}</div>` : ''}</div>
    <div class="ptags">${badges.join('')}</div></li>`;
}

$('#center').addEventListener('click', async e => {
  const b = e.target.closest('[data-bulk]');
  if (b) return bulkAction(b.dataset.bulk, e);
  const row = e.target.closest('.prow');
  if (!row) return;
  const id = row.dataset.pid;
  if (e.target.closest('[data-star]')) {
    const p = S.papers.find(x => x.id === id);
    await api('/api/papers/' + id, { method: 'PATCH', body: { starred: p.starred ? 0 : 1 } });
    p.starred = p.starred ? 0 : 1; refreshState().then(renderSidebar); renderCenter(); return;
  }
  if (e.target.closest('[data-check]') || e.metaKey || e.ctrlKey || e.shiftKey) {
    if (e.shiftKey && S.lastClicked) {
      const ids = S.papers.map(p => p.id);
      const [a, z] = [ids.indexOf(S.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
      ids.slice(a, z + 1).forEach(i => S.selected.add(i));
    } else S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    S.lastClicked = id;
    renderCenter(); return;
  }
  S.lastClicked = id;
  // Clicking the paper that's already open folds the list away so the reader and chat get the whole page.
  if (id === S.current && !document.body.classList.contains('nopreview')) return setListCollapsed(true);
  openPaper(id);
});
$('#center').addEventListener('contextmenu', e => {
  const row = e.target.closest('.prow');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.pid;
  const ids = S.selected.has(id) ? [...S.selected] : [id];
  const p = S.index.get(id) || {};
  showMenu(e.clientX, e.clientY, [
    { label: 'Open in reader', fn: () => openPaper(id, { tab: 'read' }) },
    { label: '✦ Ask AI' + (ids.length > 1 ? ` (${ids.length} papers)` : ''), fn: () => newChat({ type: 'papers', ids }) },
    { label: '∑ Summarise', fn: () => summarizeIds(ids, false) },
    { label: '⌗ Organise with AI', fn: () => organizeIds(ids) },
    ...(S.app.team?.enabled ? [{ label: '⇄ Share with team', fn: () => shareIds(ids) }] : []),
    '-',
    { label: 'Move to…', fn: () => moveMenu(ids, e.clientX, e.clientY) },
    { label: p.starred ? 'Unstar' : 'Star', fn: () => bulk(ids, 'star', !p.starred) },
    { label: 'Mark as read', fn: () => bulk(ids, 'status', 'read') },
    { label: 'Mark as unread', fn: () => bulk(ids, 'status', 'unread') },
    { label: '⇩ Retry PDF download', fn: () => retryIds(ids) },
    '-',
    { label: 'Delete', danger: true, fn: () => deleteIds(ids) },
  ]);
});
$('#center').addEventListener('dragstart', e => {
  const row = e.target.closest('.prow');
  if (!row) return;
  const ids = S.selected.has(row.dataset.pid) ? [...S.selected] : [row.dataset.pid];
  e.dataTransfer.setData('text/x-paper-ids', JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'move';
});

async function bulk(ids, action, value) {
  try { await api('/api/papers/bulk', { method: 'POST', body: { ids, action, value } }); await afterChange(); if (S.current && ids.includes(S.current)) renderPreview(); }
  catch (e) { fail(e); }
}
async function bulkAction(kind, e) {
  const ids = [...S.selected];
  if (kind === 'clear') { S.selected.clear(); return renderCenter(); }
  if (kind === 'ask') return newChat({ type: 'papers', ids });
  if (kind === 'summarize') return summarizeIds(ids, false);
  if (kind === 'organize') return organizeIds(ids);
  if (kind === 'move') return moveMenu(ids, e.clientX, e.clientY + 14);
  if (kind === 'star') return bulk(ids, 'star', true);
  if (kind === 'read') return bulk(ids, 'status', 'read');
  if (kind === 'retry') return retryIds(ids);
  if (kind === 'share') return shareIds(ids);
  if (kind === 'delete') return deleteIds(ids);
  if (kind === 'tag') { const t = await modal({ title: `Tag ${ids.length} paper(s)`, value: '', ok: 'Add tag' }); if (t?.trim()) bulk(ids, 'tag', t.trim()); }
}
function moveMenu(ids, x, y) {
  showMenu(x, y, [
    { label: '(Library root — no folder)', fn: () => bulk(ids, 'move', '') },
    ...S.app.folders.map(f => ({ label: '▸ ' + f.path, fn: () => bulk(ids, 'move', f.path) })),
    '-',
    { label: 'New folder…', fn: async () => { const v = await modal({ title: 'Move to new folder', value: S.folder ? S.folder + '/' : '', ok: 'Move' }); if (v) bulk(ids, 'move', v.split('/').map(s => s.trim()).filter(Boolean).join('/')); } },
  ]);
}
async function deleteIds(ids) {
  if (!await modal({ title: `Delete ${ids.length} paper(s)?`, body: 'Removes the PDFs, extracted text, summaries and notes. This cannot be undone.', ok: 'Delete', danger: true })) return;
  await bulk(ids, 'delete');
  ids.forEach(i => S.selected.delete(i));
  if (ids.includes(S.current)) { S.current = null; store.set('current', null); renderPreview(); }
  renderCenter();
}
async function summarizeIds(ids, onlyMissing = true) {
  if (!ids.length) return toast('No papers to summarise');
  try { const j = await api('/api/summarize', { method: 'POST', body: { ids, only_missing: onlyMissing } }); toast(`Summarising ${j.total} paper(s) — see Jobs`); pollJobs(true); }
  catch (e) { fail(e); }
}
async function shareIds(ids) {
  try {
    await api('/api/team/share', { method: 'POST', body: { ids } });
    toast(`Shared ${ids.length} paper(s) with your team`);
    await afterChange();
    if (S.current && ids.includes(S.current)) { S.pv = await api('/api/papers/' + S.current); if (S.pvTab === 'info') renderPreview(); }
  } catch (e) { fail(e); }
}
async function retryIds(ids) {
  try { const j = await api('/api/retry', { method: 'POST', body: { ids, use_proxy: true } }); toast(`Retrying ${j.total} download(s) — see Jobs`); pollJobs(true); }
  catch (e) { fail(e); }
}

// ---------- uploads ----------
async function uploadFiles(files, folder) {
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return toast('Only PDF files can be imported', true);
  toast(`Importing ${pdfs.length} PDF(s)… reading metadata and full text`);
  const fd = new FormData();
  pdfs.forEach(f => fd.append('files', f));
  fd.append('folder', folder || '');
  try {
    const res = await api('/api/upload', { method: 'POST', body: fd });
    const ok = res.filter(r => !r.error && !r.duplicate), dup = res.filter(r => r.duplicate), bad = res.filter(r => r.error);
    toast(`Imported ${ok.length}` + (dup.length ? `, ${dup.length} already in library` : '') + (bad.length ? `, ${bad.length} failed` : ''), !!bad.length);
    bad.forEach(b => toast(b.error, true, 7000));
    await afterChange();
    if (ok.length === 1) openPaper(ok[0].id);
    if (ok.length >= 3) organizeIds(ok.map(p => p.id), folder || '');
  } catch (e) { fail(e); }
}

// ---------- preview pane (reader / details / ask) ----------
async function openPaper(id, { page = null, tab = null, keepTab = false } = {}) {
  if (!id) return;
  document.body.classList.remove('nopreview');
  const changed = S.current !== id;
  S.current = id; store.set('current', id);
  if (tab) S.pvTab = tab; else if (!keepTab && page) S.pvTab = 'read';
  store.set('pvTab', S.pvTab);
  $$('.prow').forEach(r => r.classList.toggle('active', r.dataset.pid === id));
  if (changed || !S.pv || S.pv.id !== id) {
    try { S.pv = await api('/api/papers/' + id); } catch { S.current = null; return renderPreview(); }
    if (S.pv.read_status === 'unread') {
      api('/api/papers/' + id, { method: 'PATCH', body: { read_status: 'reading' } }).then(() => { const r = S.papers.find(p => p.id === id); if (r) { r.read_status = 'reading'; $(`.prow[data-pid="${id}"]`)?.classList.remove('unread'); } refreshState(); });
    }
    renderPreview(page);
  } else {
    renderPreview(page, true);
  }
}

function renderPreview(page = null, sameDoc = false) {
  const pv = $('#preview');
  const p = S.current && S.pv && S.pv.id === S.current ? S.pv : null;
  if (!p) {
    if (S.reader) { S.reader.destroy(); S.reader = null; }
    pv.innerHTML = `<div class="empty" style="margin:auto"><h3>Reader</h3>Select a paper to read it here.<br><span class="small">Select text in a PDF to ask the agent about it.</span></div>`;
    return;
  }
  // Keep the live reader if we're only jumping pages on the same document.
  if (sameDoc && S.pvTab === 'read' && S.reader && S.reader.pid === p.id) {
    $$('.tab', pv).forEach(t => t.classList.toggle('active', t.dataset.tab === 'read'));
    if (page) S.reader.goto(page, true);
    return;
  }
  if (S.reader) { S.reader.destroy(); S.reader = null; }
  S.paperChat = null;
  pv.innerHTML = `
    <div class="pv-head">
      <div class="pv-title" title="${esc(p.title)}">${esc(p.title)}</div>
      ${p.has_pdf ? `<a class="iconbtn" href="/api/papers/${p.id}/pdf" target="_blank" title="Open PDF in a new tab">↗</a>` : ''}
      <button class="iconbtn" id="listBtn" title="Hide the paper list for more reading room">⇤</button>
      <button class="iconbtn" id="focusBtn" title="Focus mode (wide reader)">⤢</button>
      <button class="iconbtn" id="closePv" title="Close reader">✕</button>
    </div>
    <div class="tabs">
      <div class="tab ${S.pvTab === 'read' ? 'active' : ''}" data-tab="read">Read</div>
      <div class="tab ${S.pvTab === 'info' ? 'active' : ''}" data-tab="info">Details & summary</div>
      <div class="tab ${S.pvTab === 'ask' ? 'active' : ''}" data-tab="ask">✦ Ask AI</div>
    </div>
    <div class="pv-body" id="pvBody"></div>`;
  $$('.tab', pv).forEach(t => t.onclick = () => { S.pvTab = t.dataset.tab; store.set('pvTab', S.pvTab); renderPreview(); });
  $('#listBtn').onclick = () => setListCollapsed(true);
  $('#closePv').onclick = () => { setListCollapsed(false); document.body.classList.remove('focus'); document.body.classList.add('nopreview'); if (S.reader) { S.reader.destroy(); S.reader = null; } };
  $('#focusBtn').onclick = () => {
    const on = document.body.classList.toggle('focus');
    if (on && $('#readChat')) setReadChat(true);  // focus mode = PDF and chat side by side
    S.reader?.refit();
  };
  const body = $('#pvBody');
  if (S.pvTab === 'read') renderReadTab(body, p, page);
  else if (S.pvTab === 'info') renderInfoTab(body, p);
  else renderAskTab(body, p);
}

// The paper list (center column) can fold into a thin strip so the reader and chat get the room.
function setListCollapsed(on) {
  if (document.body.classList.contains('listcollapsed') === on) return;
  document.body.classList.toggle('listcollapsed', on);
  store.set('listCollapsed', on);
  S.reader?.refit();
}
$('#listRail').onclick = () => setListCollapsed(false);

function proxyLink(p) {
  const target = p.doi ? 'https://doi.org/' + p.doi : p.url;
  return target ? (S.settings.proxy_prefix || '') + target : '';
}

function renderReadTab(body, p, page) {
  if (!p.has_pdf) {
    body.innerHTML = `<div class="nopdf">
      <h3 style="color:var(--text)">No PDF yet</h3>
      ${p.dl_error ? `<p class="small">Last attempt: ${esc(p.dl_error)}</p>` : ''}
      <div class="row" style="justify-content:center;margin-top:14px">
        <button class="btn primary" id="retryOne">⇩ Try download again</button>
        <button class="btn" id="attachOne">Attach a PDF…</button>
      </div>
      ${proxyLink(p) ? `<p class="small" style="margin-top:16px">Or <a href="${esc(proxyLink(p))}" target="_blank" rel="noopener">open it through the NUS proxy</a>, download it yourself and attach it.</p>` : ''}
      ${p.abstract ? `<div class="card" style="text-align:left;margin-top:20px"><h3>Abstract</h3><div class="abstract" style="font-family:var(--serif)">${esc(p.abstract)}</div></div>` : ''}
    </div>`;
    $('#retryOne').onclick = () => retryIds([p.id]);
    $('#attachOne').onclick = () => attachPdf(p.id);
    return;
  }
  body.innerHTML = `
    <div class="reader-tools">
      <button class="iconbtn" data-z="-" title="Zoom out">−</button>
      <span id="zoomLbl" style="min-width:40px;text-align:center">100%</span>
      <button class="iconbtn" data-z="+" title="Zoom in">+</button>
      <button class="btn sm ghost" data-z="fit" title="Fit width">Fit</button>
      <span style="margin-left:auto">Page</span>
      <input class="inp" id="pageInp" value="1"> <span class="muted">/ <span id="pageCnt">…</span></span>
      <button class="btn sm" id="chatToggle" title="Show the AI chat next to the PDF">✦ Chat</button>
    </div>
    <div class="readsplit">
      <div class="reader" id="reader"></div>
      <div class="vresizer" id="chatResizer" title="Drag to resize"></div>
      <div class="chatcol" id="readChat"></div>
    </div>`;
  S.reader = new Reader($('#reader'), p.id, page || p.last_page || 1);
  setReadChat(S.readChat);
  $('#chatToggle').onclick = () => setReadChat(!S.readChat);
  const rz = $('#chatResizer');
  rz.onmousedown = e => {
    e.preventDefault(); rz.classList.add('drag');
    const split = $('.readsplit', body).getBoundingClientRect();
    const move = ev => document.documentElement.style.setProperty('--chat-w', Math.max(260, Math.min(split.width - 280, split.right - ev.clientX)) + 'px');
    const up = () => { rz.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('readChatW', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-w'))); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
  $$('[data-z]', body).forEach(b => b.onclick = () => S.reader.zoom(b.dataset.z));
  $('#pageInp').onchange = e => S.reader.goto(+e.target.value);
}

function setReadChat(on) {
  S.readChat = on; store.set('readChat', on);
  const col = $('#readChat');
  if (!col) return;
  $('.readsplit').classList.toggle('withchat', on);
  $('#chatToggle').classList.toggle('primary', on);
  if (on && !col.firstChild) S.paperChat = paperChatUI(col, S.pv);
}

async function attachPdf(id) {
  const inp = $('#attachInput');
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { S.pv = await api(`/api/papers/${id}/attach`, { method: 'POST', body: fd }); toast('PDF attached'); await afterChange(); renderPreview(); } catch (e) { fail(e); }
  };
  inp.click();
}

// ---------- PDF reader ----------
class Reader {
  constructor(el, pid, startPage) {
    this.el = el; this.pid = pid; this.scale = null; this.pageEls = []; this.rendered = new Map(); this.dead = false;
    this.fit = store.get('readerFit', true); this.userScale = store.get('readerScale', 1.2);
    this.load(startPage);
  }
  async load(startPage) {
    try {
      this.task = pdfjsLib.getDocument({ url: `/api/papers/${this.pid}/pdf`, isEvalSupported: false });
      this.doc = await this.task.promise;
    } catch (e) { this.el.innerHTML = `<div class="nopdf">Could not open the PDF: ${esc(e.message)}</div>`; return; }
    if (this.dead) return;
    this.base = (await this.doc.getPage(1)).getViewport({ scale: 1 });
    $('#pageCnt') && ($('#pageCnt').textContent = this.doc.numPages);
    this.layout();
    this.goto(Math.min(startPage, this.doc.numPages), false);
    this.el.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.ro = new ResizeObserver(() => { if (this.fit) { clearTimeout(this.rt); this.rt = setTimeout(() => this.refit(), 150); } });
    this.ro.observe(this.el);
  }
  computeScale() {
    const w = this.el.clientWidth - 48;
    return this.fit ? Math.max(0.4, Math.min(3, w / this.base.width)) : this.userScale;
  }
  layout() {
    const keep = this.currentPage();
    this.scale = this.computeScale();
    $('#zoomLbl') && ($('#zoomLbl').textContent = Math.round(this.scale * 100) + '%');
    this.io?.disconnect();
    this.el.innerHTML = '';
    this.rendered.clear();
    this.pageEls = [];
    this.io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) this.render(+en.target.dataset.page); }), { root: this.el, rootMargin: '800px 0px' });
    for (let i = 1; i <= this.doc.numPages; i++) {
      const d = document.createElement('div');
      d.className = 'page'; d.dataset.page = i;
      d.style.width = Math.floor(this.base.width * this.scale) + 'px';
      d.style.height = Math.floor(this.base.height * this.scale) + 'px';
      d.innerHTML = `<span class="pno">${i}</span>`;
      this.el.append(d); this.pageEls.push(d); this.io.observe(d);
    }
    if (keep) this.goto(keep, false);
  }
  async render(n) {
    if (this.rendered.has(n) || this.dead) return;
    this.rendered.set(n, true);
    const page = await this.doc.getPage(n);
    const vp = page.getViewport({ scale: this.scale });
    const d = this.pageEls[n - 1];
    if (!d) return;
    d.style.width = Math.floor(vp.width) + 'px'; d.style.height = Math.floor(vp.height) + 'px';
    const dpr = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
    cv.style.width = Math.floor(vp.width) + 'px'; cv.style.height = Math.floor(vp.height) + 'px';
    d.prepend(cv);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise.catch(() => { });
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.setProperty('--scale-factor', this.scale);
    d.append(tl);
    try {
      const tc = await page.getTextContent();
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
      const end = document.createElement('div'); end.className = 'endOfContent'; tl.append(end);
    } catch { }
  }
  currentPage() {
    if (!this.pageEls.length) return null;
    const top = this.el.scrollTop + this.el.clientHeight * 0.3;
    let cur = 1;
    for (const d of this.pageEls) { if (d.offsetTop <= top) cur = +d.dataset.page; else break; }
    return cur;
  }
  onScroll() {
    const n = this.currentPage();
    const inp = $('#pageInp');
    if (inp && document.activeElement !== inp) inp.value = n;
    clearTimeout(this.st);
    this.st = setTimeout(() => { if (!this.dead && n) api('/api/papers/' + this.pid, { method: 'PATCH', body: { last_page: n } }).catch(() => { }); }, 1200);
  }
  goto(n, flash = true) {
    if (!this.doc) { this.pending = n; return; }
    n = Math.max(1, Math.min(this.doc.numPages, n || 1));
    const d = this.pageEls[n - 1];
    if (!d) return;
    this.el.scrollTop = d.offsetTop - 10;
    if (flash) { d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); }
  }
  zoom(dir) {
    if (dir === 'fit') this.fit = true;
    else { this.fit = false; this.userScale = Math.max(0.4, Math.min(4, (this.scale || 1) * (dir === '+' ? 1.15 : 1 / 1.15))); }
    store.set('readerFit', this.fit); store.set('readerScale', this.userScale);
    this.layout();
  }
  refit() { if (this.doc && this.fit && Math.abs(this.computeScale() - this.scale) > 0.01) this.layout(); }
  destroy() { this.dead = true; this.io?.disconnect(); this.ro?.disconnect(); try { this.task?.destroy(); } catch { } }
}

// text selection → popup
let selInfo = null, selTimer = null;
function updateSelPop() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  const pop = $('#selpop');
  const el = n => n && (n.nodeType === 1 ? n : n.parentElement);
  const inReader = n => el(n)?.closest('#reader');
  if (!text || text.length < 3 || !inReader(sel.anchorNode) || !inReader(sel.focusNode)) { pop.hidden = true; selInfo = null; return; }
  const pageEl = el(sel.anchorNode).closest('.page') || el(sel.focusNode).closest('.page');
  selInfo = { text: text.replace(/\s+/g, ' '), page: pageEl ? +pageEl.dataset.page : null, pid: S.current };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  pop.hidden = false;
  const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2)) + 'px';
  pop.style.top = (r.top > 50 ? r.top - pr.height - 8 : r.bottom + 8) + 'px';
}
// selectionchange also covers keyboard selection; debounce so the popup appears once selecting stops
document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(updateSelPop, 250); });
document.addEventListener('mouseup', e => { if (!e.target.closest('#selpop')) setTimeout(updateSelPop, 10); });
document.addEventListener('mousedown', e => { if (!e.target.closest('#selpop')) $('#selpop').hidden = true; });
$('#selpop').addEventListener('click', async e => {
  const k = e.target.dataset.sel;
  if (!k || !selInfo) return;
  $('#selpop').hidden = true;
  const { text, page, pid } = selInfo;
  const quote = { text, page };
  if (k === 'copy') { navigator.clipboard.writeText(text); toast('Copied'); return; }
  if (k === 'word') {
    if (text.length > 120) return toast('Select a word or a short phrase', true);
    try {
      const v = await api('/api/vocab', { method: 'POST', body: { term: text, paper_id: pid, page } });
      toast(v.exists ? `“${v.term}” is already in your vocabulary` : `Added “${v.term}” to Vocabulary — defining it…`);
      refreshState().then(renderSidebar);
    } catch (e) { fail(e); }
    return;
  }
  if (k === 'note') {
    const p = await api('/api/papers/' + pid);
    const notes = (p.notes ? p.notes.trimEnd() + '\n\n' : '') + `> ${text}${page ? ` [@${pid} p.${page}]` : ''}\n`;
    S.pv = await api('/api/papers/' + pid, { method: 'PATCH', body: { notes } });
    toast('Added to this paper’s notes (Details tab)'); return;
  }
  const prompts = {
    explain: 'Explain this passage in plain language, in the context of the whole paper. Define any jargon.',
    translate: `Translate this passage into ${S.settings.translate_to || 'Chinese'}. Keep technical terms accurate (give the original term in parentheses where helpful).`,
  };
  if ($('#readChat')) setReadChat(true);  // reading the PDF: answer in the chat beside it
  else { S.pvTab = 'ask'; store.set('pvTab', 'ask'); renderPreview(); }
  const ui = await waitFor(() => S.paperChat);
  if (k === 'ask') ui.setQuote(quote);
  else ui.send(prompts[k], quote);
});
const waitFor = (fn, ms = 4000) => new Promise(res => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v || Date.now() - t0 > ms) res(v); else setTimeout(tick, 40); }; tick(); });

// ---------- details tab ----------
function renderInfoTab(body, p) {
  const statusOpts = ['unread', 'reading', 'read'].map(s => `<option ${p.read_status === s ? 'selected' : ''}>${s}</option>`).join('');
  const folderOpts = [`<option value="">(no folder)</option>`, ...S.app.folders.map(f => `<option ${p.folder === f.path ? 'selected' : ''}>${esc(f.path)}</option>`)].join('');
  body.innerHTML = `<div class="details">
    <h2 class="editable" contenteditable="plaintext-only" data-f="title">${esc(p.title)}</h2>
    <div class="muted"><span class="editable" contenteditable="plaintext-only" data-f="authors" title="Comma-separated">${esc(p.authors.join(', ') || 'Add authors')}</span></div>
    <div class="muted small" style="margin-top:4px">
      <span class="editable" contenteditable="plaintext-only" data-f="venue">${esc(p.venue || 'Venue')}</span> ·
      <span class="editable" contenteditable="plaintext-only" data-f="year">${esc(p.year || 'Year')}</span>
      ${p.cited_by != null ? ` · cited by ${p.cited_by}` : ''}${p.pages ? ` · ${p.pages} pages` : ''}
    </div>
    <div class="row small" style="margin-top:10px">
      DOI <span class="editable" contenteditable="plaintext-only" data-f="doi" style="font-family:var(--mono)">${esc(p.doi || '—')}</span>
      ${p.doi ? `<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">publisher ↗</a>` : ''}
      ${proxyLink(p) ? `<a href="${esc(proxyLink(p))}" target="_blank" rel="noopener">via NUS proxy ↗</a>` : ''}
    </div>
    <div class="row" style="margin-top:12px">
      <select class="sel" id="pvFolder">${folderOpts}</select>
      <select class="sel" id="pvStatus">${statusOpts}</select>
      <span id="pvTags">${p.tags.map(t => `<span class="tag acc x" data-untag="${esc(t)}" title="Remove tag">${esc(t)} ✕</span>`).join(' ')}</span>
      <button class="btn sm ghost" id="addTag">+ tag</button>
    </div>
    <div class="sec"><h4>AI summary
      <button class="btn sm" id="genSum">${p.summary ? '↻ Regenerate' : '∑ Generate summary'}</button></h4>
      <div class="md" id="sumBox">${p.summary ? renderMD(p.summary) : `<span class="muted small">${p.has_pdf ? 'Have the agent read the full paper and write a structured summary (research question, methods, findings with page citations, limitations).' : 'Summaries need the full text — add the PDF first.'}</span>`}</div>
    </div>
    ${p.abstract ? `<div class="sec"><h4>Abstract</h4><div class="abstract">${esc(p.abstract)}</div></div>` : ''}
    <div class="sec"><h4>My notes <span class="muted small" id="noteSaved" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h4>
      <textarea class="inp" id="pvNotes" rows="7" placeholder="Your notes on this paper. Highlights you send from the reader land here. The agent can read these too.">${esc(p.notes)}</textarea>
      ${p.notes ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">Preview notes</summary><div class="md" style="margin-top:6px">${renderMD(p.notes)}</div></details>` : ''}
    </div>
    ${S.app.team?.enabled ? `<div class="sec"><h4>Team
      ${p.team_key ? `<span class="tag ok" style="text-transform:none;letter-spacing:0">shared</span><button class="btn sm ghost" id="unshare">Stop sharing</button>` : `<button class="btn sm" id="shareOne">⇄ Share with team</button>`}</h4>
      <div id="teamNotes" class="small muted">${p.team_key ? 'Your notes above sync to the team folder as you type.' : 'Shares the PDF and your notes. Later edits to your notes sync automatically.'}</div></div>` : ''}
    <div class="sec"><h4>File</h4>
      <div class="small muted">Added ${ago(p.added_at)} · ${esc(p.source || '')} · id <code>${p.id}</code></div>
      <div class="row" style="margin-top:8px">
        <button class="btn sm" id="attach2">${p.has_pdf ? 'Replace PDF…' : 'Attach PDF…'}</button>
        ${!p.has_pdf ? `<button class="btn sm" id="retry2">⇩ Retry download</button>` : ''}
        <button class="btn sm danger" id="del2">Delete paper</button>
      </div>
    </div></div>`;
  const save = async patch => {
    try { S.pv = await api('/api/papers/' + p.id, { method: 'PATCH', body: patch }); Object.assign(p, S.pv); refreshIndex(); if (S.view === 'library') loadPapers().then(renderCenter); }
    catch (e) { fail(e); }
  };
  $$('[data-f]', body).forEach(el => {
    el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } };
    el.onblur = () => {
      const f = el.dataset.f, v = el.textContent.trim();
      if (f === 'authors') { const a = v.split(/\s*[,;]\s*/).filter(Boolean); if (a.join(', ') !== p.authors.join(', ') && v !== 'Add authors') save({ authors: a }); }
      else if (f === 'year') { const y = parseInt(v); if (y && y !== p.year) save({ year: y }); }
      else if (v && v !== String(p[f] || '') && !['Venue', '—'].includes(v)) save({ [f]: v });
    };
  });
  $('#pvFolder').onchange = e => save({ folder: e.target.value }).then(refreshState).then(renderSidebar);
  $('#pvStatus').onchange = e => save({ read_status: e.target.value }).then(refreshState).then(renderSidebar);
  $('#addTag').onclick = async () => { const t = await modal({ title: 'Add tag', value: '', ok: 'Add' }); if (t?.trim()) { await save({ tags: [...new Set([...p.tags, t.trim()])] }); renderPreview(); } };
  $$('[data-untag]', body).forEach(t => t.onclick = async () => { await save({ tags: p.tags.filter(x => x !== t.dataset.untag) }); renderPreview(); });
  let nt;
  $('#pvNotes').oninput = e => { clearTimeout(nt); $('#noteSaved').textContent = '…'; nt = setTimeout(async () => { await api('/api/papers/' + p.id, { method: 'PATCH', body: { notes: e.target.value } }); S.pv.notes = e.target.value; $('#noteSaved').textContent = 'saved'; }, 700); };
  if ($('#shareOne')) $('#shareOne').onclick = () => shareIds([p.id]);
  if ($('#unshare')) $('#unshare').onclick = async () => {
    if (!await modal({ title: 'Stop sharing this paper?', body: 'Removes your notes from the team folder. If you shared the paper and no teammate has notes on it, the paper leaves the team folder too.', ok: 'Stop sharing', danger: true })) return;
    try { await api('/api/team/unshare', { method: 'POST', body: { id: p.id } }); S.pv = await api('/api/papers/' + p.id); await afterChange(); renderPreview(); } catch (e) { fail(e); }
  };
  if (p.team_key && S.app.team?.enabled) api(`/api/papers/${p.id}/team_notes`).then(ns => {
    const box = $('#teamNotes');
    if (box && ns.length) box.innerHTML = ns.map(n => `<div class="tnote"><div class="small"><b>${esc(n.by)}</b> <span class="muted">· ${ago(n.updated)}</span></div><div class="md">${renderMD(n.text)}</div></div>`).join('') + `<div class="small muted" style="margin-top:6px">${box.textContent}</div>`;
  }).catch(() => { });
  $('#attach2').onclick = () => attachPdf(p.id);
  $('#retry2') && ($('#retry2').onclick = () => retryIds([p.id]));
  $('#del2').onclick = () => deleteIds([p.id]);
  $('#genSum').onclick = async () => {
    if (!p.has_pdf) return toast('Add the PDF first', true);
    $('#sumBox').innerHTML = `<div class="status-line"><span class="spinner"></span>The agent is reading the paper<span class="dots"></span></div>`;
    try {
      const job = await api('/api/summarize', { method: 'POST', body: { ids: [p.id], only_missing: false } });
      pollJobs(true);
      const fin = await waitJob(job.id);
      S.pv = await api('/api/papers/' + p.id);
      if (S.current === p.id && S.pvTab === 'info') renderPreview();
      if (fin.failed) toast('Summary failed — see Jobs', true);
    } catch (e) { fail(e); }
  };
}
async function waitJob(id) {
  for (; ;) {
    await new Promise(r => setTimeout(r, 2000));
    const j = (await api('/api/jobs')).find(x => x.id === id);
    if (!j || j.status !== 'running') return j || {};
  }
}

// ---------- chat component ----------
class ChatUI {
  constructor(el, { chatId = null, scope, compact = false }) {
    this.el = el; this.chatId = chatId; this.scope = scope; this.compact = compact; this.msgs = []; this.busy = false; this.quote = null;
    this.render();
    if (chatId) this.load();
  }
  async load() {
    try { const c = await api('/api/chats/' + this.chatId); this.msgs = c.messages.map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })); this.scope = c.scope; this.paint(); }
    catch { this.chatId = null; this.paint(); }
  }
  presets() {
    const single = this.scope.type === 'papers' && this.scope.ids.length === 1;
    return single ? [
      ['Key findings', 'What are the key findings? Give concrete numbers and cite pages.'],
      ['Methods', 'Explain the methods step by step: design, data/samples, analysis. What would I need to replicate it?'],
      ['Limitations', 'What are the main limitations and threats to validity? Which ones do the authors acknowledge, and which do they not?'],
      ['Figures', 'Walk me through the main figures and tables: what each shows and the takeaway.'],
      ['Critique', 'Critically review this paper like a peer reviewer: strengths, weaknesses, and questions for the authors.'],
    ] : [
      ['Literature review', 'Write a structured literature review of these papers: group them into themes, summarise what each contributes, note agreements and disagreements, and end with open questions. Cite every claim.'],
      ['Compare methods', 'Build a comparison table of these papers: columns = paper, research question, method/design, data/sample, key result, limitation. Then summarise the main differences.'],
      ['Research gaps', 'Based on these papers, what are the most promising research gaps and unanswered questions? Explain why each gap exists, citing the papers.'],
      ['Find evidence', 'Which papers provide evidence for or against: '],
      ['Reading order', 'Suggest a reading order for these papers for someone new to the topic, with one line on why each matters.'],
    ];
  }
  render() {
    const label = this.scopeLabel();
    this.el.innerHTML = `<div class="chat">
      <div class="msgs"></div>
      <div class="composer">
        <div class="chips">${this.presets().map(([l, t]) => `<span class="chip" data-p="${esc(t)}">${esc(l)}</span>`).join('')}</div>
        <div class="quotebox" hidden><span></span><button class="iconbtn" data-unquote title="Remove quote">✕</button></div>
        <div class="composer-box">
          <textarea rows="1" placeholder="${this.compact ? 'Ask about this paper…' : 'Ask across ' + esc(label) + '…  (Enter to send, Shift+Enter for new line)'}"></textarea>
          <button class="btn primary" data-send>Send</button>
        </div>
      </div></div>`;
    this.box = $('.msgs', this.el); this.ta = $('textarea', this.el);
    this.ta.oninput = () => { this.ta.style.height = 'auto'; this.ta.style.height = Math.min(200, this.ta.scrollHeight) + 'px'; };
    this.ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); } };
    $('[data-send]', this.el).onclick = () => this.busy ? this.stop() : this.submit();
    $('[data-unquote]', this.el).onclick = () => this.setQuote(null);
    $$('.chip', this.el).forEach(c => c.onclick = () => { const t = c.dataset.p; if (t.endsWith(': ')) { this.ta.value = t; this.ta.focus(); } else this.send(t); });
    this.paint();
  }
  scopeLabel() {
    const s = this.scope;
    if (s.type === 'folder') return 'folder “' + s.path + '”';
    if (s.type === 'papers') return s.ids.length === 1 ? 'this paper' : s.ids.length + ' papers';
    return 'your whole library';
  }
  setQuote(q) {
    this.quote = q;
    const qb = $('.quotebox', this.el);
    qb.hidden = !q;
    if (q) { $('span', qb).textContent = `“${q.text}”${q.page ? ' — p.' + q.page : ''}`; this.ta.focus(); }
  }
  paint() {
    if (!this.msgs.length) {
      this.box.innerHTML = `<div class="empty" style="padding:40px 20px"><h3>Ask your agent</h3>It reads ${esc(this.scopeLabel())} and answers with clickable page citations.<br><span class="small">${S.settings.agent_provider && S.settings.agent_provider !== 'claude' ? 'Runs on ' + esc(S.app.agent?.detail || 'your API model') : 'Runs your Claude Code agent locally'}, read-only.</span></div>`;
      return;
    }
    this.box.innerHTML = this.msgs.map((m, i) => this.msgHTML(m, i)).join('');
    this.box.scrollTop = this.box.scrollHeight;
  }
  msgHTML(m, i) {
    if (m.role === 'user') {
      const lines = m.content.split('\n');
      const q = lines.filter(l => l.startsWith('> ')).map(l => l.slice(2)).join(' ');
      const rest = lines.filter(l => !l.startsWith('> ')).join('\n').trim();
      return `<div class="msg user">${q ? `<div class="quote">${esc(q)}</div>` : ''}${esc(rest)}</div>`;
    }
    const tools = m.meta?.tools || [];
    return `<div class="msg ai" data-i="${i}">
      <div class="who">✦ Agent ${m.meta?.cost ? `<span class="muted" style="font-weight:400">$${m.meta.cost.toFixed(3)}</span>` : ''}
        <span class="acts"><button class="btn sm ghost" data-copy="${i}">Copy</button><button class="btn sm ghost" data-save="${i}">Save as note</button></span></div>
      ${tools.length ? `<details class="tools"><summary>${tools.length} step${tools.length > 1 ? 's' : ''} — read ${new Set(tools.filter(t => t.paper).map(t => t.paper)).size} paper(s)</summary>${tools.map(t => `<div>${t.paper ? `<a class="cite" data-pid="${t.paper}" data-page="">${esc(citeLabel(t.paper))}</a> ` : ''}${esc(t.detail)}</div>`).join('')}</details>` : ''}
      <div class="md">${renderMD(m.content)}</div></div>`;
  }
  submit() {
    const t = this.ta.value.trim();
    if (!t || this.busy) return;
    this.ta.value = ''; this.ta.style.height = 'auto';
    this.send(t, this.quote);
  }
  async ensureChat() {
    if (this.chatId) return this.chatId;
    const c = await api('/api/chats', { method: 'POST', body: { scope: this.scope } });
    this.chatId = c.id;
    this.onCreate?.(c);
    refreshChats().then(renderSidebar);
    return c.id;
  }
  async send(text, quote = null) {
    if (this.busy) return;
    if (!S.app.agent?.ok) return toast('Agent not found: ' + (S.app.agent?.detail || ''), true, 7000);
    this.setQuote(null);
    const content = (quote ? `> ${quote.text}\n` + (quote.page ? `> (page ${quote.page})\n` : '') + '\n' : '') + text;
    this.msgs.push({ role: 'user', content });
    const ai = { role: 'assistant', content: '', meta: { tools: [] } };
    this.msgs.push(ai);
    this.paint();
    this.busy = true; this.setBusy(true);
    const node = this.box.lastElementChild;
    const md = $('.md', node);
    md.innerHTML = `<div class="status-line"><span class="spinner"></span><span class="st">Starting agent</span><span class="dots"></span></div>`;
    let raf = null;
    const repaint = () => { raf = null; md.innerHTML = renderMD(ai.content) || ''; this.stick(); };
    try {
      const cid = await this.ensureChat();
      const r = await fetch(`/api/chats/${cid}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content }) });
      if (!r.ok) { let d = r.statusText; try { d = (await r.json()).detail; } catch { } throw new Error(d); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (; ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 2);
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.t === 'delta') { ai.content += ev.text; if (!raf) raf = requestAnimationFrame(repaint); }
          else if (ev.t === 'reset') { ai.content = ''; md.innerHTML = `<div class="status-line"><span class="spinner"></span><span class="st">Working</span><span class="dots"></span></div>`; }
          else if (ev.t === 'tool') {
            ai.meta.tools.push(ev);
            const st = $('.st', md); if (st) st.textContent = ev.detail;
          } else if (ev.t === 'status' && !ai.content) { const st = $('.st', md); if (st) st.textContent = ev.text; }
          else if (ev.t === 'error') { ai.content += `\n\n> ⚠ ${ev.text}`; if (!raf) raf = requestAnimationFrame(repaint); }
          else if (ev.t === 'done') { ai.meta.cost = ev.cost; if (!ai.content && ev.result) ai.content = ev.result; }
        }
      }
    } catch (e) { ai.content += `\n\n> ⚠ ${e.message}`; }
    this.busy = false; this.setBusy(false);
    if (!ai.content.trim()) ai.content = '_(stopped)_';
    this.paint();
  }
  stick() { const b = this.box; if (b.scrollHeight - b.scrollTop - b.clientHeight < 160) b.scrollTop = b.scrollHeight; }
  setBusy(on) { const b = $('[data-send]', this.el); b.textContent = on ? 'Stop' : 'Send'; b.classList.toggle('primary', !on); }
  async stop() { if (this.chatId) await api(`/api/chats/${this.chatId}/stop`, { method: 'POST' }); }
}
document.addEventListener('click', async e => {
  const cp = e.target.closest('[data-copy]'), sv = e.target.closest('[data-save]');
  if (!cp && !sv) return;
  const ui = [S.centerChat, S.paperChat].find(u => u && u.el.contains(e.target));
  if (!ui) return;
  const m = ui.msgs[+(cp || sv).dataset[cp ? 'copy' : 'save']];
  if (cp) { navigator.clipboard.writeText(m.content); toast('Copied'); return; }
  const prev = ui.msgs[+(sv.dataset.save) - 1];
  const title = await modal({ title: 'Save answer as note', value: (prev?.content || 'AI answer').replace(/^>.*\n/gm, '').trim().slice(0, 80), ok: 'Save' });
  if (!title) return;
  await api('/api/notes', { method: 'POST', body: { title, content: m.content, scope: ui.scopeLabel() } });
  toast('Saved to Notes');
});

function paperChatUI(el, p) {
  const scope = { type: 'papers', ids: [p.id] };
  const existing = S.chats.find(c => { try { const s = JSON.parse(c.scope); return s.type === 'papers' && s.ids.length === 1 && s.ids[0] === p.id; } catch { return false; } });
  const ui = new ChatUI(el, { chatId: existing?.id || null, scope, compact: true });
  ui.onCreate = () => refreshChats();
  return ui;
}
function renderAskTab(body, p) { S.paperChat = paperChatUI(body, p); }

async function newChat(scope) {
  try {
    const c = await api('/api/chats', { method: 'POST', body: { scope } });
    await refreshChats();
    go('chat', { chatId: c.id });
  } catch (e) { fail(e); }
}

// ---------- center: chat views ----------
function renderChatView(c) {
  const ch = S.chats.find(x => x.id === S.chatId);
  if (!ch) return go('chats');
  const scope = JSON.parse(ch.scope);
  c.innerHTML = `<div class="viewhead"><h1>✦ ${esc(ch.title)}<span class="sub">${scope.type === 'all' ? 'whole library' : scope.type === 'folder' ? 'folder' : scope.ids.length + ' paper(s)'}</span></h1>
    <button class="btn" id="newSame">New chat, same scope</button>
    <button class="iconbtn" id="delChat" title="Delete chat">🗑</button></div>
    <div class="viewbody" style="display:flex;flex-direction:column;overflow:hidden" id="chatHost"></div>`;
  S.centerChat = new ChatUI($('#chatHost'), { chatId: ch.id, scope });
  $('#newSame').onclick = () => newChat(scope);
  $('#delChat').onclick = async () => { if (!await modal({ title: 'Delete this chat?', ok: 'Delete', danger: true })) return; await api('/api/chats/' + ch.id, { method: 'DELETE' }); await refreshChats(); go('chats'); };
}

function renderChats(c) {
  c.innerHTML = `<div class="viewhead"><h1>AI chats<span class="sub">${S.chats.length}</span></h1>
    <button class="btn primary" id="chatAll">✦ New chat with whole library</button></div>
    <div class="viewbody notes-list">${S.chats.length ? S.chats.map(ch => `<div class="nrow" data-open="${ch.id}"><b>${esc(ch.title)}</b><span class="small muted">${ago(ch.updated_at)}</span></div>`).join('') : `<div class="empty"><h3>No chats yet</h3>Select papers or a folder and click “Ask AI”, or start with the whole library.</div>`}</div>`;
  $('#chatAll').onclick = () => newChat({ type: 'all' });
  $$('[data-open]', c).forEach(r => r.onclick = () => go('chat', { chatId: r.dataset.open }));
}

// ---------- center: notes ----------
async function renderNotes(c) {
  const notes = await api('/api/notes');
  c.innerHTML = `<div class="viewhead"><h1>Notes<span class="sub">${notes.length}</span></h1><button class="btn primary" id="newNote">+ New note</button></div>
    <div class="viewbody notes-list">${notes.length ? notes.map(n => `<div class="nrow" data-note="${n.id}"><b>${esc(n.title)}</b><span class="small muted">${esc(n.scope || '')} · ${ago(n.updated_at)}</span><div class="small muted">${esc(n.preview.replace(/[#*>\[\]_`]/g, '').slice(0, 160))}</div></div>`).join('')
      : `<div class="empty"><h3>No notes yet</h3>Save any AI answer as a note (hover the answer → “Save as note”), or write your own. The agent can read your notes too.</div>`}</div>`;
  $('#newNote').onclick = async () => { const r = await api('/api/notes', { method: 'POST', body: { title: 'Untitled note', content: '' } }); go('note', { noteId: r.id, noteEdit: true }); };
  $$('[data-note]', c).forEach(r => r.onclick = () => go('note', { noteId: r.dataset.note, noteEdit: false }));
}
async function renderNote(c) {
  const n = await api('/api/notes/' + S.noteId).catch(() => null);
  if (!n) return go('notes');
  c.innerHTML = `<div class="viewhead"><button class="iconbtn" id="backNotes" title="Back">←</button>
    <h1 class="editable" contenteditable="plaintext-only" id="noteTitle">${esc(n.title)}</h1>
    <button class="btn" id="toggleEdit">${S.noteEdit ? 'Preview' : 'Edit'}</button>
    <button class="btn" id="copyNote">Copy Markdown</button>
    <button class="iconbtn" id="delNote" title="Delete">🗑</button></div>
    <div class="viewbody pad">${S.noteEdit ? `<div class="note-editor"><textarea class="inp" id="noteBody">${esc(n.content)}</textarea><div class="small muted" id="noteSt"></div></div>` : `<div class="md" style="max-width:820px">${renderMD(n.content) || '<span class="muted">Empty note</span>'}</div>`}</div>`;
  $('#backNotes').onclick = () => go('notes');
  $('#toggleEdit').onclick = () => { S.noteEdit = !S.noteEdit; renderCenter(); };
  $('#copyNote').onclick = () => { navigator.clipboard.writeText(n.content); toast('Copied'); };
  $('#delNote').onclick = async () => { if (await modal({ title: 'Delete note?', ok: 'Delete', danger: true })) { await api('/api/notes/' + n.id, { method: 'DELETE' }); go('notes'); } };
  $('#noteTitle').onblur = e => api('/api/notes/' + n.id, { method: 'PATCH', body: { title: e.target.textContent.trim() || 'Untitled note' } });
  const nb = $('#noteBody');
  let t;
  if (nb) nb.oninput = () => { clearTimeout(t); $('#noteSt').textContent = '…'; t = setTimeout(async () => { await api('/api/notes/' + n.id, { method: 'PATCH', body: { content: nb.value } }); $('#noteSt').textContent = 'saved'; }, 600); };
}

// ---------- batch import & AI organising ----------
function importMenu(x, y) {
  showMenu(x, y, [
    { label: 'PDF files…', fn: () => $('#fileInput').click() },
    { label: 'A whole folder of PDFs…', fn: importFolderDialog },
  ]);
}

function importFolderDialog() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:grid;place-items:center;z-index:90';
  wrap.innerHTML = `<div class="card" style="width:min(520px,94vw);box-shadow:var(--shadow)">
    <h3>Import a folder of PDFs</h3>
    <p class="muted small">Every PDF in the folder and its subfolders is imported in the background. The app looks up metadata from each DOI and indexes the full text, and papers already in your library are skipped.</p>
    <div class="row" style="margin-top:10px;flex-wrap:nowrap"><input class="inp" id="ifPath" placeholder="~/Downloads/papers" style="flex:1;min-width:0"><button class="btn" id="ifPick">Choose…</button></div>
    <label class="chk small" style="margin-top:12px"><input type="checkbox" id="ifOrg" checked> Then organise them with AI: a folder per research topic, plus tags for method, model system and study type. You review the plan before anything moves.</label>
    <div class="row small" style="margin-top:10px">Put the new folders under <input class="inp" id="ifBase" placeholder="(top level)" style="width:180px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Import</button></div></div>`;
  document.body.append(wrap);
  const close = () => wrap.remove();
  $('[data-x]', wrap).onclick = close;
  wrap.onclick = e => { if (e.target === wrap) close(); };
  wrap.onkeydown = e => { if (e.key === 'Escape') close(); };
  $('#ifPick', wrap).onclick = () => pickFolder($('#ifPath', wrap));
  $('#ifOrg', wrap).onchange = e => { $('#ifBase', wrap).disabled = !e.target.checked; };
  $('[data-ok]', wrap).onclick = async () => {
    const path = $('#ifPath', wrap).value.trim();
    if (!path) return toast('Choose a folder first', true);
    try {
      const j = await api('/api/import_folder', { method: 'POST', body: { path, organize: $('#ifOrg', wrap).checked, base: $('#ifBase', wrap).value.trim(), folder: '' } });
      close(); toast(`${j.title} — progress in Jobs`); pollJobs(true); go('jobs');
    } catch (e) { fail(e); }
  };
  $('#ifPath', wrap).focus();
}

async function organizeIds(ids, base = '') {
  if (!ids.length) return toast('No papers to organise');
  const v = await modal({
    title: `Organise ${ids.length} paper(s) with AI`, value: base, ok: 'Start',
    body: 'The agent designs a folder structure from the papers’ topics, then gives each paper a folder and tags for method, model system and study type. You review the plan before anything moves.<br><br>Put the new folders under (leave blank for the top level):',
  });
  if (v === null) return;
  try { const j = await api('/api/organize', { method: 'POST', body: { ids, base: v } }); toast(`${j.title}: the plan opens when it’s ready`); pollJobs(true); }
  catch (e) { fail(e); }
}

async function renderPlan(c) {
  const plan = await api('/api/plans/' + S.planId).catch(() => null);
  if (S.view !== 'plan') return;
  if (!plan) return go('jobs');
  const renames = S.planRenames ||= {};
  const shown = f => renames[f] || f;
  const groups = new Map();
  for (const it of plan.items) { const f = shown(it.folder); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(it); }
  const about = new Map(plan.folders.map(f => [shown(f.path), f.about]));
  const tops = [...new Set([...groups.keys()].map(f => f.split('/')[0]))].sort((a, b) => a.localeCompare(b));
  const ready = plan.status === 'ready';
  const items = list => `<ul class="plan-items">${list.map(it => `<li><a data-popen="${it.id}">${esc(it.title)}</a> ${it.tags.map(t => `<span class="tag acc">${esc(t)}</span>`).join(' ')}</li>`).join('')}</ul>`;
  const head = (path, label, n) => `<span class="plan-f">${esc(label)}</span> <span class="muted small">${n}</span>${ready ? ` <button class="iconbtn" data-rename="${esc(path)}" title="Rename folder">✎</button>` : ''}${about.get(path) ? `<div class="small muted">${esc(about.get(path))}</div>` : ''}`;
  const count = top => [...groups].filter(([f]) => f === top || f.startsWith(top + '/')).reduce((n, [, l]) => n + l.length, 0);
  const status = { ready: 'review, then apply', applied: 'applied', undone: 'undone', discarded: 'discarded' }[plan.status];
  c.innerHTML = `<div class="viewhead"><button class="iconbtn" id="planBack" title="Back to Jobs">←</button>
    <h1>Organisation plan<span class="sub">${plan.items.length} paper(s) · ${groups.size} folder(s) · ${status}</span></h1>
    ${ready ? `<button class="btn" id="planDiscard">Discard</button><button class="btn primary" id="planApply">Apply</button>` : ''}
    ${plan.status === 'applied' ? `<button class="btn" id="planUndo" title="Put every paper back in its previous folder, with its previous tags">↶ Undo</button>` : ''}</div>
    <div class="viewbody pad">
      ${ready ? `<p class="small muted" style="margin-top:0">Applying moves each paper into its folder and adds its tags (existing tags are kept). Rename any folder with ✎ first. You can undo the whole plan afterwards.</p>` : ''}
      ${tops.map(top => `<details class="plan-top" open><summary>${head(top, top, count(top))}</summary>
        ${groups.has(top) ? items(groups.get(top)) : ''}
        ${[...groups.keys()].filter(f => f.startsWith(top + '/')).sort().map(f => `<div class="plan-sub">${head(f, f.slice(top.length + 1), groups.get(f).length)}${items(groups.get(f))}</div>`).join('')}
      </details>`).join('')}
    </div>`;
  $('#planBack').onclick = () => go('jobs');
  $$('[data-popen]', c).forEach(a => a.onclick = () => openPaper(a.dataset.popen, { tab: 'info' }));
  $$('[data-rename]', c).forEach(b => b.onclick = async e => {
    e.preventDefault();
    const old = b.dataset.rename;
    const v = await modal({ title: 'Rename folder', value: old, ok: 'Rename', body: 'Use “/” for a subfolder.' });
    const nu = v?.split('/').map(s => s.trim()).filter(Boolean).join('/');
    if (!nu || nu === old) return;
    for (const f of new Set(plan.items.map(it => it.folder))) {
      const cur = shown(f);
      if (cur === old || cur.startsWith(old + '/')) renames[f] = nu + cur.slice(old.length);
    }
    renderPlan(c);
  });
  const act = async (action, msg) => {
    try { await api(`/api/plans/${plan.id}/${action}`, { method: 'POST', body: { renames } }); S.planRenames = null; toast(msg); await afterChange(); }
    catch (e) { fail(e); }
  };
  if (ready) {
    $('#planApply').onclick = () => act('apply', `Organised ${plan.items.length} paper(s)`);
    $('#planDiscard').onclick = () => act('discard', 'Plan discarded');
  }
  if ($('#planUndo')) $('#planUndo').onclick = async () => {
    if (await modal({ title: 'Undo this organisation?', body: 'Every paper in the plan goes back to the folder and tags it had before. Folders the plan created are removed once empty.', ok: 'Undo' })) act('undo', 'Undone');
  };
}

// ---------- center: team ----------
async function renderTeam(c) {
  const tm = S.app.team || {};
  if (!tm.enabled) {
    c.innerHTML = `<div class="viewhead"><h1>Team</h1></div>
    <div class="viewbody pad"><div class="card" style="max-width:640px">
      <h3>Share papers and reading notes with your team</h3>
      <p class="small muted">Everyone chooses the same synced folder, for example a shared Dropbox, OneDrive or Google Drive folder. Each shared paper gets its own subfolder holding the PDF and one notes file per person. Nobody edits anyone else's files, so nothing conflicts, and teammates without this app can still open everything.</p>
      <div class="grid2" style="margin-top:12px">
        <label>Your name</label><input class="inp" id="tmName" value="${esc(S.settings.my_name)}" placeholder="${esc(tm.name || '')}" style="width:200px">
        <label>Team folder</label><div class="row"><input class="inp" id="tmDir" value="${esc(S.settings.team_dir)}" placeholder="~/Dropbox/Lab papers" style="flex:1;min-width:220px"><button class="btn" id="tmPick">Choose…</button></div>
      </div>
      ${tm.detail ? `<p class="small" style="color:var(--err);margin-top:8px">${esc(tm.detail)}</p>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn primary" id="tmSave">Start sharing</button></div>
    </div></div>`;
    $('#tmPick').onclick = () => pickFolder($('#tmDir'));
    $('#tmSave').onclick = async () => {
      try { S.settings = await api('/api/settings', { method: 'PUT', body: { my_name: $('#tmName').value.trim(), team_dir: $('#tmDir').value.trim() } }); await refreshState(); renderAll(); }
      catch (e) { fail(e); }
    };
    return;
  }
  c.innerHTML = `<div class="viewhead"><h1>Team<span class="sub" title="${esc(tm.dir)}">${esc(tm.dir.split('/').pop())} · you are ${esc(tm.name)}</span></h1>
    <button class="btn" id="teamRefresh">↻ Refresh</button></div>
    <div class="viewbody" id="teamBody"><div class="status-line pad"><span class="spinner"></span>Reading the team folder…</div></div>`;
  $('#teamRefresh').onclick = () => refreshState().then(renderAll);
  let items;
  try { items = await api('/api/team'); } catch (e) { $('#teamBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (S.view !== 'team' || !$('#teamBody')) return;
  const seen = store.get('teamSeen', 0);
  store.set('teamSeen', Date.now() / 1000);
  renderSidebar();
  if (!items.length) {
    $('#teamBody').innerHTML = `<div class="empty"><h3>Nothing shared yet</h3>Right-click papers in your library and choose <b>Share with team</b>, or use <b>Share with team</b> in a paper's Details tab.<br>Teammates' papers appear here as their sync app brings them in.</div>`;
    return;
  }
  const mine = n => n === tm.name;
  $('#teamBody').innerHTML = items.map(it => {
    const theirs = Math.max(mine(it.shared_by) ? 0 : it.shared_at || 0, ...it.notes.filter(n => !n.mine).map(n => n.updated));
    const act = it.linked ? `<button class="btn sm" data-topen="${it.local_id}">Open</button>`
      : `<button class="btn sm primary" data-tadd="${esc(it.key)}">${it.local_id ? 'Link my copy' : '+ Add to library'}</button>`;
    return `<div class="trow ${theirs > seen ? 'fresh' : ''}">
      <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><div style="min-width:0;flex:1">
        <div class="ptitle" ${it.linked ? `data-topen="${it.local_id}" style="cursor:pointer"` : ''}>${esc(it.title)}</div>
        <div class="pmeta">${esc([authorsShort(it.authors), it.year, it.venue].filter(Boolean).join(' · '))}</div>
        <div class="small muted">Shared by ${esc(mine(it.shared_by) ? 'you' : it.shared_by)} · ${ago(it.shared_at)}${it.has_pdf ? '' : ' · no PDF'}</div></div>${act}</div>
      ${it.notes.map(n => `<details class="tnote"><summary><b>${esc(n.mine ? 'Your notes' : n.by)}</b> <span class="muted small">· ${ago(n.updated)}</span></summary><div class="md">${renderMD(n.text)}</div></details>`).join('')}
    </div>`;
  }).join('');
  $$('[data-topen]', c).forEach(b => b.onclick = () => openPaper(b.dataset.topen, { tab: 'info' }));
  $$('[data-tadd]', c).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('/api/team/add', { method: 'POST', body: { key: b.dataset.tadd } }); toast('Added to your library'); await afterChange(); openPaper(r.id); }
    catch (e) { b.disabled = false; fail(e); }
  });
}

async function pickFolder(input) {
  try { const r = await api('/api/pick_folder', { method: 'POST' }); if (r.path) input.value = r.path; }
  catch (e) { fail(e); }
}

// ---------- center: vocabulary ----------
function markTerm(text, term) {
  const re = new RegExp(term.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');
  const m = text.match(re);
  return m ? esc(text.slice(0, m.index)) + `<mark>${esc(m[0])}</mark>` + esc(text.slice(m.index + m[0].length)) : esc(text);
}
function vocabSource(v) {
  return v.paper_id && S.index.has(v.paper_id) ? `<a class="cite" data-pid="${v.paper_id}" data-page="${v.page || ''}">${esc(citeLabel(v.paper_id))}${v.page ? ' · p.' + v.page : ''}</a>` : '';
}
function vocabRowHTML(v) {
  const level = '●'.repeat(v.box) + '○'.repeat(5 - v.box);
  return `<div class="vrow" data-v="${v.id}">
    <div><div class="vterm">${esc(v.term)}</div><div class="vlevel" title="Review level ${v.box}/5">${level}</div></div>
    <div style="min-width:0">
      ${v.status === 'defining' ? `<div class="status-line"><span class="spinner"></span>Defining<span class="dots"></span></div>` : ''}
      ${v.status === 'error' ? `<div class="small" style="color:var(--err)">Couldn't define it. Type a definition, or try ↻ again.</div>` : ''}
      ${v.status !== 'defining' ? `<div class="vtr editable" contenteditable="plaintext-only" data-vf="translation" data-ph="Translation">${esc(v.translation)}</div>
      <div class="vdef editable" contenteditable="plaintext-only" data-vf="definition" data-ph="Definition">${esc(v.definition)}</div>` : ''}
      ${v.context ? `<div class="vctx">${markTerm(v.context, v.term)}</div>` : ''}
      ${vocabSource(v)}
    </div>
    <div class="vacts"><button class="iconbtn" data-vdef title="Define again">↻</button><button class="iconbtn" data-vdel title="Delete">✕</button></div></div>`;
}
function vocabListHTML() {
  const q = (S.vq || '').toLowerCase();
  const ws = S.vocab.filter(v => !q || [v.term, v.definition, v.translation, v.context].some(x => (x || '').toLowerCase().includes(q)));
  if (!S.vocab.length) return `<div class="empty"><h3>No words yet</h3>Select a word or phrase in a PDF and click <b>+ Word</b>. The agent writes a definition and a ${esc(S.settings.translate_to || '')} translation, and keeps the sentence it came from.</div>`;
  return ws.length ? ws.map(vocabRowHTML).join('') : `<div class="empty">No words match “${esc(S.vq)}”.</div>`;
}
async function renderVocab(c) {
  clearTimeout(S.vocabTimer);
  S.vocab = await api('/api/vocab');
  if (S.view !== 'vocab') return;
  if (S.review) return renderReview(c);
  const now = Date.now() / 1000, due = S.vocab.filter(v => v.due <= now && v.status !== 'defining');
  c.innerHTML = `<div class="viewhead"><h1>Vocabulary<span class="sub">${S.vocab.length} word${S.vocab.length === 1 ? '' : 's'}</span></h1>
    <input class="inp" id="vq" type="search" placeholder="Filter…" value="${esc(S.vq || '')}" style="width:150px">
    <button class="btn" id="vAdd">+ Add</button>
    <a class="btn" href="/api/vocab.csv" download title="CSV with term, meaning, context, source: imports into Anki or Excel">Export</a>
    <button class="btn primary" id="vReview" ${due.length ? '' : 'disabled title="Nothing due. Come back later."'}>Review${due.length ? ` (${due.length})` : ''}</button></div>
    <div class="viewbody" id="vList">${vocabListHTML()}</div>`;
  $('#vq').oninput = e => { S.vq = e.target.value; $('#vList').innerHTML = vocabListHTML(); };
  $('#vAdd').onclick = async () => {
    const t = await modal({ title: 'Add a word or phrase', value: '', ok: 'Add' });
    if (!t?.trim()) return;
    try { await api('/api/vocab', { method: 'POST', body: { term: t } }); refreshState().then(renderSidebar); renderCenter(); } catch (e) { fail(e); }
  };
  $('#vReview').onclick = () => { S.review = { queue: due, i: 0, shown: false, done: 0 }; renderReview(c); };
  if (S.vocab.some(v => v.status === 'defining')) {
    const poll = () => { if (S.view !== 'vocab' || S.review) return; if (document.activeElement?.closest('#vList, #vq')) S.vocabTimer = setTimeout(poll, 2500); else renderCenter(); };
    S.vocabTimer = setTimeout(poll, 2500);
  }
}
$('#center').addEventListener('click', async e => {
  const row = e.target.closest('.vrow');
  if (!row) return;
  const id = row.dataset.v;
  try {
    if (e.target.closest('[data-vdef]')) { await api(`/api/vocab/${id}/define`, { method: 'POST' }); renderCenter(); }
    if (e.target.closest('[data-vdel]')) { await api('/api/vocab/' + id, { method: 'DELETE' }); row.remove(); S.vocab = S.vocab.filter(v => v.id !== id); refreshState().then(renderSidebar); }
  } catch (err) { fail(err); }
});
$('#center').addEventListener('focusout', e => {
  const f = e.target.closest?.('[data-vf]');
  if (!f) return;
  const v = S.vocab.find(x => x.id === f.closest('.vrow').dataset.v), k = f.dataset.vf, val = f.textContent.trim();
  if (v && val !== (v[k] || '')) { v[k] = val; api('/api/vocab/' + v.id, { method: 'PATCH', body: { [k]: val } }).catch(fail); }
});

function renderReview(c) {
  const R = S.review, v = R.queue[R.i];
  const back = () => { S.review = null; refreshState().then(renderAll); };
  if (!v) {
    c.innerHTML = `<div class="viewhead"><button class="iconbtn" id="rBack" title="Back">←</button><h1>Review</h1></div>
      <div class="empty"><h3>All caught up</h3>You reviewed ${R.done} word${R.done === 1 ? '' : 's'}. Words you got right come back in 1, 3, 7, 16 and then 35 days.<br><button class="btn primary" id="rDone">Back to Vocabulary</button></div>`;
    $('#rBack').onclick = $('#rDone').onclick = back;
    return;
  }
  c.innerHTML = `<div class="viewhead"><button class="iconbtn" id="rBack" title="Back">←</button><h1>Review<span class="sub">${R.i + 1} / ${R.queue.length}</span></h1></div>
    <div class="viewbody pad"><div class="fcard">
      <div class="fterm">${esc(v.term)}</div>
      ${v.context ? `<div class="vctx">${markTerm(v.context, v.term)}</div>` : ''}
      ${R.shown ? `<div class="fans">${v.translation ? `<div class="vtr">${esc(v.translation)}</div>` : ''}<div>${esc(v.definition || '(no definition)')}</div><div style="margin-top:8px">${vocabSource(v)}</div></div>
        <div class="row" style="justify-content:center;margin-top:20px"><button class="btn" data-r="0">Again <kbd>1</kbd></button><button class="btn primary" data-r="1">Got it <kbd>2</kbd></button></div>`
      : `<div class="row" style="justify-content:center;margin-top:20px"><button class="btn primary" data-show>Show answer <kbd>Space</kbd></button></div>`}
    </div></div>`;
  $('#rBack').onclick = back;
  $('[data-show]', c)?.addEventListener('click', () => reviewKey(' '));
  $$('[data-r]', c).forEach(b => b.onclick = () => reviewKey(b.dataset.r === '1' ? '2' : '1'));
}
async function reviewKey(k) {
  const R = S.review, v = R?.queue[R.i];
  if (!v) return;
  if (!R.shown) { if (k === ' ') { R.shown = true; renderReview($('#center')); } return; }
  if (k !== '1' && k !== '2') return;
  const ok = k === '2';
  api(`/api/vocab/${v.id}/review`, { method: 'POST', body: { ok } }).then(() => refreshState()).then(renderSidebar).catch(fail);
  if (!ok) R.queue.push(v); else R.done++;
  R.i++; R.shown = false;
  renderReview($('#center'));
}

// ---------- center: discover (NUS batch search & download) ----------
function renderDiscover(c) {
  const d = S.discover;
  const ns = S.app.nus || {};
  c.innerHTML = `<div class="viewhead"><h1>Find papers<span class="sub">batch search by topic · download with your NUS Library access</span></h1></div>
  <div class="viewbody pad">
    <div class="card">
      <h3>NUS Libraries access</h3>
      <div class="row">
        <span class="pill ${ns.logged_in ? 'ok' : ns.browser_open ? 'warn' : ''}">${ns.logged_in ? '● Connected' : ns.browser_open ? '● Browser open — sign in' : '○ Not connected'}</span>
        <span class="small muted">${esc(ns.detail || '')}</span>
      </div>
      <div class="row">
        <button class="btn primary" id="nusConnect">Connect NUS Library</button>
        <button class="btn" id="nusCheck">Check status</button>
        ${ns.browser_open ? `<button class="btn ghost" id="nusClose">Close browser</button>` : ''}
      </div>
      <p class="small muted" style="margin-top:8px">Opens a Chrome window at the NUS Libraries proxy. Log in there with your NUSNET ID (and 2FA) yourself — this app never sees your password. The login is kept in a private browser profile inside this folder, so you'll rarely need to repeat it. Open-access papers download without NUS.</p>
    </div>

    <div class="card">
      <h3>Topics <span class="muted small" style="font-weight:400">one per line — each becomes its own search</span></h3>
      <textarea class="inp" id="dTopics" rows="4" placeholder="e.g.\nCRISPR base editing in erythroid cells\nred blood cell enucleation mechanisms\nlarge language models for literature review">${esc(d.topics)}</textarea>
      <div class="row">
        <label class="small">Per topic <input class="inp" id="dPer" type="number" min="1" max="100" value="${d.per_topic}" style="width:64px"></label>
        <label class="small">Years <input class="inp" id="dFrom" type="number" placeholder="from" value="${d.year_from}" style="width:76px"> – <input class="inp" id="dTo" type="number" placeholder="to" value="${d.year_to}" style="width:76px"></label>
        <select class="sel" id="dSort">${[['relevance', 'Most relevant'], ['cited', 'Most cited'], ['recent', 'Newest']].map(([v, l]) => `<option value="${v}" ${d.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="row">
        <label class="chk small"><input type="checkbox" id="dProxy" ${d.use_proxy ? 'checked' : ''}> Use NUS proxy for paywalled papers</label>
        <label class="chk small"><input type="checkbox" id="dOA" ${d.oa_only ? 'checked' : ''}> Open access only</label>
        <label class="chk small"><input type="checkbox" id="dFolders" ${d.folder_per_topic ? 'checked' : ''}> A folder per topic under</label>
        <input class="inp" id="dBase" value="${esc(d.folder_base)}" style="width:110px">
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="dPreview">⌕ Search & review</button>
        <button class="btn primary" id="dAll">⇩ Search & download all</button>
        <span class="small muted">Searches OpenAlex (~250M works); PDFs come from open access first, then via NUS.</span>
      </div>
      <div class="note-callout">Publishers' licences forbid systematic bulk downloading, and NUS may suspend proxy access if it detects it. The app spaces requests ${S.settings.delay_min}–${S.settings.delay_max}s apart and caps batches at ${S.settings.max_per_batch} (change in Settings). Keep batches to what you'll actually read.</div>
    </div>

    <div class="card">
      <h3>Add by DOI</h3>
      <textarea class="inp" id="dDois" rows="2" placeholder="10.1038/s41586-020-2649-2&#10;10.1182/blood.2021012345"></textarea>
      <div class="row"><button class="btn" id="dDoiGo">⇩ Add & download</button>
      <span class="small muted">→ into ${S.folder ? 'folder “' + esc(S.folder) + '”' : 'library root'}</span></div>
    </div>
    <div id="dResults">${S.discoverResults ? discoverResultsHTML() : ''}</div>
  </div>`;

  const read = () => {
    Object.assign(d, {
      topics: $('#dTopics').value, per_topic: +$('#dPer').value || 15, year_from: $('#dFrom').value, year_to: $('#dTo').value,
      sort: $('#dSort').value, use_proxy: $('#dProxy').checked, oa_only: $('#dOA').checked, folder_per_topic: $('#dFolders').checked, folder_base: $('#dBase').value.trim(),
    });
    store.set('discover', d);
    return d.topics.split('\n').map(s => s.trim()).filter(Boolean);
  };
  $('#nusConnect').onclick = async () => {
    try { await api('/api/nus/connect', { method: 'POST' }); toast('A Chrome window opened — sign in with NUSNET, then click “Check status”', false, 8000); await refreshState(); renderCenter(); }
    catch (e) { fail(e); }
  };
  $('#nusCheck').onclick = async () => { $('#nusCheck').disabled = true; try { S.app.nus = await api('/api/nus/status'); renderPills(); renderCenter(); } catch (e) { fail(e); } };
  $('#nusClose') && ($('#nusClose').onclick = async () => { await api('/api/nus/close', { method: 'POST' }); await refreshState(); renderCenter(); });
  $('#dPreview').onclick = async () => {
    const topics = read();
    if (!topics.length) return toast('Enter at least one topic', true);
    $('#dResults').innerHTML = `<div class="status-line" style="padding:10px"><span class="spinner"></span>Searching ${topics.length} topic(s)…</div>`;
    try { S.discoverResults = await api('/api/discover', { method: 'POST', body: { ...d, topics } }); $('#dResults').innerHTML = discoverResultsHTML(); wireResults(); }
    catch (e) { $('#dResults').innerHTML = ''; fail(e); }
  };
  $('#dAll').onclick = async () => {
    const topics = read();
    if (!topics.length) return toast('Enter at least one topic', true);
    try { const j = await api('/api/batch', { method: 'POST', body: { ...d, topics } }); toast('Started — progress in Jobs'); pollJobs(true); go('jobs'); }
    catch (e) { fail(e); }
  };
  $('#dDoiGo').onclick = async () => {
    try { await api('/api/papers/add_doi', { method: 'POST', body: { dois: $('#dDois').value, folder: S.folder || '', use_proxy: $('#dProxy').checked } }); toast('Adding — progress in Jobs'); pollJobs(true); $('#dDois').value = ''; }
    catch (e) { fail(e); }
  };
  wireResults();
}

function discoverResultsHTML() {
  const res = S.discoverResults || [];
  const total = res.reduce((n, r) => n + r.works.filter(w => !w.in_library).length, 0);
  return `<div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0;flex:1">Results</h3>
    <button class="btn primary" id="dlSel">⇩ Download selected (<span id="selN">${total}</span>)</button></div>
    ${res.map((r, ti) => `<div class="topicres"><h4><input type="checkbox" checked data-topicall="${ti}"> ${esc(r.topic)} <span class="muted small">${r.works.length} results${r.error ? ' — ' + esc(r.error) : ''}</span></h4>
      ${r.works.map((w, wi) => `<div class="work"><input type="checkbox" data-w="${ti}:${wi}" ${w.in_library ? 'disabled' : 'checked'}>
        <div><div class="wt">${esc(w.title)}</div><div class="wa">${esc(authorsShort(w.authors))} · ${w.year || ''} · ${esc(w.venue)}${w.cited_by != null ? ` · cited ${w.cited_by}` : ''}${w.doi ? ` · <a href="https://doi.org/${esc(w.doi)}" target="_blank" rel="noopener">doi</a>` : ''}</div>
        ${w.abstract ? `<details><summary>Abstract</summary>${esc(w.abstract)}</details>` : ''}</div>
        <div>${w.in_library ? '<span class="tag ok">in library</span>' : w.oa_url ? '<span class="tag ok">open access</span>' : w.doi ? '<span class="tag">via NUS</span>' : '<span class="tag err">no DOI</span>'}</div></div>`).join('')}</div>`).join('')}</div>`;
}
function wireResults() {
  const btn = $('#dlSel');
  if (!btn) return;
  const count = () => $('#selN').textContent = $$('[data-w]:checked').length;
  $$('[data-topicall]').forEach(cb => cb.onchange = () => { $$(`[data-w^="${cb.dataset.topicall}:"]:not(:disabled)`).forEach(x => x.checked = cb.checked); count(); });
  $$('[data-w]').forEach(cb => cb.onchange = count);
  btn.onclick = async () => {
    const d = S.discover;
    const items = $$('[data-w]:checked').map(cb => {
      const [ti, wi] = cb.dataset.w.split(':').map(Number);
      const r = S.discoverResults[ti];
      return { work: r.works[wi], folder: d.folder_per_topic ? [d.folder_base, r.topic].filter(Boolean).join('/') : (S.folder || ''), source: 'search: ' + r.topic };
    });
    if (!items.length) return toast('Nothing selected', true);
    try { await api('/api/download', { method: 'POST', body: { items, use_proxy: d.use_proxy } }); toast(`Downloading ${items.length} paper(s) — progress in Jobs`); pollJobs(true); go('jobs'); }
    catch (e) { fail(e); }
  };
}

// ---------- center: jobs ----------
function renderJobs(c) {
  c.innerHTML = `<div class="viewhead"><h1>Jobs<span class="sub">downloads & batch summaries</span></h1></div>
  <div class="viewbody pad">${S.jobs.length ? S.jobs.map(j => {
    const pct = j.total ? Math.round(100 * (j.done + j.failed) / j.total) : (j.status === 'running' ? 5 : 100);
    return `<div class="job"><div class="job-h">${j.status === 'running' ? '<span class="spinner"></span>' : ''}<span class="t">${esc(j.title)}</span>
      <span class="small muted">${j.done} ok · ${j.failed} failed · ${j.total} total · ${esc(j.status)} · ${ago(j.created_at)}</span>
      ${j.status === 'running' ? `<button class="btn sm" data-cancel="${j.id}">Cancel</button>` : ''}
      ${j.kind === 'organize' && j.status === 'done' ? `<button class="btn sm primary" data-plan="${j.id}">Review plan</button>` : ''}
      ${j.failed && j.status !== 'running' && !['summarize', 'organize'].includes(j.kind) ? `<button class="btn sm" data-retryjob="${j.id}">Retry failed</button>` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="joblog">${j.log.slice().reverse().map(l => `<div class="${l.level}">${l.paper ? `<a data-openp="${l.paper}">${esc(l.msg)}</a>` : esc(l.msg)}</div>`).join('') || '<div class="muted">Starting…</div>'}</div></div>`;
  }).join('') : '<div class="empty"><h3>No jobs yet</h3>Batch downloads and summaries show their progress here.</div>'}</div>`;
  $$('[data-cancel]', c).forEach(b => b.onclick = () => api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }).then(() => toast('Cancelling after the current paper…')));
  $$('[data-openp]', c).forEach(a => a.onclick = () => openPaper(a.dataset.openp));
  $$('[data-plan]', c).forEach(b => b.onclick = () => go('plan', { planId: b.dataset.plan, planRenames: null }));
  $$('[data-retryjob]', c).forEach(b => b.onclick = () => {
    const j = S.jobs.find(x => x.id === b.dataset.retryjob);
    const ids = [...new Set(j.log.filter(l => l.level === 'error' && l.paper).map(l => l.paper))];
    retryIds(ids);
  });
}

let jobTimer = null, prevRunning = new Set();
async function pollJobs(force = false) {
  clearTimeout(jobTimer);
  try {
    S.jobs = await api('/api/jobs');
    const running = new Set(S.jobs.filter(j => j.status === 'running').map(j => j.id));
    const finished = [...prevRunning].filter(id => !running.has(id));
    if (finished.length || running.size) {
      await Promise.all([refreshState(), refreshIndex()]);
      if (S.view === 'library') { await loadPapers(); const keepScroll = $('#plistWrap')?.scrollTop; renderCenter(); if ($('#plistWrap')) $('#plistWrap').scrollTop = keepScroll || 0; }
    }
    for (const id of finished) {
      const j = S.jobs.find(x => x.id === id);
      if (!j) continue;
      if (j.kind === 'organize' && j.status === 'done') { toast('Organisation plan ready to review'); go('plan', { planId: j.id, planRenames: null }); }
      else toast(`${j.title}: ${j.done} done, ${j.failed} failed`, j.failed > 0);
    }
    if (finished.length && S.pv && S.current) { S.pv = await api('/api/papers/' + S.current).catch(() => S.pv); if (S.pvTab !== 'ask' && !(S.pvTab === 'read' && S.reader && S.pv.has_pdf)) renderPreview(); }
    prevRunning = running;
    renderSidebar();
    if (S.view === 'jobs') { const st = $('.joblog')?.scrollTop; renderCenter(); }
    jobTimer = setTimeout(pollJobs, running.size ? 2500 : 15000);
  } catch { jobTimer = setTimeout(pollJobs, 8000); }
}

// ---------- center: settings ----------
const PROVIDERS = {  // defaults filled in when you pick a provider; all fields stay editable
  claude: { label: 'Claude Code (local CLI)' },
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  qwen: { label: 'Qwen (Alibaba Cloud DashScope)', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  openai: { label: 'Other OpenAI-compatible API', base: '', model: '', models: [] },
};
function renderSettings(c) {
  const s = S.settings;
  const f = (k, label, help = '', type = 'text', w = 280) => `<label>${label}</label><div><input class="inp" data-k="${k}" type="${type}" value="${esc(s[k])}" style="width:${w}px">${help ? `<div class="small muted">${help}</div>` : ''}</div>`;
  c.innerHTML = `<div class="viewhead"><h1>Settings</h1><button class="btn primary" id="saveSet">Save</button></div>
  <div class="viewbody pad">
    <div class="card"><h3>AI provider</h3>
      <p class="small ${S.app.agent?.ok ? '' : 'muted'}">${S.app.agent?.ok ? '✓ ' + esc(S.app.agent.detail) : '✗ ' + esc(S.app.agent?.detail)}</p>
      <div class="grid2" style="margin-top:10px">
        <label>Provider</label><div><select class="sel" data-k="agent_provider" id="provSel">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${s.agent_provider === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          <div class="small muted">Powers chat, summaries, vocabulary and organising. Claude Code runs locally with your Claude login; the others are called with your API key.</div></div>
        <div class="cl-only" style="display:contents">
          ${f('agent_cmd', 'Agent command', 'The <code>claude</code> CLI, run headless with read-only tools (Read, Grep, Glob) inside this library’s data folder.')}
          ${f('chat_model', 'Chat model', 'Blank = your Claude Code default. Or e.g. <code>opus</code>, <code>sonnet</code>, <code>haiku</code>.', 'text', 160)}
          ${f('summary_model', 'Summary model', 'Batch summaries and organising. <code>sonnet</code> is a good speed/quality balance.', 'text', 160)}
          ${f('vocab_model', 'Vocabulary model', 'Defines the words you save. <code>haiku</code> is fast and cheap.', 'text', 160)}
        </div>
        <div class="api-only" style="display:contents">
          ${f('api_base', 'API base URL', 'OpenAI-compatible endpoint; <code>/chat/completions</code> is appended.', 'text', 360)}
          <label>API key</label><div><input class="inp" data-k="api_key" type="password" value="${esc(s.api_key)}" placeholder="sk-…" autocomplete="off" style="width:280px"><div class="small muted">Stored only in <code>data/settings.json</code> on this Mac; never shown again in full, never readable by the agent.</div></div>
          <label>Model</label><div><input class="inp" data-k="api_model" list="modelList" value="${esc(s.api_model)}" style="width:220px"><datalist id="modelList"></datalist><div class="small muted">Must support tool (function) calling. One model handles every task.</div></div>
          ${f('temperature', 'Temperature', 'Lower = more faithful to the papers. 0.2–0.4 suits literature work.', 'number', 80)}
        </div>
        <label>Custom instructions</label><div><textarea class="inp" data-k="custom_instructions" rows="3" placeholder="e.g. I study erythropoiesis; explain clinical terms; always flag sample sizes and statistics.">${esc(s.custom_instructions)}</textarea><div class="small muted">Added to the agent’s instructions for every chat, summary and task, with any provider.</div></div>
        ${f('answer_language', 'Answer language', 'e.g. “English”, “Chinese (Simplified)”, or “Same language as the question”.')}
        ${f('translate_to', 'Translate selections to', 'Also used for vocabulary translations.')}
        ${f('summary_concurrency', 'Parallel tasks', 'How many summaries or organising batches run at once.', 'number', 80)}
      </div>
      <div class="row" style="margin-top:12px"><button class="btn" id="testAgent">Save & test connection</button><span class="small muted" id="testOut"></span></div></div>
    <div class="card"><h3>Team sharing</h3>
      <div class="grid2">
        ${f('my_name', 'Your name', 'Shown on the notes you share. Blank = ' + esc(S.app.team?.name || 'your macOS name') + '.', 'text', 200)}
        <label>Team folder</label><div><div class="row" style="flex-wrap:nowrap"><input class="inp" data-k="team_dir" value="${esc(s.team_dir)}" placeholder="~/Dropbox/Lab papers" style="flex:1;min-width:0;max-width:420px"><button class="btn sm" id="pickTeam">Choose…</button></div>
          <div class="small muted">A folder everyone on the team syncs (Dropbox, OneDrive, Google Drive). Leave it blank to turn sharing off.${S.app.team?.detail ? ` <span style="color:var(--err)">${esc(S.app.team.detail)}</span>` : ''}</div></div>
      </div></div>
    <div class="card"><h3>NUS Libraries</h3>
      <div class="grid2">
        ${f('proxy_prefix', 'Proxy prefix', 'NUS EZproxy login prefix. Article URLs are appended to this.', 'text', 360)}
        ${f('browser_channel', 'Browser', '<code>chrome</code> uses your installed Google Chrome (separate profile). <code>chromium</code> needs <code>.venv/bin/playwright install chromium</code>.', 'text', 120)}
        ${f('delay_min', 'Delay between downloads (s)', 'Minimum…', 'number', 80)}
        ${f('delay_max', '', '…and maximum. Random pauses keep the proxy from flagging your account.', 'number', 80)}
        ${f('max_per_batch', 'Max papers per batch', '', 'number', 80)}
      </div></div>
    <div class="card"><h3>Discovery</h3>
      <div class="grid2">${f('openalex_mailto', 'OpenAlex contact email', 'Optional. OpenAlex gives faster, more reliable service to requests that include a contact email.', 'email')}</div></div>
    <div class="card"><h3>Appearance</h3>
      <div class="row">${['auto', 'light', 'dark'].map(t => `<label class="chk"><input type="radio" name="theme" value="${t}" ${store.get('theme', 'auto') === t ? 'checked' : ''}> ${t}</label>`).join('')}</div></div>
    <div class="card"><h3>Launching</h3>
      <p class="small muted">Open <b>My AI Drive</b> from Launchpad or Spotlight, or drag it from your Applications folder to the Dock. It starts the server in the background when needed and opens the app in its own window. The server keeps running after you close the window, so the next launch is instant.</p>
      <div class="row" style="margin-top:8px"><button class="btn danger" id="quitApp">Stop server</button></div></div>
    <div class="card"><h3>Where your files live</h3>
      <p class="small muted">Everything is local, in the <code>data/</code> folder next to this app: <code>papers/</code> (PDFs), <code>text/</code> (extracted full text the agent reads), <code>notes/</code>, <code>library.db</code>, and <code>browser_profile/</code> (your NUS login session — keep it private).</p></div>
  </div>`;
  $('#pickTeam').onclick = () => pickFolder($('[data-k="team_dir"]', c));
  $('[data-k="temperature"]', c).step = '0.1';
  const prov = $('#provSel'), base = $('[data-k="api_base"]', c), model = $('[data-k="api_model"]', c);
  const syncProv = (fill) => {
    const k = prov.value, d = PROVIDERS[k];
    $$('.cl-only', c).forEach(e => e.hidden = k !== 'claude');
    $$('.api-only', c).forEach(e => e.hidden = k === 'claude');
    $('#modelList').innerHTML = (d.models || []).map(m => `<option value="${m}">`).join('');
    const preset = v => Object.values(PROVIDERS).some(p => p.base === v || p.model === v);
    if (fill && d.base !== undefined) {  // switching provider: swap in its defaults unless the user typed their own
      if (!base.value || preset(base.value)) base.value = d.base;
      if (!model.value || preset(model.value)) model.value = d.model;
    }
  };
  prov.onchange = () => syncProv(true);
  syncProv(false);
  $('#testAgent').onclick = async () => {
    const out = $('#testOut');
    out.textContent = 'Testing…';
    try {
      await saveSettings();
      const r = await api('/api/agent/test', { method: 'POST' });
      out.innerHTML = `<span style="color:var(--ok)">✓ ${esc(r.detail)} replied “${esc(r.reply)}” in ${r.seconds}s</span>`;
    } catch (e) { out.innerHTML = `<span style="color:var(--err)">✗ ${esc(e.message)}</span>`; }
  };
  $('#quitApp').onclick = async () => {
    if (!await modal({ title: 'Stop the My AI Drive server?', body: 'Running summaries and downloads stop too. Open the app again to restart it.', ok: 'Stop', danger: true })) return;
    await api('/api/quit', { method: 'POST' }).catch(() => { });
    document.body.innerHTML = '<div class="empty" style="margin-top:20vh"><h3>My AI Drive has stopped</h3>You can close this window.</div>';
  };
  $$('input[name=theme]', c).forEach(r => r.onchange = () => { store.set('theme', r.value); if (r.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = r.value; });
  const saveSettings = async () => {
    const patch = {};
    $$('[data-k]', c).forEach(i => patch[i.dataset.k] = i.type === 'number' ? +i.value : i.value.trim());
    S.settings = await api('/api/settings', { method: 'PUT', body: patch });
    await refreshState();
  };
  $('#saveSet').onclick = async () => { try { await saveSettings(); toast('Settings saved'); renderCenter(); } catch (e) { fail(e); } };
}

// ---------- global wiring ----------
function wireGlobal() {
  $('#uploadBtn').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); importMenu(r.left, r.bottom + 4); };
  $('#fileInput').onchange = e => { uploadFiles(e.target.files, S.view === 'library' ? S.folder : ''); e.target.value = ''; };
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#askLibraryBtn').onclick = () => {
    if (S.view === 'library' && S.selected.size) return newChat({ type: 'papers', ids: [...S.selected] });
    if (S.view === 'library' && S.folder !== null) return newChat({ type: 'folder', path: S.folder });
    newChat({ type: 'all' });
  };
  $('#nusPill').onclick = () => go('discover');
  $('#agentPill').onclick = () => go('settings');

  let st;
  $('#globalSearch').oninput = e => {
    clearTimeout(st);
    st = setTimeout(async () => { setListCollapsed(false); S.q = e.target.value.trim(); if (S.view !== 'library') { S.view = 'library'; } await loadPapers(); renderAll(); }, 220);
  };
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.closest('input,textarea,[contenteditable]')) { e.preventDefault(); $('#globalSearch').focus(); }
    if (S.view === 'vocab' && S.review && [' ', '1', '2'].includes(e.key) && !e.target.closest('input,textarea,[contenteditable]')) { e.preventDefault(); return reviewKey(e.key); }
    if (e.key === 'Escape') { document.body.classList.remove('focus'); $('#selpop').hidden = true; $('#menu').hidden = true; }
    if (!e.target.closest('input,textarea,[contenteditable]') && S.view === 'library' && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
      const i = S.papers.findIndex(p => p.id === S.current);
      const n = S.papers[Math.max(0, Math.min(S.papers.length - 1, i + (['ArrowDown', 'j'].includes(e.key) ? 1 : -1)))];
      if (n) { e.preventDefault(); openPaper(n.id); $(`.prow[data-pid="${n.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
    }
  });

  // drag & drop PDF import
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer?.types?.includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; $('#dropTarget').textContent = S.view === 'library' && S.folder ? S.folder : 'Library'; $('#dropveil').classList.add('on'); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropveil').classList.remove('on'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropveil').classList.remove('on');
    uploadFiles(e.dataTransfer.files, S.view === 'library' ? S.folder : '');
  });

  // resizable preview
  const rz = $('#resizer');
  rz.onmousedown = e => {
    e.preventDefault(); rz.classList.add('drag');
    const move = ev => { const w = Math.max(340, Math.min(innerWidth - 560, innerWidth - ev.clientX)); document.documentElement.style.setProperty('--preview-w', w + 'px'); };
    const up = () => { rz.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('previewW', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-w'))); S.reader?.refit(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
}

boot().catch(fail);
