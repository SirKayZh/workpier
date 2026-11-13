'use strict';

/* ---------- 平台适配（Windows） ---------- */

const IS_WIN = window.api.platform === 'win32';
/** 快捷键提示文案：macOS ⌘ 系列 → Windows Ctrl 系列（⇧→Shift+、⌥→Alt+） */
function modHint(s) {
  if (!IS_WIN) return s;
  return String(s)
    .replace(/⌘⇧/g, 'Ctrl+Shift+')
    .replace(/⌘⌥/g, 'Ctrl+Alt+')
    .replace(/⌘/g, 'Ctrl+');
}

if (IS_WIN) {
  document.body.classList.add('win');
  // 静态 title / 文案里的 ⌘ 提示按平台替换
  document.querySelectorAll('[title*="⌘"]').forEach((el) => {
    el.title = modHint(el.title);
  });
  const tip = document.querySelector('.sb-tip');
  if (tip) tip.textContent = modHint(tip.textContent);
  // Windows 自绘窗口控制
  document.getElementById('wcMin').addEventListener('click', () => window.api.winControl('minimize'));
  document.getElementById('wcMax').addEventListener('click', () => window.api.winControl('maximize'));
  document.getElementById('wcClose').addEventListener('click', () => window.api.winControl('close'));
  // 工具栏双击最大化/还原（Windows 标题栏惯例）
  document.getElementById('toolbar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input')) return;
    window.api.winControl('maximize');
  });
}

const els = {
  list: document.getElementById('accountList'),
  berthBar: document.getElementById('berthBar'),
  empty: document.getElementById('empty'),
  back: document.getElementById('navBack'),
  fwd: document.getElementById('navFwd'),
  reload: document.getElementById('navReload'),
  home: document.getElementById('navHome'),
  star: document.getElementById('navStar'),
  marks: document.getElementById('navMarks'),
  url: document.getElementById('urlInput'),
  badge: document.getElementById('activeBadge'),
  addBtn: document.getElementById('btnAdd'),
  footer: document.getElementById('sbFooter'),
  tabbar: document.getElementById('tabbar'),
  tablist: document.getElementById('tablist'),
  tabNew: document.getElementById('tabNew'),
  banner: document.getElementById('banner'),
};

let state = {
  accounts: [],
  berths: [],
  activeBerthId: 'cloud',
  activeId: null,
  activeTabId: null,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  pending: null,
  sidebarCollapsed: false,
  crashRecovery: false,
  bookmarks: [],
  bookmarked: false,
};
let editing = false; // 添加/重命名进行中时跳过列表重渲染

window.api.onState((s) => {
  state = s;
  render();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeId) || null;
}

async function selectAccount(id) {
  await window.api.switch(id);
}

function render() {
  // collapsed class 必须先于 renderBerths 应用：限高（max-height）生效后 scrollIntoView 才有滚动语义
  document.body.classList.toggle('collapsed', !!state.sidebarCollapsed);
  renderToolbar();
  renderTabbar();
  renderBanner();
  renderBerths();
  if (!editing) renderList();
  const emptyVisible = state.accounts.length === 0;
  els.empty.style.display = emptyVisible ? 'flex' : 'none';
  if (emptyVisible) {
    // 空态文案跟随当前工作区
    const berth = state.berths.find((b) => b.id === state.activeBerthId);
    const h1 = els.empty.querySelector('h1');
    if (berth && h1) h1.textContent = `${berth.icon} ${berth.name}`;
  }
}

/* ---------- 工作区（Berth）下拉切换器 ----------
 * 这里只画触发器；下拉面板由主进程在网页视图之上开一个透明浮层（overlay.html）承载，
 * 所以面板可以自由伸出窄栏、盖住网页区，而网页区本身不位移。 */

let berthSig = '';
let berthDdOpen = false;

function renderBerths() {
  const sig = JSON.stringify([state.activeBerthId, state.berths.map((b) => [b.id, b.name]), berthDdOpen]);
  if (sig === berthSig && els.berthBar.childElementCount > 0) return;
  berthSig = sig;
  els.berthBar.innerHTML = '';
  const current = state.berths.find((b) => b.id === state.activeBerthId) ?? state.berths[0];
  if (!current) return;

  const dd = document.createElement('button');
  dd.className = 'berth-dd' + (berthDdOpen ? ' open' : '');
  dd.title = `工作区：${current.name}`;
  dd.innerHTML = `<span class="berth-dd-name">${escapeHtml(current.name)}</span><svg class="berth-dd-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  dd.addEventListener('click', () => {
    const r = dd.getBoundingClientRect();
    window.api.berthPanelToggle({ x: r.left, y: r.top, w: r.width, h: r.height });
  });
  els.berthBar.appendChild(dd);
}

window.api.onBerthPanel((open) => {
  berthDdOpen = open;
  berthSig = '';
  renderBerths();
});

let tabSig = '';
/** 正在拖的标签。拖的过程中不重建标签栏，否则落点会丢。 */
let dragTabId = null;

function clearTabDropMarks() {
  els.tablist.querySelectorAll('.drop-before,.drop-after').forEach((el) => {
    el.classList.remove('drop-before');
    el.classList.remove('drop-after');
  });
}

async function commitTabReorder(targetId, before) {
  const acc = activeAccount();
  if (!dragTabId || !acc) return;
  const ids = acc.tabs.map((t) => t.id);
  const from = ids.indexOf(dragTabId);
  if (from < 0) return;
  ids.splice(from, 1);
  let at = ids.length;
  if (targetId && targetId !== dragTabId) {
    const ti = ids.indexOf(targetId);
    if (ti >= 0) at = before ? ti : ti + 1;
  }
  ids.splice(at, 0, dragTabId);
  const old = acc.tabs.map((t) => t.id).join(',');
  if (ids.join(',') !== old) await window.api.reorderTabs(ids);
}

function renderTabbar() {
  const acc = activeAccount();
  els.tabbar.style.display = acc ? 'flex' : 'none';
  if (!acc) {
    tabSig = '';
    return;
  }
  if (dragTabId) return;
  // 签名未变则不重建 DOM：页面加载过程中状态推送很频繁，
  // 重建会让 mousedown→mouseup 之间的点击丢失
  const sig = JSON.stringify([acc.id, state.activeTabId, acc.tabs.map((t) => [t.id, t.title, t.url])]);
  if (sig === tabSig) return;
  tabSig = sig;
  els.tablist.innerHTML = '';
  let activeEl = null;
  acc.tabs.forEach((tab) => {
    const el = document.createElement('div');
    const isActive = tab.id === state.activeTabId;
    el.className = 'tab' + (isActive ? ' active' : '');
    const title = tab.title || '新标签页';
    el.innerHTML = `
      <span class="tab-title" title="${escapeHtml(tab.url || '')}">${escapeHtml(title)}</span>
      <span class="tab-close" title="${modHint('关闭 (⌘W)')}">✕</span>`;
    // 与 Chrome 一致：mousedown 即切换；关闭按钮用 click
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.classList.contains('tab-close')) return;
      window.api.switchTab(tab.id);
    });
    let blockDrag = false;
    el.querySelector('.tab-close').addEventListener('mousedown', () => { blockDrag = true; });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.closeTab(tab.id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) window.api.closeTab(tab.id);
    });
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      if (blockDrag) {
        blockDrag = false;
        e.preventDefault();
        return;
      }
      dragTabId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tab.id); } catch (_) { /* 部分环境不允许自定义数据 */ }
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearTabDropMarks();
      dragTabId = null;
      tabSig = '';
      renderTabbar();
    });
    el.addEventListener('dragover', (e) => {
      if (!dragTabId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      clearTabDropMarks();
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      commitTabReorder(tab.id, before);
    });
    els.tablist.appendChild(el);
    if (isActive) activeEl = el;
  });
  // tab 很多时保证活跃 tab 可见
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

els.tablist.addEventListener('dragover', (e) => {
  if (!dragTabId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
els.tablist.addEventListener('drop', (e) => {
  if (e.target !== els.tablist) return;
  e.preventDefault();
  commitTabReorder(null, false);
});

let bannerSig = '';

function renderBanner() {
  const p = state.pending;
  // 优先级：保存密码提示 > 崩溃恢复横幅（两者不会同时出现：横幅只在未恢复会话时显示）
  const recovery = !p && state.crashRecovery;
  const sig = JSON.stringify(p) + (recovery ? '|R' : '');
  if (sig === bannerSig) return;
  bannerSig = sig;
  if (!p && !recovery) {
    els.banner.style.display = 'none';
    els.banner.innerHTML = '';
    return;
  }
  if (recovery) {
    els.banner.style.display = 'flex';
    els.banner.classList.remove('update');
    els.banner.innerHTML = `
      <span class="bn-icon">⚠️</span>
      <span class="bn-text">
        <span class="bn-title">WorkPier 上次未正常退出</span>
        <span class="bn-sub">是否恢复上次打开的账号与标签页？（登录态不受影响）</span>
      </span>
      <button class="btn primary" id="bnRestore">恢复上次会话</button>
      <button class="btn ghost" id="bnFresh">重新开始</button>`;
    els.banner.querySelector('#bnRestore').addEventListener('click', () => window.api.resolveCrash(true));
    els.banner.querySelector('#bnFresh').addEventListener('click', () => window.api.resolveCrash(false));
    return;
  }
  const acc = state.accounts.find((a) => a.id === p.accountId);
  const name = acc ? acc.name : '该账号';
  els.banner.style.display = 'flex';
  els.banner.classList.toggle('update', !!p.update);
  els.banner.innerHTML = `
    <span class="bn-icon">🔑</span>
    <span class="bn-text">
      <span class="bn-title">${p.update ? '检测到新密码，是否更新已保存的密码？' : '是否保存此登录的密码？'}</span>
      <span class="bn-sub">${escapeHtml(p.host)} · ${escapeHtml(p.label)} · 账号「${escapeHtml(name)}」· 加密存于本机</span>
    </span>
    <button class="btn primary" id="bnSave">${p.update ? '更新密码' : '保存密码'}</button>
    <button class="btn ghost" id="bnLater">暂不</button>
    <button class="btn link" id="bnNever">从不保存此网站</button>`;
  els.banner.querySelector('#bnSave').addEventListener('click', () => window.api.credSave());
  els.banner.querySelector('#bnLater').addEventListener('click', () => window.api.credDismiss(false));
  els.banner.querySelector('#bnNever').addEventListener('click', () => window.api.credDismiss(true));
}

function renderToolbar() {
  els.back.disabled = !state.canGoBack;
  els.fwd.disabled = !state.canGoForward;
  els.star.disabled = !state.url;
  els.star.classList.toggle('on', !!state.bookmarked);
  els.star.title = modHint(state.bookmarked ? '取消收藏 (⌘D)' : '收藏此页 (⌘D)');
  if (document.activeElement !== els.url) {
    els.url.value = state.url;
  }
  const acc = activeAccount();
  if (acc) {
    const dot = `<span class="dot" style="background:${acc.color}"></span>`;
    const spin = state.isLoading ? '<span class="spin">⟳</span>' : '';
    els.badge.innerHTML = `${dot}<span>${escapeHtml(acc.name)}</span>${spin}`;
  } else {
    els.badge.innerHTML = '<span class="badge-none">未选择账号</span>';
  }
}

let listSig = '';
/** 拖拽排序状态：正在拖的账号 id + 落点上/下半标记 */
let dragAccId = null;

function clearDropMarks() {
  els.list.querySelectorAll('.drop-before,.drop-after').forEach((el) => {
    el.classList.remove('drop-before');
    el.classList.remove('drop-after');
  });
}

/** 计算新顺序并提交主进程（orderedIds 必须是当前区可见账号的完整列表） */
async function commitReorder(targetId, before) {
  if (!dragAccId) return;
  const dragId = dragAccId;
  const ids = state.accounts.map((a) => a.id);
  const from = ids.indexOf(dragId);
  if (from < 0) return;
  ids.splice(from, 1);
  let at = ids.length; // 无明确落点（拖到列表空白处）→ 追加到末尾
  if (targetId && targetId !== dragId) {
    const ti = ids.indexOf(targetId);
    if (ti >= 0) at = before ? ti : ti + 1;
  }
  ids.splice(at, 0, dragId);
  const old = state.accounts.map((a) => a.id).join(',');
  if (ids.join(',') !== old) await window.api.reorder(ids);
}

function renderList() {
  // 签名未变则不重建，避免页面加载期间的频繁状态推送吞掉点击
  const sig = JSON.stringify([state.activeId, state.accounts.map((a) => [a.id, a.name, a.note, a.color])]);
  if (sig === listSig && els.list.childElementCount > 0) return;
  listSig = sig;
  els.list.innerHTML = '';
  state.accounts.forEach((acc, i) => {
    const item = document.createElement('div');
    item.className = 'acc-item' + (acc.id === state.activeId ? ' active' : '');
    const hint = i < 9 ? `<span class="acc-hint">${modHint(`⌘${i + 1}`)}</span>` : '';
    item.innerHTML = `
      <span class="acc-avatar" title="${escapeHtml(acc.name)}" style="background:${acc.color}">${escapeHtml(acc.name.slice(0, 1).toUpperCase())}</span>
      <span class="acc-label">${escapeHtml(acc.name)}</span>
      <span class="acc-info">
        <span class="acc-name" title="双击重命名">${escapeHtml(acc.name)}</span>
        ${acc.note ? `<span class="acc-note">${escapeHtml(acc.note)}</span>` : ''}
      </span>
      ${hint}
      <span class="acc-more" title="更多：重命名 / 清除 Cookie">•••</span>
      <span class="acc-del" title="删除账号">✕</span>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('acc-del') || e.target.classList.contains('acc-more')) return;
      if (editing) return; // 正在改名时点击不要切换账号（切换会把焦点抢给网页）
      selectAccount(acc.id);
    });
    item.querySelector('.acc-more').addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.accountMenu(acc.id);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.api.accountMenu(acc.id);
    });
    item.querySelector('.acc-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.remove(acc.id);
    });
    item.querySelector('.acc-name').addEventListener('dblclick', () => startRename(item, acc));
    // 拖拽排序：HTML5 DnD，落点按上/下半判定插前/插后
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      dragAccId = acc.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', acc.id); } catch (_) { /* Safari 老版本兜底 */ }
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      clearDropMarks();
      dragAccId = null;
    });
    item.addEventListener('dragover', (e) => {
      if (!dragAccId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      clearDropMarks();
      item.classList.add(before ? 'drop-before' : 'drop-after');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      commitReorder(acc.id, before);
    });
    els.list.appendChild(item);
  });
  // 拖到列表空白处 = 追加到末尾
  els.list.addEventListener('dragover', (e) => {
    if (!dragAccId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  els.list.addEventListener('drop', (e) => {
    e.preventDefault();
    commitReorder(null, false);
  });
}

async function startRename(item, acc) {
  if (editing) return;
  const nameEl = item.querySelector('.acc-name');
  if (!nameEl) return;
  editing = true;
  // 窄栏下名称是隐藏的，改名时临时展开显示输入框
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = acc.name;
  input.maxLength = 30;
  input.setAttribute('spellcheck', 'false');
  nameEl.replaceWith(input);
  item.classList.add('renaming');
  let closed = false;
  let composing = false; // 输入法组字中：Enter/Esc/失焦都不能当作确认
  const done = async (save) => {
    if (closed) return;
    closed = true;
    editing = false;
    const v = input.value.trim();
    item.classList.remove('renaming');
    if (input.isConnected) input.replaceWith(nameEl);
    if (save && v && v !== acc.name) await window.api.rename(acc.id, v);
    listSig = ''; // 强制刷新列表
    render();
  };
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // keyCode 229 = 输入法处理中的按键（部分环境 isComposing 在 compositionend 之后的那一下已为 false）
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => {
    if (composing) return;
    done(true);
  });
  // 先把键盘焦点从网页视图拿回 UI 页面，再聚焦输入框，输入法才会接管
  await window.api.focusUi();
  if (closed) return;
  input.focus();
  input.select();
}

/** 添加账号：无需输入，新建独立会话并打开起始页；登录任意网站后自动按用户名/站点命名 */
async function addAccount() {
  await window.api.add();
}

/* ---------- 事件绑定 ---------- */

els.addBtn.addEventListener('click', addAccount);
document.getElementById('btnAddEmpty').addEventListener('click', addAccount);
els.tabNew.addEventListener('click', () => window.api.newTab());
els.back.addEventListener('click', () => window.api.nav('back'));
els.fwd.addEventListener('click', () => window.api.nav('forward'));
els.reload.addEventListener('click', () => window.api.nav('reload'));
els.home.addEventListener('click', () => window.api.nav('home'));
els.star.addEventListener('click', () => window.api.toggleBookmark());
els.marks.addEventListener('click', () => {
  const r = els.marks.getBoundingClientRect();
  window.api.bookmarkPanelToggle({ x: r.left, y: r.top, w: r.width, h: r.height });
});
window.api.onBookmarkPanel((open) => {
  els.marks.classList.toggle('on', open);
});
document.getElementById('sbToggle').addEventListener('click', () => window.api.toggleSidebar());

// 主菜单 / 右键菜单的「重命名」
window.api.onRenameStart((id) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc || editing) return;
  const idx = state.accounts.indexOf(acc);
  const item = els.list.children[idx];
  if (!item) return;
  // 窄栏下名称不可见，改名前临时展开侧边栏
  const go = () => startRename(item, acc);
  if (state.sidebarCollapsed) {
    window.api.toggleSidebar(false).then(() => setTimeout(go, 80));
  } else {
    go();
  }
});

els.url.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return; // 输入法选词时的 Enter 不是「前往」
  if (e.key === 'Enter') {
    window.api.openUrl(els.url.value.trim());
    els.url.blur();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && /^Digit[1-9]$/.test(e.code)) {
    const acc = state.accounts[Number(e.code.slice(5)) - 1];
    if (acc) {
      e.preventDefault();
      selectAccount(acc.id);
    }
  }
});

/* ---------- 初始化 ---------- */

// 上次使用的账号由主进程恢复（ui.json），渲染端只负责首屏渲染
(async function init() {
  const list = await window.api.list();
  if (state.accounts.length === 0) state.accounts = list;
  render();
})();
