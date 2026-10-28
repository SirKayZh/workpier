import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  shell,
  Menu,
  dialog,
  crashReporter,
  clipboard,
  shell as systemShell,
} from 'electron';
import type { Rectangle, WebContents, Session, MenuItemConstructorOptions } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as dns from 'node:dns';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Account, AppState, Berth, CapturedLogin, FillPayload, PendingSave, Tab } from './types';
import {
  PALETTE,
  DEFAULT_BERTH_ID,
  berthOfAccount,
  sanitizeBerth,
  hostnameOf,
  registrableDomain,
  siteLabel,
  homeFor,
  resolveInput,
  isHttpUrl,
  sanitizeAccount,
  reorderAccountsInBerth,
  findbarAnchor,
} from './pure';
import { vault } from './vaultClient';
import { checkForUpdatesInteractive, checkForUpdatesOnLaunch, updateTokenFromArgv, reconcilePendingUpdate } from './updater';

/*
 * 通用多账号浏览器：账号 = 一个独立会话容器，可登录任意网站。
 * Tab.url 为空字符串 = 内置「起始页」(start.html)：输入网址或点常用站点即可开始。
 */
function startUrl(): string {
  return pathToFileURL(path.join(__dirname, '..', 'start.html')).href;
}
function isStartUrl(u: string): boolean {
  return u.startsWith(startUrl().split('?')[0]);
}
/** 新账号在识别到登录身份之前的占位备注 */
const PENDING_NOTE = '登录后自动识别账号';

const SIDEBAR_W = 232;
/** 收起后的窄栏宽度（只显示头像，须容纳 macOS 红绿灯；与 index.html body.collapsed 一致） */
const RAIL_W = 88;
/** Windows：自绘标题栏模式（titleBarStyle hidden + renderer 自绘最小化/最大化/关闭） */
const IS_WIN = process.platform === 'win32';
const TOPBAR_H = 52;
const TABBAR_H = 36;
/** 「保存登录信息」提示条 / 「恢复会话」横幅高度（与 index.html #banner 一致） */
const BANNER_H = 56;

interface BerthAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个窗口里某账号的标签。主窗口不单独存，直接用账号上的 tabs。 */
interface TabBag {
  tabs: Tab[];
  activeTabId: string | null;
}

/**
 * 一个软件窗口。
 * 网页视图只能挂在一个窗口上，所以每个窗口自己持有视图和标签；
 * 账号、Cookie、密码库仍然全局共用（同一账号在两个窗口里都是登录态）。
 */
interface Shell {
  win: BrowserWindow;
  /** 第一个窗口。它的标签写在账号上，退出后还能恢复。后开的窗口各自记一份。 */
  primary: boolean;
  activeId: string | null;
  activeBerthId: string;
  berthActive: Record<string, string>;
  sidebarCollapsed: boolean;
  localTabs: Map<string, TabBag>;
  views: Map<string, WebContentsView>;
  berthOverlay: WebContentsView | null;
  berthOverlayOpen: boolean;
  berthOverlayAnchor: BerthAnchor;
  findbar: WebContentsView | null;
  findbarOpen: boolean;
  findText: string;
  /** 新窗口第一次显示时要打开的账号；主窗口不用 */
  bootAccountId: string | null;
  /** 新窗口第一张标签的地址。空串 = 起始页 */
  bootUrl: string;
}

const shells: Shell[] = [];

/** 窗口创建前从 ui.json 读入的记忆。主窗口起来之后以窗口上的值为准。 */
let bootSidebarCollapsed = false;
let bootBerthId = DEFAULT_BERTH_ID;
let bootBerthActive: Record<string, string> = {};

function aliveShells(): Shell[] {
  return shells.filter((s) => !s.win.isDestroyed());
}

function primaryShell(): Shell | null {
  return aliveShells().find((s) => s.primary) ?? null;
}

/** 菜单快捷键、程序坞动作：落在当前最前的窗口；没有焦点时用主窗口 */
function focusedShell(): Shell | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    const hit = shells.find((s) => s.win === focused && !s.win.isDestroyed());
    if (hit) return hit;
  }
  return primaryShell() ?? aliveShells()[0] ?? null;
}

let accounts: Account[] = [];

/* ---------- 工作区（Berth） ---------- */

let berths: Berth[] = [];

function berthsFile(): string {
  return path.join(app.getPath('userData'), 'berths.json');
}

/** 当前工作区的 id 集合（判定 berthId 有效性：已删工作区的账号归默认区） */
function berthIds(): Set<string> {
  return new Set(berths.map((b) => b.id));
}

/** 当前工作区可见账号（sendState / ⌘1-9 / 菜单 / 预热的统一口径） */
function visibleAccounts(shell: Shell): Account[] {
  const ids = berthIds();
  return accounts.filter((a) => berthOfAccount(a, ids) === shell.activeBerthId);
}

function saveBerthsNow(): void {
  try {
    const file = berthsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(berths, null, 2));
  } catch (err) {
    console.error('[workpier] save berths failed:', err);
  }
}

function loadBerths(): void {
  let loaded: Berth[] = [];
  try {
    const data: unknown = JSON.parse(fs.readFileSync(berthsFile(), 'utf-8'));
    if (Array.isArray(data)) loaded = data.map(sanitizeBerth).filter((b): b is Berth => b !== null);
  } catch {
    /* 首次运行无文件 */
  }
  // 默认区永远在列（老账号的归宿）；磁盘数据缺失/损坏时重建
  const fresh = !loaded.some((b) => b.id === DEFAULT_BERTH_ID);
  if (fresh) {
    loaded.unshift({ id: DEFAULT_BERTH_ID, name: '云账号', icon: '☁️', createdAt: 0 });
  }
  berths = loaded;
  const ids = berthIds();
  if (!ids.has(bootBerthId)) bootBerthId = DEFAULT_BERTH_ID;
  // 首启/损坏重建后立即落盘：berths.json 从第一次运行起就存在（否则不动工作区就永远不生成）
  if (fresh || !fs.existsSync(berthsFile())) saveBerthsNow();
}

/* ---------- 测试支持：自定义数据目录 ---------- */
if (process.env.WORKPIER_DATA_DIR) {
  app.setPath('userData', process.env.WORKPIER_DATA_DIR);
}

/*
 * ---------- v2.0 改名迁移：CloudDock → WorkPier（一次性，幂等） ----------
 * userData 目录名随 package.json 的 productName 变化（Electron 规则），老用户升级 v2.0 后
 * 首启把整个旧目录原地 rename 过来（同卷 O(1)），accounts.json / credentials.json /
 * Partitions（各账号会话）全部随迁。
 * 注意：Chromium 在 main.js 执行前就可能建好新目录的 profile 骨架（Cache/Singleton 等），
 * 因此不能用「新目录不存在」判定首启——以 accounts.json 的存在性为准；
 * 迁移动作 = 骨架挪 temp + 旧目录整体 rename + relaunch 干净重启（updater 同款先例），
 * 避免在已初始化的 profile 上原地改名的中程状态风险。失败不阻塞启动：数据留在原目录，
 * 下次启动按同一判定自动重试。
 */
if (!process.env.WORKPIER_DATA_DIR) {
  try {
    const appData = app.getPath('appData');
    const legacyDir = path.join(appData, 'CloudDock');
    const newDir = path.join(appData, 'WorkPier');
    /*
     * 防误迁保护（2026-10-22 事故修复）：曾出现 WorkPier 目录意外缺失后，
     * 仅剩一个测试账号的 CloudDock 残迹被当作「历史数据」整体搬入，真实数据二次丢失。
     * 新规则：WorkPier 侧只要存在任一 v2 特征文件（accounts/berths/credentials/ui）即视为
     * 「已升级过，绝不迁移」；CloudDock 侧必须读到真实账号才可迁；迁移前先把 legacy 完整
     * 复制备份到 temp（防 rename 中途失败丢数据）。
     */
    const v2Signals = ['accounts.json', 'berths.json', 'credentials.json', 'ui.json']
      .map((n) => path.join(newDir, n))
      .filter((p) => fs.existsSync(p));
    let legacyHasAccounts = false;
    try {
      const legacyAcc = JSON.parse(fs.readFileSync(path.join(legacyDir, 'accounts.json'), 'utf-8'));
      legacyHasAccounts = Array.isArray(legacyAcc) && legacyAcc.length > 0;
    } catch {
      legacyHasAccounts = false;
    }
    if (legacyHasAccounts && v2Signals.length === 0 && !fs.existsSync(path.join(newDir, 'accounts.json'))) {
      if (fs.existsSync(newDir)) {
        const trash = path.join(app.getPath('temp'), `workpier-skeleton-${Date.now()}`);
        fs.renameSync(newDir, trash);
        console.log(`[workpier] 新目录 profile 骨架已挪至 ${trash}（交由系统 tmp 清理）`);
      }
      fs.renameSync(legacyDir, newDir);
      console.log(`[workpier] 已迁移历史数据目录: ${legacyDir} -> ${newDir}，relaunch 干净重启`);
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    console.error('[workpier] 历史数据目录迁移失败（数据保留在原目录，下次启动重试）:', err);
  }
}

// 凭据加密不再使用 Chromium 的钥匙串条目（"CloudDock Safe Storage"，授权绑定 ad-hoc 签名，每次更新都会重新弹框），
// 声明 mock 钥匙串，确保 Chromium 任何内部路径都不会触发钥匙串授权弹窗。
app.commandLine.appendSwitch('use-mock-keychain');

/* ---------- 崩溃收集（crashpad）与异常退出检测 ---------- */
/*
 *  - crashReporter：主/渲染进程崩溃时由 Chromium 内建 crashpad 落 minidump 到
 *    app.getPath('crashDumps')；不上传（无服务器），仅本地留存，启动时只保留最近 5 份
 *  - running.flag：应用存活标记。启动即写、正常退出（before-quit/will-quit）删除；
 *    下次启动发现标记仍在 = 上次是崩溃/强杀，进入「恢复会话询问」流程（Chrome 同款横幅）
 */
crashReporter.start({
  submitURL: '',
  uploadToServer: false,
  compress: true,
  globalExtra: { version: app.getVersion(), platform: process.platform },
});

function runningFlagFile(): string {
  return path.join(app.getPath('userData'), 'running.flag');
}
/** 更新启动参数（--workpier-update-token <file>，v1.x 老进程传 --clouddock-update-token，均识别）：非空表示本次由更新流程拉起（须先于 crashedLastRun 判定） */
const updateToken = updateTokenFromArgv(process.argv);
/**
 * 上次是否异常退出（模块加载时判定一次，全程不变）。
 * 更新启动时老实例还没来得及删标记（它在等我们握手），此时标记在不算崩溃。
 */
const crashedLastRun = fs.existsSync(runningFlagFile()) && !updateToken;
/** 用户尚未对「恢复上次会话」做出选择（true 时渲染层显示恢复横幅，不自动恢复标签页） */
let crashRecoveryPending = false;

/** 只保留最近 5 份崩溃转储，避免长期使用磁盘堆积 */
function pruneCrashDumps(): void {
  try {
    const dir = app.getPath('crashDumps');
    const dumps = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.dmp'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dumps.slice(5)) fs.rmSync(path.join(dir, d.name), { force: true });
  } catch {
    /* 目录不存在：首次运行，无需清理 */
  }
}

/* ---------- 持久化 ---------- */

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function uiFile(): string {
  return path.join(app.getPath('userData'), 'ui.json');
}

/** 原子写：先写临时文件再 rename，避免崩溃/断电写一半导致账号列表损坏丢失 */
function writeFileAtomic(file: string, content: string, mode?: number): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, mode === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', mode });
  fs.renameSync(tmp, file);
}

function saveUiNow(): void {
  try {
    const p = primaryShell();
    // 主窗口还没起来、或已经关掉：不要用空状态覆盖上次记住的账号
    if (!p) return;
    const file = uiFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // activeId 为空时沿用已读到的上次值，避免只切侧边栏就丢了「上次账号」
    writeFileAtomic(
      file,
      JSON.stringify({
        activeId: p.activeId ?? savedActiveId,
        sidebarCollapsed: p.sidebarCollapsed,
        activeBerthId: p.activeBerthId,
        berthActive: p.berthActive,
      }),
    );
  } catch (err) {
    console.error('[workpier] save ui failed:', err);
  }
}

let uiSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** UI 状态落盘去抖（500ms 合并）：切换工作区/收起侧栏的热路径不同步写盘。
 * quit 有兜底：before-quit → saveAccountsNow → saveUiNow。 */
function scheduleUiSave(): void {
  if (uiSaveTimer) return;
  uiSaveTimer = setTimeout(() => {
    uiSaveTimer = null;
    saveUiNow();
  }, 500);
}

function saveAccountsNow(): void {
  try {
    const file = accountsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(accounts, null, 2));
    saveUiNow();
  } catch (err) {
    console.error('[workpier] save failed:', err);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
/** 防抖保存（页面导航/标题变化频繁触发） */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAccountsNow();
  }, 500);
}

/** 对磁盘读入的数据做结构/类型校验（实现见 pure.ts，可单测） */

let savedActiveId: string | null = null;

function loadAccounts(): void {
  const file = accountsFile();
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(data)) {
      accounts = data.map(sanitizeAccount).filter((a): a is Account => a !== null);
    }
  } catch (err) {
    accounts = [];
    // 文件存在但解析失败：备份损坏文件，避免下次保存时被空列表覆盖而永久丢失
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      console.error('[workpier] accounts.json 解析失败，已备份:', err);
    }
  }
  for (const acc of accounts) ensureAccountTabs(acc);
  try {
    const ui: unknown = JSON.parse(fs.readFileSync(uiFile(), 'utf-8'));
    const id = (ui as { activeId?: unknown }).activeId;
    savedActiveId = typeof id === 'string' ? id : null;
    bootSidebarCollapsed = (ui as { sidebarCollapsed?: unknown }).sidebarCollapsed === true;
    const berth = (ui as { activeBerthId?: unknown }).activeBerthId;
    if (typeof berth === 'string' && berth.length > 0) bootBerthId = berth;
    const mem = (ui as { berthActive?: unknown }).berthActive;
    if (mem && typeof mem === 'object' && !Array.isArray(mem)) {
      for (const [k, v] of Object.entries(mem as Record<string, unknown>)) {
        if (typeof v === 'string') bootBerthActive[k] = v;
      }
    }
  } catch {
    savedActiveId = null;
  }
}

/** 选一个当前使用最少的配色，避免删除账号后颜色重复 */
function pickColor(): string {
  const used = new Map<string, number>();
  for (const a of accounts) used.set(a.color, (used.get(a.color) ?? 0) + 1);
  return PALETTE.reduce((best, c) => ((used.get(c) ?? 0) < (used.get(best) ?? 0) ? c : best), PALETTE[0]);
}

/* ---------- 密码管理（行为对齐 Chrome） ---------- */
/*
 *  - 任意网站登录成功后询问「保存 / 更新密码」，可选「从不保存此网站」
 *  - 已保存的网站再次打开登录页时自动填充（同一网站多个用户名时填最近使用的）
 *  - 凭据按「账号(会话分区) + 网站 origin + 用户名」存储：账号之间互不可见；只会填充到与保存时完全相同 origin 的页面/iframe
 *  - 安全（Chrome helper 最小权限进程模型的移植）：
 *      * 主密钥与 AES-256-GCM 加解密全部在 utilityProcess（vaultChild）内，
 *        密钥/明文/密文都不进主进程内存；
 *      * 主进程只持有非敏感元数据镜像（站点、用户名展示、更新时间）用于菜单展示；
 *      * 子进程不可用时密码保存/填充整体禁用，绝不明文落盘；
 *      * 密码永不下发到界面进程
 *  - 管理入口：菜单「密码」（查看/删除/恢复提示），不占用主界面
 */

/** 与 Chrome 一致：http/https 页面均可；以 origin（协议+主机+端口）精确绑定 */
function credOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 从不保存此网站（元数据在主进程镜像中，同步判断即可） */
function isNever(accountId: string, origin: string): boolean {
  return vault.never.some((n) => n.accountId === accountId && n.origin === origin);
}

interface RawPending {
  accountId: string;
  login: CapturedLogin;
  origin: string;
  /** 非空 = 同一用户名已有保存记录，本次是更新密码 */
  existingId: string | null;
  tabId: string;
  ts: number;
  /** 登录页发生导航后才置 true（视为登录成功），此时才向用户展示保存提示 */
  armed: boolean;
}
/** 按账号各存一份：两个账号同时登录时互不覆盖对方的保存提示 */
const pendings = new Map<string, RawPending>();
/** 最近一次登录表单提交的用户名：登录页跳转后用于给账号自动命名 */
let loginHint: { accountId: string; tabId: string; label: string; host: string; ts: number } | null = null;
/**
 * 等待登录成功的最长时间（有滑块/短信二次验证的站点会久一些）。
 * 期间页面还在输入（input 心跳）会不断顺延，见 keepPendingAlive。
 */
const PENDING_TTL = 120_000;

/** webContents.id -> 所属窗口/账号/标签（用于校验 IPC 发送方） */
const wcMap = new Map<number, { shell: Shell; acc: Account; tab: Tab }>();

function shellByWebContents(wc: WebContents): Shell | null {
  for (const s of shells) {
    if (s.win.isDestroyed()) continue;
    if (s.win.webContents === wc) return s;
    if (s.berthOverlay?.webContents === wc) return s;
    if (s.findbar?.webContents === wc) return s;
  }
  return wcMap.get(wc.id)?.shell ?? null;
}

/** 这个窗口里该账号的标签袋。主窗口就是账号自己；后开的窗口单独一份。 */
function bag(shell: Shell, acc: Account): TabBag {
  if (shell.primary) return acc;
  let local = shell.localTabs.get(acc.id);
  if (!local) {
    local = { tabs: [], activeTabId: null };
    shell.localTabs.set(acc.id, local);
  }
  return local;
}

/** 发给界面的账号列表：后开的窗口换成自己的标签，不改账号磁盘数据 */
function projectAccounts(shell: Shell): Account[] {
  return visibleAccounts(shell).map((acc) => {
    if (shell.primary) return acc;
    const local = shell.localTabs.get(acc.id);
    return { ...acc, tabs: local?.tabs ?? [], activeTabId: local?.activeTabId ?? null };
  });
}

function sidebarW(shell: Shell): number {
  return shell.sidebarCollapsed ? RAIL_W : SIDEBAR_W;
}

function credLabel(fields: string[]): string {
  return fields.filter(Boolean).join(' / ').slice(0, 120);
}

async function onCaptured(wcId: number, frameUrl: string | undefined, raw: unknown): Promise<void> {
  const ctx = wcMap.get(wcId);
  if (!ctx || !accounts.includes(ctx.acc)) return;
  const origin = credOrigin(frameUrl);
  if (!origin) return;
  const r = raw as Partial<CapturedLogin> | null;
  if (!r || !Array.isArray(r.fields) || typeof r.password !== 'string') return;
  const fields = r.fields.filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, 200));
  if (fields.length === 0 || fields.length > 5 || !r.password || r.password.length > 256) return;

  // 用提交的用户名给账号自动命名（与是否保存密码无关；真正登录成功要等页面跳转，见 armPending）
  loginHint = { accountId: ctx.acc.id, tabId: ctx.tab.id, label: credLabel(fields), host: hostOf(origin), ts: Date.now() };

  if (!vault.available || isNever(ctx.acc.id, origin)) return;

  // 同一用户名已有记录？密码也相同 → 不打扰；密码不同 → 提示「更新」（去重比较在 vault 子进程内完成）
  const dedup = await vault.dedup(ctx.acc.id, origin, fields, r.password);
  if (!dedup) return; // 子进程超时/不可用：当作未保存，不打扰
  if (dedup.same) return;
  const existingId = dedup.existingId;
  if (!accounts.includes(ctx.acc)) return; // 等待期间账号可能被删除

  const prev = pendings.get(ctx.acc.id) ?? null;
  const hadBanner = !!prev?.armed;
  // 提示已展示且是同一次登录（同一份凭据）→ 保留原记录，用户没点之前不重置、不重复弹
  if (
    hadBanner &&
    prev &&
    prev.origin === origin &&
    prev.login.password === r.password &&
    prev.login.fields.join('\u0001') === fields.join('\u0001')
  ) {
    return;
  }
  pendings.set(ctx.acc.id, {
    accountId: ctx.acc.id,
    login: { fields, password: r.password },
    origin,
    existingId,
    tabId: ctx.tab.id,
    ts: Date.now(),
    armed: false,
  });
  if (hadBanner) {
    layoutAll();
    sendStateAll();
  }
}

/** tabId 全局唯一：在所有账号的待确认捕获里找属于这个 tab 的那条 */
function findUnarmedByTab(tabId: string): RawPending | null {
  for (const p of pendings.values()) {
    if (!p.armed && p.tabId === tabId) return p;
  }
  return null;
}

/** 登录页发生导航 = 很可能登录成功，此时再弹提示（输错密码的页面通常不会跳转） */
function armPending(tabId: string): void {
  if (loginHint && loginHint.tabId === tabId) {
    const h = loginHint;
    loginHint = null;
    const acc = accounts.find((a) => a.id === h.accountId);
    if (acc && Date.now() - h.ts <= PENDING_TTL && h.label) {
      applyAutoName(acc, 'login', h.label, registrableDomain(h.host.replace(/:\d+$/, '')));
    }
  }
  const hit = findUnarmedByTab(tabId);
  if (!hit) return;
  // 距上次输入/提交太久 = 用户已放弃这次登录，之后的普通跳转不能误触发保存提示
  if (Date.now() - hit.ts > PENDING_TTL) {
    pendings.delete(hit.accountId);
    return;
  }
  hit.armed = true;
  hit.ts = Date.now();
  const front = focusedShell();
  if (front && !front.win.isFocused() && process.platform === 'darwin') app.dock?.bounce('informational');
  layoutAll();
  sendStateAll();
}

/** 页面还在输入（登录页 input 事件）：顺延等待窗口，覆盖滑块/短信二次验证这类耗时流程 */
function keepPendingAlive(tabId: string): void {
  const p = findUnarmedByTab(tabId);
  if (p) p.ts = Date.now();
}

/**
 * 点了登录但密码框已经消失、页面却没跳转（密码错误、风控拦截）：
 * 丢弃这次捕获，用户改对密码再登录时会重新上报，届时照常提示。
 */
function abandonPending(tabId: string): void {
  const p = findUnarmedByTab(tabId);
  if (p) pendings.delete(p.accountId);
}

/** 用户主动导航（地址栏/后退/刷新/首页）不应被当作「登录成功跳转」，丢弃尚未确认的捕获 */
function dropUnarmedPending(): void {
  for (const [aid, p] of pendings) {
    if (!p.armed) pendings.delete(aid);
  }
  loginHint = null;
}

function clearPending(accountId: string): void {
  const had = !!pendings.get(accountId)?.armed;
  pendings.delete(accountId);
  if (had) layoutAll();
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function pendingForUi(shell: Shell): PendingSave | null {
  const p = shell.activeId ? pendings.get(shell.activeId) : undefined;
  if (!p?.armed) return null;
  // 提示只属于当前账号：banner 上点「保存」落在哪个账号，以此处为准
  return {
    accountId: p.accountId,
    label: credLabel(p.login.fields),
    host: hostOf(p.origin),
    update: p.existingId !== null,
  };
}

/** 删除账号时调用：清掉该账号全部已存密码与「从不保存」（实际删除在 vault 子进程完成） */
function dropAccountCreds(id: string): void {
  if (pendings.has(id)) clearPending(id);
  void vault.dropAccount(id);
}

async function deleteCredEntry(entryId: string): Promise<void> {
  const e = vault.entries.find((x) => x.id === entryId);
  const shell = focusedShell();
  if (!e || !shell) return;
  const choice = await dialog.showMessageBox(shell.win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除已保存的密码？`,
    detail: `${hostOf(e.origin)} — ${e.label}`,
  });
  if (choice.response !== 0) return;
  await vault.removeEntry(entryId);
  sendStateAll();
}

async function clearAccountCreds(accountId: string): Promise<void> {
  const acc = accounts.find((a) => a.id === accountId);
  const shell = focusedShell();
  if (!acc || !shell) return;
  const choice = await dialog.showMessageBox(shell.win, {
    type: 'warning',
    buttons: ['全部清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `清除账号「${acc.name}」的全部已保存密码？`,
    detail: '同时会恢复该账号所有「从不保存」的网站。',
  });
  if (choice.response !== 0) return;
  await vault.dropAccount(accountId);
  sendStateAll();
}

/* ---------- 账号 / 标签页模型 ---------- */

function newTabRecord(url = '', title = ''): Tab {
  return { id: randomBytes(6).toString('hex'), url, title };
}

/** 保证账号磁盘数据至少有一个 tab，且 activeTabId 有效（兼容 v1.0.0 旧数据；窗口创建前也能用） */
function ensureAccountTabs(acc: Account): void {
  if (!Array.isArray(acc.tabs)) acc.tabs = [];
  if (acc.tabs.length === 0) {
    const t = newTabRecord();
    acc.tabs.push(t);
    acc.activeTabId = t.id;
  }
  if (!acc.tabs.some((t) => t.id === acc.activeTabId)) {
    acc.activeTabId = acc.tabs[0].id;
  }
}

/** 保证这个窗口里该账号至少有一个 tab。主窗口改账号本身；后开的窗口只改自己的那份。 */
function ensureTabs(shell: Shell, acc: Account): void {
  if (shell.primary) {
    ensureAccountTabs(acc);
    return;
  }
  const b = bag(shell, acc);
  if (b.tabs.length === 0) {
    const home = acc.home && isHttpUrl(acc.home) ? acc.home : '';
    const t = newTabRecord(home);
    b.tabs.push(t);
    b.activeTabId = t.id;
  }
  if (!b.tabs.some((t) => t.id === b.activeTabId)) {
    b.activeTabId = b.tabs[0].id;
  }
}

function activeAccount(shell: Shell): Account | null {
  return accounts.find((a) => a.id === shell.activeId) ?? null;
}

function activeTab(shell: Shell): Tab | null {
  const acc = activeAccount(shell);
  if (!acc) return null;
  const b = shell.primary ? acc : shell.localTabs.get(acc.id);
  if (!b) return null;
  return b.tabs.find((t) => t.id === b.activeTabId) ?? null;
}

function findTab(shell: Shell, tabId: string): { acc: Account; tab: Tab } | null {
  for (const acc of accounts) {
    const tabs = shell.primary ? acc.tabs : shell.localTabs.get(acc.id)?.tabs;
    const tab = tabs?.find((t) => t.id === tabId);
    if (tab) return { acc, tab };
  }
  return null;
}

/* ---------- 账号自动命名 ---------- */
/*
 * 账号名无需手填，按优先级自动识别（用户手动重命名后不再覆盖）：
 *   uin   腾讯云：读登录 Cookie 中的 uin / ownerUin（最准）
 *   login 任意网站：登录表单提交的用户名，页面跳转后视为登录成功
 *   host  兜底：首次打开的站点名称
 */

const NAME_RANK = { host: 1, login: 2, uin: 3 } as const;

function applyAutoName(acc: Account, source: keyof typeof NAME_RANK, name: string, note: string): void {
  if (!acc.autoName || !accounts.includes(acc)) return;
  const cur = acc.nameSource ? NAME_RANK[acc.nameSource] : 0;
  if (NAME_RANK[source] < cur) return;
  if (source === 'host' && acc.nameSource) return; // 站点名只在首次设置
  let finalName = name.slice(0, 30);
  if (source === 'host') {
    // 多个账号同站点时加序号，便于区分
    let n = 1;
    let candidate = finalName;
    while (accounts.some((a) => a !== acc && a.name === candidate)) {
      n += 1;
      candidate = `${finalName} ${n}`;
    }
    finalName = candidate;
  }
  const finalNote = note.slice(0, 60);
  if (acc.nameSource === source && acc.name === finalName && acc.note === finalNote) return;
  acc.name = finalName;
  acc.note = finalNote;
  acc.nameSource = source;
  scheduleSave();
  sendStateAll();
}

/** 主窗口首次导航到真实网站：记录账号首页，并用站点名兜底命名 */
function onMainNavigated(acc: Account, url: string): void {
  if (!isHttpUrl(url) || !accounts.includes(acc)) return;
  if (!acc.home) {
    acc.home = homeFor(url);
    scheduleSave();
  }
  const label = siteLabel(url);
  if (label && acc.autoName && !acc.nameSource) applyAutoName(acc, 'host', label, PENDING_NOTE);
}

/* ----- 腾讯云：读登录 Cookie 中的 UIN ----- */
/*
 * 腾讯云登录成功后，会在 .cloud.tencent.com 等域写入 uin（当前操作者）与 ownerUin（主账号）Cookie，
 * 这里读取其数字部分作为账号名；仅对腾讯云相关域生效，不影响其它网站。
 */

const UIN_COOKIE_DOMAINS = ['tencent.com', 'tencentcloud.com', 'qcloud.com'];
/** 仅测试：设置了 WORKPIER_DATA_DIR 时才允许本地域名，便于自动化测试 */
const UIN_TEST_DOMAINS: string[] = process.env.WORKPIER_DATA_DIR ? ['127.0.0.1', 'localhost'] : [];

function uinDomainOk(domain: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (UIN_TEST_DOMAINS.includes(d)) return true;
  return UIN_COOKIE_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`));
}

async function readUinCookie(ses: Session, name: string): Promise<string> {
  const list = await ses.cookies.get({ name });
  for (const c of list) {
    if (!uinDomainOk(c.domain ?? '')) continue;
    const digits = c.value.replace(/\D/g, '');
    if (/^\d{4,20}$/.test(digits)) return digits;
  }
  return '';
}

async function detectAccountIdentity(accountId: string): Promise<void> {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  try {
    const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
    const uin = await readUinCookie(ses, 'uin');
    if (!uin) return; // 未登录/已退出：保持现状
    const owner = (await readUinCookie(ses, 'ownerUin')) || uin;
    if (!accounts.includes(acc)) return;
    if (acc.uin !== uin || acc.ownerUin !== owner) {
      acc.uin = uin;
      acc.ownerUin = owner;
      scheduleSave();
    }
    applyAutoName(acc, 'uin', uin, uin === owner ? '腾讯云' : `腾讯云子账号 · 主账号 ${owner}`);
  } catch (err) {
    console.error('[workpier] detect identity failed:', err);
  }
}

const watchedSessions = new Set<string>();
const identityTimers = new Map<string, NodeJS.Timeout>();

/** 监听该账号会话的 uin 类 Cookie 变化（登录/切换子账号时触发），防抖后重新识别 */
function watchAccountIdentity(acc: Account, ses: Session): void {
  if (watchedSessions.has(acc.id)) return;
  watchedSessions.add(acc.id);
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || (cookie.name !== 'uin' && cookie.name !== 'ownerUin')) return;
    clearTimeout(identityTimers.get(acc.id));
    identityTimers.set(
      acc.id,
      setTimeout(() => void detectAccountIdentity(acc.id), 800),
    );
  });
}

/* ---------- 会话 Cookie 持久化 ---------- */

/**
 * 腾讯云等站点的登录 Cookie 是「会话 Cookie」（不落盘），应用一退出登录态就清零，
 * 每次重启/升级都要全部重新扫码/输密码。Electron 没有 Chromium 的
 * persist-session-cookies 开关，这里在应用层把账号分区里新增的会话 Cookie
 * 改写为带过期时间的持久 Cookie（默认 30 天），重启后登录态保留：
 * - 网站主动删除（removed=true）不拦截，登出行为不受影响；
 * - 改写后的持久 Cookie 再触发 changed 时 session=false，不会进入循环。
 */
const SESSION_COOKIE_TTL_SEC = 30 * 24 * 3600;
const cookiePersistedSessions = new Set<string>();

function persistSessionCookies(acc: Account, ses: Session): void {
  if (cookiePersistedSessions.has(acc.id)) return;
  cookiePersistedSessions.add(acc.id);
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !cookie.session || !cookie.domain) return;
    const host = cookie.domain.replace(/^\./, '');
    const detail: Electron.CookiesSetDetails = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_SEC,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    };
    ses.cookies.set(detail).catch(() => {
      /* 个别 cookie（非法 sameSite 等）改写失败：保持会话语义，不影响页面 */
    });
  });
}

/* ---------- 权限策略（session 级） ---------- */

function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    // 摄像头/麦克风：弹框确认。静默放行等于对全网无条件开放，风险过高。
    if (permission === 'media') {
      const host = hostnameOf(wc.getURL());
      const shell = shellByWebContents(wc) ?? focusedShell();
      if (!shell || shell.win.isDestroyed()) return callback(false);
      void dialog
        .showMessageBox(shell.win, {
          type: 'question',
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          message: '该网站想要使用摄像头 / 麦克风',
          detail: `${host || '未知来源'} 请求使用摄像头或麦克风，允许后即可开始音视频通话或录制。`,
        })
        .then((c) => callback(c.response === 0));
      return;
    }
    // 注意：clipboard-read 不在白名单 —— 任意网页静默读剪贴板会泄露复制的密码/token，默认拒绝。
    // （往剪贴板写内容是低风险的，保留 clipboard-sanitized-write。）
    const allowed = new Set([
      'clipboard-sanitized-write',
      'notifications',
      'fullscreen',
      'pointerLock',
    ]);
    callback(allowed.has(permission));
  });
}

/* ---------- 布局 ---------- */

function viewBounds(shell: Shell): Rectangle {
  if (shell.win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const [cw, ch] = shell.win.getContentSize();
  // 「保存密码」提示条与「恢复会话」横幅等高，同一段时间最多显示一个。崩溃横幅只在主窗口。
  const hasBanner = pendingForUi(shell) !== null || (shell.primary && crashRecoveryPending);
  const top = TOPBAR_H + TABBAR_H + (hasBanner ? BANNER_H : 0);
  const side = sidebarW(shell);
  return {
    x: side,
    y: top,
    width: Math.max(0, cw - side),
    height: Math.max(0, ch - top),
  };
}

function layoutViews(shell: Shell): void {
  if (shell.win.isDestroyed()) return;
  const b = viewBounds(shell);
  for (const view of shell.views.values()) view.setBounds(b);
  if (shell.berthOverlayOpen && shell.berthOverlay) shell.berthOverlay.setBounds(overlayBounds(shell));
  if (shell.findbarOpen && shell.findbar) {
    shell.findbar.setBounds(findbarAnchor(b, FINDBAR_W, FINDBAR_H, FINDBAR_MARGIN));
  }
}

function layoutAll(): void {
  for (const s of aliveShells()) layoutViews(s);
}

function activeWc(shell: Shell): WebContents | null {
  const tab = activeTab(shell);
  if (!tab) return null;
  return shell.views.get(tab.id)?.webContents ?? null;
}

function sendState(shell: Shell): void {
  if (shell.win.isDestroyed()) return;
  const tab = activeTab(shell);
  const wc = tab ? shell.views.get(tab.id)?.webContents : undefined;
  const acc = activeAccount(shell);
  const title = acc ? `WorkPier — ${acc.name}` : 'WorkPier — 网页工作台';
  if (shell.win.getTitle() !== title) shell.win.setTitle(title);
  const state: AppState = {
    accounts: projectAccounts(shell),
    berths,
    activeBerthId: shell.activeBerthId,
    activeId: shell.activeId,
    activeTabId: tab?.id ?? null,
    url: wc ? (isHttpUrl(wc.getURL()) ? wc.getURL() : '') : tab?.url ?? '',
    title: wc ? wc.getTitle() : tab?.title ?? '',
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    isLoading: wc ? wc.isLoading() : false,
    pending: pendingForUi(shell),
    sidebarCollapsed: shell.sidebarCollapsed,
    crashRecovery: shell.primary && crashRecoveryPending,
  };
  refreshMenuIfNeeded();
  shell.win.webContents.send('state:update', state);
}

function sendStateAll(): void {
  for (const s of aliveShells()) sendState(s);
}

/* ---------- 标签页视图 ---------- */

/** 已预热（隐藏、仅 about:blank）尚未真正导航的 tab：首次切换时补加载目标地址 */
const prewarmedTabs = new Set<string>();
/** 预热上限：额外常驻渲染进程的内存代价（Chrome Aperitif 同样的取舍） */
const PREWARM_MAX = 4;
/** 跨区预热上限：其他工作区「上次活跃账号」各预热 1 个视图（切区零冷启动） */
const PREWARM_BERTHS_MAX = 6;

function createTabView(shell: Shell, acc: Account, tab: Tab, prewarm = false): WebContentsView {
  const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
  // 去掉 UA 中的 Electron 标识，避免登录链路 UA 校验问题
  const ua = ses.getUserAgent().replace(/Electron\/[\d.]+\s*/i, '');
  ses.setUserAgent(ua);
  applyPermissionPolicy(ses);
  watchAccountIdentity(acc, ses);
  persistSessionCookies(acc, ses);

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 登录框常在跨域 iframe 内（如腾讯云登录页），预加载脚本需覆盖子 frame
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, 'pagePreload.js'),
    },
  });
  const wc = view.webContents;
  wcMap.set(wc.id, { shell, acc, tab });

  // target=_blank / window.open：在【同一窗口、同一账号】内开新标签，共享登录态。
  // 若交给系统浏览器，会丢失该账号的会话（落到别的账号或未登录）。
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) {
      const isCurrent = shell.activeId === acc.id && bag(shell, acc).activeTabId === tab.id;
      const activate = disposition !== 'background-tab' && isCurrent;
      // 异步执行，避免在 handler 回调里同步改动视图
      setImmediate(() => {
        if (accounts.includes(acc) && !shell.win.isDestroyed()) newTabForAccount(shell, acc, url, activate);
      });
    } else if (url === 'about:blank') {
      // 部分 OAuth/支付流程先 window.open('about:blank') 再往里跳转；
      // 开成独立小弹窗（继承同账号会话与安全配置），完成后再由页面自行关闭。
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 980, height: 680, autoHideMenuBar: true },
      };
    } else if (/^mailto:/i.test(url)) {
      void systemShell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 网页右键菜单：Electron 不内置 Chromium 的右键菜单（context-menu 事件只触发不展示），
  // 需应用自行构建并 popup；坐标是页面内坐标，popup 需要相对窗口的坐标（加上视图偏移）。
  wc.on('context-menu', (_e, params) => {
    if (shell.win.isDestroyed()) return;
    const items: MenuItemConstructorOptions[] = [];

    if (params.linkURL && isHttpUrl(params.linkURL)) {
      items.push(
        {
          label: '在新标签页打开链接',
          click: () => {
            if (wc.isDestroyed() || !accounts.includes(acc)) return;
            newTabForAccount(shell, acc, params.linkURL, shell.activeId === acc.id);
          },
        },
        { label: '在系统浏览器中打开链接', click: () => void systemShell.openExternal(params.linkURL) },
        { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: '复制图片地址', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { label: '撤销', click: () => !wc.isDestroyed() && wc.undo() },
        { label: '重做', click: () => !wc.isDestroyed() && wc.redo() },
        { type: 'separator' },
        { label: '剪切', enabled: params.editFlags.canCut, click: () => !wc.isDestroyed() && wc.cut() },
        { label: '复制', enabled: params.editFlags.canCopy, click: () => !wc.isDestroyed() && wc.copy() },
        { label: '粘贴', enabled: params.editFlags.canPaste, click: () => !wc.isDestroyed() && wc.paste() },
        { label: '全选', click: () => !wc.isDestroyed() && wc.selectAll() },
        { type: 'separator' },
      );
    } else if (params.selectionText) {
      items.push(
        { label: '复制', click: () => !wc.isDestroyed() && wc.copy() },
        { type: 'separator' },
      );
    }

    items.push(
      { label: '后退', enabled: wc.canGoBack(), click: () => !wc.isDestroyed() && wc.goBack() },
      { label: '前进', enabled: wc.canGoForward(), click: () => !wc.isDestroyed() && wc.goForward() },
      { label: '重新加载', click: () => !wc.isDestroyed() && wc.reload() },
    );

    const pageUrl = wc.getURL();
    if (isHttpUrl(pageUrl)) {
      items.push(
        { type: 'separator' },
        { label: '在系统浏览器中打开当前页', click: () => void systemShell.openExternal(pageUrl) },
      );
    }
    items.push(
      { type: 'separator' },
      { label: '检查元素', click: () => !wc.isDestroyed() && wc.openDevTools({ mode: 'detach' }) },
    );

    const b = view.getBounds();
    Menu.buildFromTemplate(items).popup({ window: shell.win, x: b.x + params.x, y: b.y + params.y });
  });

  // ⌘1~⌘9 切换账号（仅当前工作区内的序号；其余按键交给应用菜单）
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // 搜索栏打开期间，焦点回到网页后按 Esc 也要能关掉它（Chrome 行为）
    if (shell.findbarOpen && input.key === 'Escape') {
      event.preventDefault();
      closeFindbar(shell);
      return;
    }
    if (!input.meta) return;
    const m = /^Digit([1-9])$/.exec(input.code);
    if (m) {
      const target = visibleAccounts(shell)[Number(m[1]) - 1];
      if (target) {
        event.preventDefault();
        switchAccount(shell, target.id);
      }
    }
  });

  // findInPage 的匹配进度（当前第几个/共几个）实时转发给搜索栏
  wc.on('found-in-page', (_e, r) => {
    if (!shell.findbarOpen || activeWc(shell)?.id !== wc.id) return;
    sendFindMatches(shell, r.activeMatchOrdinal, r.matches);
  });

  // 同账号下任一 tab（含后台 tab）的标题/加载状态变化都需要刷新标签栏
  const refresh = (): void => {
    if (shell.activeId === acc.id) sendState(shell);
  };

  // 渲染进程崩溃自动恢复（连续崩溃 3 次后放弃，避免死循环）
  let crashCount = 0;
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    crashCount += 1;
    if (crashCount > 3) return;
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.reload();
    }, 500);
  });
  wc.on('did-finish-load', () => {
    crashCount = 0;
    // 仍处于预热状态（尚未转正）：不识别身份，只预热该会话分区的连接池。
    // 转正（switchTab）会先移出 prewarmedTabs 再导航，之后的 did-finish-load 走正常路径。
    if (prewarmedTabs.has(tab.id)) {
      // no-cors fetch 即便被 CORS 拦截，DNS+TCP+TLS 握手也已完成——正是 Chrome preconnect 的效果。
      if (acc.home && isHttpUrl(acc.home)) {
        wc.executeJavaScript(
          `fetch(${JSON.stringify(acc.home)}, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})`,
        ).catch(() => {
          /* 预热失败无影响 */
        });
      }
      return;
    }
    // 兜底：页面加载完成后再识别一次（覆盖升级前已登录、Cookie 事件早于监听等情况）
    void detectAccountIdentity(acc.id);
  });
  const syncUrl = (): void => {
    const u = wc.getURL();
    if (isHttpUrl(u)) tab.url = u;
    else if (isStartUrl(u)) tab.url = ''; // 起始页不记录文件路径
  };
  // 导航后旧高亮已随文档销毁：搜索栏开着且有词时，在新文档里自动重查（Chrome 行为）
  const refindAfterNav = (): void => {
    if (shell.findbarOpen && shell.findText && activeWc(shell)?.id === wc.id) runFind(shell, shell.findText, true, false);
  };
  wc.on('did-navigate', () => {
    syncUrl();
    onMainNavigated(acc, wc.getURL());
    armPending(tab.id);
    refindAfterNav();
    scheduleSave();
    refresh();
  });
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    syncUrl();
    if (isMainFrame) {
      armPending(tab.id);
      refindAfterNav(); // SPA 路由切换后高亮同样失效
    }
    scheduleSave();
    refresh();
  });
  wc.on('did-start-loading', refresh);
  wc.on('did-stop-loading', refresh);
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    scheduleSave();
    refresh();
  });

  shell.views.set(tab.id, view);
  if (!shell.win.isDestroyed()) {
    shell.win.contentView.addChildView(view);
    if (shell.findbarOpen && shell.findbar) shell.win.contentView.addChildView(shell.findbar); // 搜索栏保持在网页之上
    if (shell.berthOverlayOpen && shell.berthOverlay) shell.win.contentView.addChildView(shell.berthOverlay); // 浮层始终最顶
    view.setBounds(viewBounds(shell));
    view.setVisible(false);
  }
  if (prewarm) {
    // 预热：只拉起渲染进程 + about:blank（渲染进程初始化是最贵的冷启动部分），目标地址等真正切换时再载
    prewarmedTabs.add(tab.id);
    safeLoad(wc, 'about:blank');
  } else {
    safeLoad(wc, isHttpUrl(tab.url) ? tab.url : startUrl());
  }
  return view;
}

/** loadURL 在被新导航打断（ERR_ABORTED）等情况下会 reject，吞掉避免 unhandled rejection */
function safeLoad(wc: WebContents, url: string): void {
  wc.loadURL(url).catch(() => {
    /* 导航被打断/失败：错误页由 Chromium 自行展示 */
  });
}

function ensureTabView(shell: Shell, acc: Account, tab: Tab): WebContentsView {
  return shell.views.get(tab.id) ?? createTabView(shell, acc, tab);
}

function destroyTabView(shell: Shell, tabId: string): void {
  const view = shell.views.get(tabId);
  if (!view) return;
  if (!shell.win.isDestroyed()) {
    try {
      shell.win.contentView.removeChildView(view);
    } catch {
      /* 窗口正在关掉 */
    }
  }
  shell.views.delete(tabId);
  prewarmedTabs.delete(tabId);
  wcMap.delete(view.webContents.id);
  const p = findUnarmedByTab(tabId);
  if (p) pendings.delete(p.accountId);
  if (loginHint?.tabId === tabId) loginHint = null;
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

/** 关掉某账号在所有窗口里的网页视图（账号删除 / 清标签时） */
function destroyAccountViews(acc: Account): void {
  for (const s of shells) {
    const tabs = s.primary ? acc.tabs : (s.localTabs.get(acc.id)?.tabs ?? []);
    for (const t of [...tabs]) destroyTabView(s, t.id);
    s.localTabs.delete(acc.id);
  }
}

/** 只显示本窗口里指定 tab 的视图，其余隐藏。别的窗口不动。 */
function showOnly(shell: Shell, tabId: string): void {
  for (const [vid, v] of shell.views) v.setVisible(vid === tabId);
}

/* ---------- 切换 ---------- */

/**
 * Spare 视图池（Chrome SpareRenderProcessHost 的应用层等价）：
 * 为活跃账号维持一个隐藏的预热 WebContentsView（同 partition、about:blank 已就绪）。
 * 新建标签页时直接转正它，省掉现场拉起渲染进程的 150-400ms（新建 tab 冷启动的大头）。
 * - spare 的 Tab 不进 acc.tabs：不参与标签栏与持久化，纯进程级预热；
 * - 转正 = 把 spare Tab push 进 acc.tabs，switchTab 的 prewarmedTabs 转正路径自然接管导航；
 * - 消费后延迟补位（schedulePrewarm），账号切换后为新活跃账号补建；
 * - 总上限 SPARE_MAX，防多账号场景渲染进程数膨胀。
 */
const SPARE_MAX = 3;
/** accountId -> spare Tab（其视图挂在 views，key = tab.id） */
const spareByAccount = new Map<string, Tab>();

function makeSpareView(acc: Account): void {
  const shell = primaryShell();
  if (!shell) return;
  if (spareByAccount.has(acc.id)) return;
  if (spareByAccount.size >= SPARE_MAX) return;
  if (!accounts.includes(acc)) return;
  const t = newTabRecord('');
  spareByAccount.set(acc.id, t);
  createTabView(shell, acc, t, true);
}

/** 销毁某账号的 spare（账号删除等场景，防止孤儿渲染进程） */
function destroySpare(accountId: string): void {
  const spare = spareByAccount.get(accountId);
  if (!spare) return;
  spareByAccount.delete(accountId);
  for (const s of shells) {
    if (s.views.has(spare.id)) destroyTabView(s, spare.id);
  }
}

function switchTab(shell: Shell, tabId: string): boolean {
  const found = findTab(shell, tabId);
  if (!found || shell.win.isDestroyed()) return false;
  const { acc, tab } = found;
  bag(shell, acc).activeTabId = tabId;
  shell.activeId = acc.id;
  const view = ensureTabView(shell, acc, tab);
  if (prewarmedTabs.delete(tab.id)) {
    // 预热视图首次转正：渲染进程已在，只需导航到目标地址（Chrome Aperitif 的切换提速收益点）
    safeLoad(view.webContents, isHttpUrl(tab.url) ? tab.url : startUrl());
  }
  showOnly(shell, tabId);
  view.setBounds(viewBounds(shell));
  view.webContents.focus();
  retargetFindbar(shell);
  if (shell.primary) scheduleSave();
  sendState(shell);
  return true;
}

function switchAccount(shell: Shell, id: string): boolean {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return false;
  ensureTabs(shell, acc);
  const tabId = bag(shell, acc).activeTabId;
  if (!tabId) return false;
  // 切换后为新活跃账号补 spare（延迟执行，不与切换导航抢资源）。后开的窗口不养 spare。
  if (shell.primary) schedulePrewarm(5_000);
  return switchTab(shell, tabId);
}

/**
 * 切换工作区：记住当前区活跃账号 → 换区 → 落到该区上次活跃账号（或第一个）。
 * 只影响这一个窗口。账号/视图不销毁，各工作区登录态、标签页原地保留。
 */
function switchBerth(shell: Shell, id: string): boolean {
  if (!berths.some((b) => b.id === id)) return false;
  if (id === shell.activeBerthId) return true;
  if (shell.activeId) shell.berthActive[shell.activeBerthId] = shell.activeId;
  shell.activeBerthId = id;
  const vis = visibleAccounts(shell);
  const target = vis.find((a) => a.id === shell.berthActive[id]) ?? vis[0] ?? null;
  if (target) {
    switchAccount(shell, target.id);
  } else {
    shell.activeId = null;
    closeFindbar(shell);
    sendState(shell);
  }
  if (shell.primary) {
    scheduleUiSave();
    schedulePrewarm(3_000);
  }
  return true;
}

/* ---------- 标签页操作 ---------- */

function newTabForAccount(shell: Shell, acc: Account, url?: string, activate = true): Tab {
  if (shell.primary) ensureAccountTabs(acc);
  const b = bag(shell, acc);
  const httpUrl = url && /^https?:/i.test(url) ? url : '';
  let t: Tab;
  if (activate && shell.primary) {
    // 优先转正 spare：渲染进程已就绪，switchTab 只剩导航时间。后开的窗口没有 spare。
    const spare = spareByAccount.get(acc.id) ?? null;
    spareByAccount.delete(acc.id);
    if (spare && prewarmedTabs.has(spare.id) && shell.views.has(spare.id)) {
      t = spare;
      t.url = httpUrl;
      b.tabs.push(t);
      schedulePrewarm(3_000);
    } else {
      if (spare) destroyTabView(shell, spare.id);
      t = newTabRecord(httpUrl);
      b.tabs.push(t);
    }
  } else {
    t = newTabRecord(httpUrl);
    b.tabs.push(t);
  }
  if (activate) {
    b.activeTabId = t.id;
    switchTab(shell, t.id);
  } else {
    if (shell.primary) scheduleSave();
    if (shell.activeId === acc.id) sendState(shell);
  }
  return t;
}

function closeTab(shell: Shell, tabId: string): boolean {
  const found = findTab(shell, tabId);
  if (!found) return false;
  const { acc, tab } = found;
  const b = bag(shell, acc);
  const idx = b.tabs.findIndex((t) => t.id === tab.id);
  if (idx < 0) return false;
  b.tabs.splice(idx, 1);
  destroyTabView(shell, tab.id);
  if (b.tabs.length === 0) {
    const t = newTabRecord();
    b.tabs.push(t);
    b.activeTabId = t.id;
  } else if (b.activeTabId === tab.id) {
    b.activeTabId = b.tabs[Math.min(idx, b.tabs.length - 1)].id;
  }
  if (shell.activeId === acc.id && b.activeTabId) switchTab(shell, b.activeTabId);
  if (shell.primary) scheduleSave();
  sendState(shell);
  return true;
}

function cycleTab(shell: Shell, delta: number): void {
  const acc = activeAccount(shell);
  if (!acc) return;
  ensureTabs(shell, acc);
  const b = bag(shell, acc);
  const idx = b.tabs.findIndex((t) => t.id === b.activeTabId);
  const next = b.tabs[(idx + delta + b.tabs.length) % b.tabs.length];
  if (next) switchTab(shell, next.id);
}

/* ---------- 侧边栏收起 / 展开 ---------- */

function setSidebarCollapsed(shell: Shell, next: boolean): void {
  if (shell.sidebarCollapsed === next) return;
  closeBerthOverlay(shell);
  shell.sidebarCollapsed = next;
  if (shell.primary) scheduleUiSave();
  layoutViews(shell);
  sendState(shell);
}

/* ---------- 清除 Cookie ---------- */
/*
 * 三档范围（均只作用于所选账号自己的独立会话，不影响其它账号；已保存的密码不会被清除）：
 *   cookies  该账号全部 Cookie（所有网站退出登录）
 *   site     只清当前标签页网站可见的 Cookie
 *   all      全部站点数据：Cookie + 缓存 + 本地存储等
 */
type ClearScope = 'cookies' | 'site' | 'all';

function accountSession(acc: Account): Session {
  return session.fromPartition(`persist:clouddock-${acc.id}`);
}

/** 这个窗口里，该账号当前标签页所在网站的主机名（起始页/非网页返回空串） */
function currentHost(shell: Shell, acc: Account): string {
  const b = shell.primary ? acc : shell.localTabs.get(acc.id);
  const tab = b?.tabs.find((t) => t.id === b.activeTabId);
  if (!tab) return '';
  const wcUrl = shell.views.get(tab.id)?.webContents.getURL();
  const url = isHttpUrl(wcUrl) ? wcUrl : tab.url;
  try {
    return isHttpUrl(url) ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function cookieDomain(c: Electron.Cookie): string {
  return (c.domain ?? '').replace(/^\./, '').toLowerCase();
}

async function cookiesFor(ses: Session, host: string | null): Promise<Electron.Cookie[]> {
  const all = await ses.cookies.get({});
  if (host === null) return all;
  // 与浏览器发送规则一致：Cookie 域是主机本身或其上级域
  return all.filter((c) => {
    const d = cookieDomain(c);
    return !!d && (host === d || host.endsWith(`.${d}`));
  });
}

async function clearAccountData(shell: Shell, acc: Account, scope: ClearScope): Promise<boolean> {
  if (shell.win.isDestroyed() || !accounts.includes(acc)) return false;
  const ses = accountSession(acc);
  const host = scope === 'site' ? currentHost(shell, acc) : null;
  if (scope === 'site' && !host) {
    await dialog.showMessageBox(shell.win, {
      type: 'info',
      buttons: ['好'],
      message: '当前标签页不是网站页面',
      detail: '请先切到要清除 Cookie 的网站标签页，再执行此操作。',
    });
    return false;
  }
  const count = (await cookiesFor(ses, host)).length;
  const message =
    scope === 'site'
      ? `清除账号「${acc.name}」在 ${host} 的 Cookie？`
      : scope === 'cookies'
        ? `清除账号「${acc.name}」的全部 Cookie？`
        : `清除账号「${acc.name}」的全部站点数据？`;
  const detail =
    scope === 'all'
      ? `将清除该账号所有网站的 Cookie（共 ${count} 条）、缓存、本地存储，所有网站需重新登录。账号本身和已保存的密码保留。`
      : `共 ${count} 条 Cookie。清除后${scope === 'site' ? '该网站' : '所有网站'}会退出登录，需重新登录。账号本身和已保存的密码保留。`;
  const choice = await dialog.showMessageBox(shell.win, {
    type: 'warning',
    buttons: ['清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  if (choice.response !== 0 || !accounts.includes(acc)) return false;

  try {
    if (scope === 'site') {
      for (const c of await cookiesFor(ses, host)) {
        const d = cookieDomain(c);
        await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path ?? '/'}`, c.name);
      }
    } else if (scope === 'cookies') {
      await ses.clearStorageData({ storages: ['cookies'] });
    } else {
      await ses.clearStorageData();
      await ses.clearCache();
    }
    await ses.cookies.flushStore();
  } catch (err) {
    console.error('[workpier] clear cookies failed:', err);
    return false;
  }

  if (scope !== 'site') {
    delete acc.uin;
    delete acc.ownerUin;
  }
  reloadAccountPages(acc);
  scheduleSave();
  sendStateAll();
  return true;
}

/** 这个账号在各个窗口里已经打开的页面都刷新（清 Cookie 之后） */
function reloadAccountPages(acc: Account): void {
  for (const s of aliveShells()) {
    const tabs = s.primary ? acc.tabs : (s.localTabs.get(acc.id)?.tabs ?? []);
    for (const t of tabs) {
      if (prewarmedTabs.has(t.id)) continue;
      const view = s.views.get(t.id);
      if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    }
  }
}

/** 清除所有账号的 Cookie（一次确认） */
async function clearAllAccountsCookies(): Promise<boolean> {
  const shell = focusedShell();
  if (!shell || accounts.length === 0) return false;
  let total = 0;
  for (const a of accounts) total += (await cookiesFor(accountSession(a), null)).length;
  const choice = await dialog.showMessageBox(shell.win, {
    type: 'warning',
    buttons: ['清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `清除全部 ${accounts.length} 个账号的 Cookie？`,
    detail: `共 ${total} 条 Cookie。所有账号的所有网站都会退出登录。账号本身和已保存的密码保留。`,
  });
  if (choice.response !== 0) return false;
  for (const a of [...accounts]) {
    if (!accounts.includes(a)) continue;
    try {
      const ses = accountSession(a);
      await ses.clearStorageData({ storages: ['cookies'] });
      await ses.cookies.flushStore();
    } catch (err) {
      console.error('[workpier] clear cookies failed:', err);
    }
    delete a.uin;
    delete a.ownerUin;
    reloadAccountPages(a);
  }
  scheduleSave();
  sendStateAll();
  return true;
}

/** 清除 Cookie 的三个菜单项（右键菜单与「账号」菜单共用） */
function cookieMenuItems(shell: Shell, acc: Account): MenuItemConstructorOptions[] {
  return [
    { label: '清除 Cookie（退出该账号所有网站登录）…', click: () => void clearAccountData(shell, acc, 'cookies') },
    { label: '清除当前网站的 Cookie…', click: () => void clearAccountData(shell, acc, 'site') },
    { label: '清除全部站点数据（Cookie、缓存、本地存储）…', click: () => void clearAccountData(shell, acc, 'all') },
  ];
}

function requestRename(shell: Shell, id: string): void {
  if (shell.win.isDestroyed()) return;
  shell.win.webContents.focus();
  shell.win.webContents.send('rename:start', id);
}

/* ---------- 删除账号 ---------- */

async function removeAccount(shell: Shell, id: string): Promise<boolean> {
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0 || shell.win.isDestroyed()) return false;
  const acc = accounts[idx];
  const choice = await dialog.showMessageBox(shell.win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除账号「${acc.name}」？`,
    detail: '将同时关闭其全部标签页，并清除该账号的登录 Cookie 与本地缓存，重新添加后需重新登录。',
  });
  if (choice.response !== 0) return false;

  const cur = accounts.indexOf(acc);
  if (cur < 0) return false;
  destroyAccountViews(acc);
  destroySpare(id);
  accounts.splice(cur, 1);
  dropAccountCreds(id);
  watchedSessions.delete(id);
  clearTimeout(identityTimers.get(id));
  identityTimers.delete(id);
  cookiePersistedSessions.delete(id);

  for (const s of aliveShells()) {
    if (s.activeId !== id) {
      sendState(s);
      continue;
    }
    s.activeId = null;
    const vis = visibleAccounts(s);
    if (vis.length > 0) switchAccount(s, vis[0].id);
    else s.win.webContents.focus();
  }
  scheduleSave();

  try {
    const ses = session.fromPartition(`persist:clouddock-${id}`);
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    console.error('[workpier] clear session failed:', err);
  }
  return true;
}

/* ---------- Aperitif 式空闲预热 ---------- */

/**
 * 空闲时段预热（Chrome Aperitif 的移植）：
 *  - 给尚无视图的账号（有首页的）预建隐藏 WebContentsView（about:blank）——
 *    渲染进程初始化是账号切换冷启动的大头，提前拉起后切换只剩导航时间；
 *  - 视图就绪后向账号首页发起 no-cors fetch，预热该会话分区的 DNS+TCP+TLS 连接池；
 *  - DNS 预解析所有账号首页（OS 层缓存，免费）。
 * 上限 PREWARM_MAX，超出的账号不做进程预热，只做 DNS 预解析。
 */
let prewarmTimer: NodeJS.Timeout | null = null;
function prewarmViews(): void {
  const shell = primaryShell();
  if (!shell) return;
  const vis = visibleAccounts(shell);
  let made = 0;
  for (const acc of vis) {
    if (made >= PREWARM_MAX) break;
    if (!acc.home || !isHttpUrl(acc.home)) continue;
    ensureAccountTabs(acc);
    const tab = acc.tabs.find((t) => t.id === acc.activeTabId) ?? acc.tabs[0];
    if (!tab || shell.views.has(tab.id)) continue;
    if (!accounts.includes(acc)) continue;
    createTabView(shell, acc, tab, true);
    made += 1;
  }
  let cross = 0;
  for (const [bid, accId] of Object.entries(shell.berthActive)) {
    if (cross >= PREWARM_BERTHS_MAX) break;
    if (bid === shell.activeBerthId || !accId) continue;
    const acc = accounts.find((a) => a.id === accId);
    if (!acc || !acc.home || !isHttpUrl(acc.home)) continue;
    if (berthOfAccount(acc, berthIds()) !== bid) continue;
    ensureAccountTabs(acc);
    const tab = acc.tabs.find((t) => t.id === acc.activeTabId) ?? acc.tabs[0];
    if (!tab || shell.views.has(tab.id)) continue;
    createTabView(shell, acc, tab, true);
    cross += 1;
  }
  const active = activeAccount(shell);
  if (active) makeSpareView(active);
  for (const acc of vis) {
    if (!acc.home || !isHttpUrl(acc.home)) continue;
    try {
      void dns.promises.lookup(new URL(acc.home).hostname, { all: true }).catch(() => {
        /* DNS 预解析失败无影响 */
      });
    } catch {
      /* URL 已校验 */
    }
  }
}

/** 延迟调度预热：启动恢复完成后再预热，不与首屏抢资源；恢复横幅期间延后 */
function schedulePrewarm(delayMs: number): void {
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    if (crashRecoveryPending) return; // 用户还没决定是否恢复，别预建一堆视图
    prewarmViews();
  }, delayMs);
  prewarmTimer.unref?.();
}

/* ---------- 崩溃恢复 ---------- */

/**
 * 用户对「恢复上次会话」横幅做出选择（Chrome 恢复横幅同款交互）。
 *  - restore=true：照常恢复上次的账号与标签页
 *  - restore=false：每个账号回到干净的起始页（账号本身与登录态保留）
 */
function resolveCrash(restore: boolean): void {
  const shell = primaryShell();
  if (!shell || !crashRecoveryPending) return;
  crashRecoveryPending = false;
  if (!restore) {
    for (const acc of accounts) {
      for (const old of acc.tabs) destroyTabView(shell, old.id);
      const t = newTabRecord();
      acc.tabs = [t];
      acc.activeTabId = t.id;
    }
    saveAccountsNow();
  }
  const vis = visibleAccounts(shell);
  if (vis.length > 0) {
    const target = vis.find((a) => a.id === savedActiveId) ?? vis[0];
    switchAccount(shell, target.id);
  } else {
    sendState(shell);
  }
  schedulePrewarm(15_000);
}

/* ---------- IPC ---------- */

/** 删除工作区：账号不删（soft-delete 原则），区内账号全部挪回默认区 */
function removeBerth(bid: string): boolean {
  if (bid === DEFAULT_BERTH_ID) return false;
  const b = berths.find((x) => x.id === bid);
  if (!b) return false;
  for (const a of accounts) {
    if (berthOfAccount(a) === bid) a.berthId = DEFAULT_BERTH_ID;
  }
  berths = berths.filter((x) => x.id !== bid);
  for (const s of aliveShells()) delete s.berthActive[bid];
  saveBerthsNow();
  for (const s of aliveShells()) {
    closeBerthOverlay(s);
    if (s.activeBerthId === bid) switchBerth(s, DEFAULT_BERTH_ID);
    else sendState(s);
  }
  scheduleSave();
  return true;
}

/* ---------- 工作区下拉浮层 ----------
 * 面板必须盖在网页 WebContentsView 之上（DOM 的 z-index 管不了原生视图），
 * 所以做成一个全窗口透明的浮层视图，置于所有子视图最顶；网页区不位移、不缩放。
 * 每个窗口自己一份，互不抢。 */

function overlayBounds(shell: Shell): Rectangle {
  if (shell.win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const [cw, ch] = shell.win.getContentSize();
  return { x: 0, y: 0, width: cw, height: ch };
}

function sendBerthOverlayInit(shell: Shell): void {
  if (!shell.berthOverlay || !shell.berthOverlayOpen || shell.berthOverlay.webContents.isDestroyed()) return;
  shell.berthOverlay.webContents.send('overlay:init', {
    berths,
    activeBerthId: shell.activeBerthId,
    anchor: shell.berthOverlayAnchor,
    collapsed: shell.sidebarCollapsed,
  });
}

function openBerthOverlay(shell: Shell, anchor: BerthAnchor): void {
  if (shell.win.isDestroyed()) return;
  if (!shell.berthOverlay) {
    shell.berthOverlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'overlayPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    shell.berthOverlay.setBackgroundColor('#00000000');
    const wc = shell.berthOverlay.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    void wc.loadFile(path.join(__dirname, '..', 'overlay.html'));
  }
  shell.berthOverlayAnchor = anchor;
  shell.berthOverlayOpen = true;
  shell.win.contentView.addChildView(shell.berthOverlay);
  shell.berthOverlay.setBounds(overlayBounds(shell));
  sendBerthOverlayInit(shell);
  shell.berthOverlay.webContents.focus();
  shell.win.webContents.send('berth:panel', true);
}

function closeBerthOverlay(shell: Shell): void {
  if (!shell.berthOverlayOpen) return;
  shell.berthOverlayOpen = false;
  if (!shell.win.isDestroyed()) {
    if (shell.berthOverlay) shell.win.contentView.removeChildView(shell.berthOverlay);
    shell.win.webContents.send('berth:panel', false);
    shell.win.webContents.focus();
  }
}

/** 菜单「重命名工作区」→ 通知浮层在对应项上内联编辑 */
function requestBerthRename(shell: Shell, id: string): void {
  if (shell.berthOverlayOpen && shell.berthOverlay && !shell.berthOverlay.webContents.isDestroyed()) {
    shell.berthOverlay.webContents.send('overlay:rename', id);
  }
}

/* ---------- 页内查找浮层（⌘F）----------
 * 与 berthOverlay 同因：DOM 的 z-index 盖不住原生 WebContentsView，
 * 搜索栏做成独立小视图，定位在网页区右上角；查找/高亮由 Chromium findInPage 完成。 */
const FINDBAR_W = 340;
const FINDBAR_H = 42;
const FINDBAR_MARGIN = 10;

function sendFindMatches(shell: Shell, active: number, total: number): void {
  if (shell.findbarOpen && shell.findbar && !shell.findbar.webContents.isDestroyed()) {
    shell.findbar.webContents.send('findbar:matches', { active, total });
  }
}

function runFind(shell: Shell, text: string, forward: boolean, findNext: boolean): void {
  shell.findText = text;
  const wc = activeWc(shell);
  if (!wc || wc.isDestroyed()) return;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    sendFindMatches(shell, 0, 0);
    return;
  }
  wc.findInPage(text, { forward, findNext, matchCase: false });
}

function openFindbar(shell: Shell): void {
  if (shell.win.isDestroyed() || !activeWc(shell)) return;
  if (!shell.findbar) {
    shell.findbar = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'findbarPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    shell.findbar.setBackgroundColor('#00000000');
    const wc = shell.findbar.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    void wc.loadFile(path.join(__dirname, '..', 'findbar.html'));
  }
  shell.findbarOpen = true;
  shell.win.contentView.addChildView(shell.findbar);
  shell.findbar.setBounds(findbarAnchor(viewBounds(shell), FINDBAR_W, FINDBAR_H, FINDBAR_MARGIN));
  shell.findbar.webContents.send('findbar:init', { text: shell.findText });
  shell.findbar.webContents.focus();
}

function closeFindbar(shell: Shell): void {
  if (!shell.findbarOpen) return;
  shell.findbarOpen = false;
  const wc = activeWc(shell);
  if (wc && !wc.isDestroyed()) wc.stopFindInPage('clearSelection');
  if (!shell.win.isDestroyed()) {
    if (shell.findbar) shell.win.contentView.removeChildView(shell.findbar);
    if (wc && !wc.isDestroyed()) wc.focus();
    else shell.win.webContents.focus();
  }
}

/** ⌘G / ⇧⌘G：栏已开 = 跳下一个/上一个；栏未开 = 用上次搜索词直接开查 */
function findStep(shell: Shell, forward: boolean): void {
  if (!shell.findText) {
    openFindbar(shell);
    return;
  }
  const wasOpen = shell.findbarOpen;
  if (!wasOpen) openFindbar(shell);
  if (shell.findbarOpen) runFind(shell, shell.findText, forward, wasOpen);
}

/** 切换标签页/账号后：清掉本窗口旧页高亮，同一搜索词在新活跃页重查 */
function retargetFindbar(shell: Shell): void {
  if (!shell.findbarOpen) return;
  for (const v of shell.views.values()) {
    if (!v.webContents.isDestroyed()) v.webContents.stopFindInPage('clearSelection');
  }
  runFind(shell, shell.findText, true, false);
}

function registerIpc(): void {
  const uiOf = (sender: WebContents): Shell | null => {
    const s = shellByWebContents(sender);
    if (!s || s.win.isDestroyed() || s.win.webContents !== sender) return null;
    return s;
  };

  ipcMain.handle('accounts:list', (e) => {
    const shell = uiOf(e.sender);
    return shell ? projectAccounts(shell) : [];
  });

  ipcMain.on('win:control', (e, action: unknown) => {
    const shell = uiOf(e.sender);
    if (!shell) return;
    const act = String(action);
    if (act === 'minimize') shell.win.minimize();
    else if (act === 'maximize') {
      if (shell.win.isMaximized()) shell.win.unmaximize();
      else shell.win.maximize();
    } else if (act === 'close') shell.win.close();
  });

  ipcMain.handle('accounts:add', (e, name: unknown, note: unknown): Account | null => {
    const shell = uiOf(e.sender);
    if (!shell) return null;
    const manualName = String(name ?? '').trim().slice(0, 30);
    const loginTab = newTabRecord('');
    let seq = 1;
    while (accounts.some((a) => a.name === `新账号 ${seq}`)) seq += 1;
    const acc: Account = {
      id: randomBytes(6).toString('hex'),
      name: manualName || `新账号 ${seq}`,
      note: manualName ? String(note ?? '').trim().slice(0, 60) : PENDING_NOTE,
      color: pickColor(),
      createdAt: Date.now(),
      autoName: !manualName,
      berthId: shell.activeBerthId,
      tabs: [loginTab],
      activeTabId: loginTab.id,
    };
    accounts.push(acc);
    scheduleSave();
    switchAccount(shell, acc.id);
    sendStateAll();
    return acc;
  });

  ipcMain.handle('accounts:remove', (e, id: unknown) => {
    const shell = uiOf(e.sender) ?? shellByWebContents(e.sender);
    if (!shell) return false;
    return removeAccount(shell, String(id));
  });

  ipcMain.handle('accounts:reorder', (e, orderedIds: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell || !Array.isArray(orderedIds)) return false;
    const next = reorderAccountsInBerth(accounts, shell.activeBerthId, orderedIds.map(String));
    if (next === accounts) return false;
    accounts = next;
    scheduleSave();
    sendStateAll();
    return true;
  });

  ipcMain.handle('accounts:rename', (_e, id: unknown, name: unknown): boolean => {
    const acc = accounts.find((a) => a.id === String(id));
    if (!acc) return false;
    const n = String(name ?? '').trim().slice(0, 30);
    if (!n) return false;
    acc.name = n;
    acc.autoName = false;
    if (acc.note === PENDING_NOTE) acc.note = '';
    scheduleSave();
    sendStateAll();
    return true;
  });

  ipcMain.handle('accounts:switch', (e, id: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    return switchAccount(shell, String(id));
  });

  ipcMain.handle('berths:list', (): Berth[] => berths);

  ipcMain.handle('berths:add', (e, name: unknown, icon: unknown): Berth | null => {
    const shell = uiOf(e.sender) ?? shellByWebContents(e.sender);
    if (!shell) return null;
    const n = String(name ?? '').trim().slice(0, 12);
    if (!n) return null;
    const b: Berth = {
      id: randomBytes(4).toString('hex'),
      name: n,
      icon: typeof icon === 'string' && icon.length > 0 && icon.length <= 16 ? icon : '⚓️',
      createdAt: Date.now(),
    };
    berths.push(b);
    saveBerthsNow();
    switchBerth(shell, b.id);
    closeBerthOverlay(shell);
    sendStateAll();
    return b;
  });

  ipcMain.handle('berths:rename', (e, id: unknown, name: unknown): boolean => {
    const shell = shellByWebContents(e.sender);
    const b = berths.find((x) => x.id === String(id));
    if (!b) return false;
    const n = String(name ?? '').trim().slice(0, 12);
    if (!n) return false;
    b.name = n;
    saveBerthsNow();
    if (shell) closeBerthOverlay(shell);
    sendStateAll();
    return true;
  });

  ipcMain.handle('berths:remove', (_e, id: unknown): boolean => removeBerth(String(id)));

  ipcMain.handle('berths:switch', (e, id: unknown): boolean => {
    const shell = shellByWebContents(e.sender);
    if (!shell) return false;
    const ok = switchBerth(shell, String(id));
    closeBerthOverlay(shell);
    return ok;
  });

  ipcMain.handle('berths:panel-toggle', (e, anchor: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    if (shell.berthOverlayOpen) {
      closeBerthOverlay(shell);
      return false;
    }
    const a = (anchor ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    openBerthOverlay(shell, { x: n(a.x), y: n(a.y), w: n(a.w), h: n(a.h) });
    return true;
  });
  ipcMain.handle('overlay:ready', (e): void => {
    const shell = shellByWebContents(e.sender);
    if (shell?.berthOverlay && e.sender === shell.berthOverlay.webContents) sendBerthOverlayInit(shell);
  });
  ipcMain.handle('overlay:close', (e): void => {
    const shell = shellByWebContents(e.sender);
    if (shell?.berthOverlay && e.sender === shell.berthOverlay.webContents) closeBerthOverlay(shell);
  });

  ipcMain.handle('findbar:ready', (e): void => {
    const shell = shellByWebContents(e.sender);
    if (shell?.findbar && e.sender === shell.findbar.webContents && shell.findbarOpen) {
      shell.findbar.webContents.send('findbar:init', { text: shell.findText });
    }
  });
  ipcMain.handle('find:query', (e, text: unknown, forward: unknown, findNext: unknown): void => {
    const shell = shellByWebContents(e.sender);
    if (!shell?.findbar || e.sender !== shell.findbar.webContents) return;
    runFind(shell, String(text ?? '').slice(0, 200), forward !== false, Boolean(findNext));
  });
  ipcMain.handle('find:close', (e): void => {
    const shell = shellByWebContents(e.sender);
    if (shell?.findbar && e.sender === shell.findbar.webContents) closeFindbar(shell);
  });

  ipcMain.handle('berths:menu', (e, id: unknown): void => {
    const shell = shellByWebContents(e.sender);
    const b = berths.find((x) => x.id === String(id));
    if (!b || !shell) return;
    const isDefault = b.id === DEFAULT_BERTH_ID;
    Menu.buildFromTemplate([
      { label: `重命名「${b.name}」`, enabled: !isDefault, click: () => requestBerthRename(shell, b.id) },
      { type: 'separator' },
      {
        label: `删除工作区「${b.name}」…`,
        enabled: !isDefault,
        click: () => {
          void dialog
            .showMessageBox(shell.win, {
              type: 'warning',
              buttons: ['删除', '取消'],
              defaultId: 1,
              cancelId: 1,
              message: `删除工作区「${b.name}」？`,
              detail: '工作区内的账号不会被删除，全部移回「云账号」工作区，登录态保留。',
            })
            .then((choice) => {
              if (choice.response === 0) removeBerth(b.id);
            });
        },
      },
    ]).popup({ window: shell.win });
  });

  ipcMain.handle('ui:sidebar', (e, collapsed: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    setSidebarCollapsed(shell, typeof collapsed === 'boolean' ? collapsed : !shell.sidebarCollapsed);
    return shell.sidebarCollapsed;
  });

  ipcMain.handle('ui:focus', (e): void => {
    uiOf(e.sender)?.win.webContents.focus();
  });

  ipcMain.handle('accounts:menu', (e, id: unknown): void => {
    const shell = uiOf(e.sender);
    const acc = accounts.find((a) => a.id === String(id));
    if (!acc || !shell) return;
    Menu.buildFromTemplate([
      { label: '在新窗口打开', click: () => openNewWindow(acc.id) },
      { type: 'separator' },
      { label: '重命名', click: () => requestRename(shell, acc.id) },
      { type: 'separator' },
      ...cookieMenuItems(shell, acc),
      { type: 'separator' },
      { label: '删除账号…', click: () => void removeAccount(shell, acc.id) },
    ]).popup({ window: shell.win });
  });

  ipcMain.on('cred:captured', (e, raw: unknown) => {
    if (!credOrigin(e.sender.getURL())) return;
    void onCaptured(e.sender.id, e.senderFrame?.url, raw);
  });

  ipcMain.on('cred:active', (e) => {
    if (!credOrigin(e.sender.getURL())) return;
    const ctx = wcMap.get(e.sender.id);
    if (ctx) keepPendingAlive(ctx.tab.id);
  });

  ipcMain.on('cred:form-gone', (e) => {
    if (!credOrigin(e.sender.getURL())) return;
    const ctx = wcMap.get(e.sender.id);
    if (ctx) abandonPending(ctx.tab.id);
  });

  ipcMain.handle('nav:start-input', (e, raw: unknown): boolean => {
    const ctx = wcMap.get(e.sender.id);
    if (!ctx || !accounts.includes(ctx.acc)) return false;
    if (!isStartUrl(e.sender.getURL())) return false;
    const url = resolveInput(String(raw ?? ''));
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      safeLoad(e.sender, u.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('cred:get', async (e): Promise<FillPayload | null> => {
    const ctx = wcMap.get(e.sender.id);
    if (!ctx || !accounts.includes(ctx.acc)) return null;
    const origin = credOrigin(e.senderFrame?.url);
    if (!origin || !credOrigin(e.sender.getURL())) return null;
    if (!vault.available) return null;
    return vault.decrypt(ctx.acc.id, origin);
  });

  ipcMain.handle('cred:save', async (e): Promise<boolean> => {
    const shell = uiOf(e.sender);
    const p = shell?.activeId ? pendings.get(shell.activeId) : undefined;
    if (!shell || !p?.armed || !vault.available) return false;
    const acc = accounts.find((a) => a.id === p.accountId);
    if (!acc) {
      clearPending(p.accountId);
      sendStateAll();
      return false;
    }
    const ok = await vault.save(p.accountId, p.origin, credLabel(p.login.fields), p.login, p.existingId);
    if (!ok) return false;
    clearPending(p.accountId);
    sendStateAll();
    return true;
  });

  ipcMain.handle('cred:dismiss', (e, never: unknown): boolean => {
    const shell = uiOf(e.sender);
    const p = shell?.activeId ? pendings.get(shell.activeId) : undefined;
    if (!shell || !p) return false;
    if (never === true && !isNever(p.accountId, p.origin)) {
      void vault.addNever(p.accountId, p.origin);
    }
    clearPending(p.accountId);
    sendStateAll();
    return true;
  });

  ipcMain.handle('crash:resolve', (e, restore: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell?.primary) return false;
    resolveCrash(restore === true);
    return true;
  });

  ipcMain.handle('tabs:new', (e, url: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    const acc = activeAccount(shell) ?? visibleAccounts(shell)[0];
    if (!acc) return false;
    newTabForAccount(shell, acc, typeof url === 'string' ? url : undefined);
    return true;
  });

  ipcMain.handle('tabs:close', (e, tabId: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    return closeTab(shell, String(tabId));
  });

  ipcMain.handle('tabs:switch', (e, tabId: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    return switchTab(shell, String(tabId));
  });

  ipcMain.handle('nav:action', (e, action: unknown): void => {
    const shell = uiOf(e.sender);
    if (!shell) return;
    const wc = activeWc(shell);
    if (!wc) return;
    dropUnarmedPending();
    switch (String(action)) {
      case 'back':
        wc.goBack();
        break;
      case 'forward':
        wc.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'stop':
        wc.stop();
        break;
      case 'home':
        safeLoad(wc, activeAccount(shell)?.home ?? startUrl());
        break;
      default:
        break;
    }
  });

  ipcMain.handle('nav:url', (e, raw: unknown): boolean => {
    const shell = uiOf(e.sender);
    if (!shell) return false;
    const wc = activeWc(shell);
    if (!wc) return false;
    dropUnarmedPending();
    const url = resolveInput(String(raw ?? ''));
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      safeLoad(wc, u.toString());
      return true;
    } catch {
      return false;
    }
  });
}

/* ---------- 菜单 ---------- */

/** 「密码」菜单：列出当前账号已保存的密码（点击删除），恢复「从不保存」，全部清除 */
function passwordMenu(): MenuItemConstructorOptions {
  const shell = focusedShell();
  const acc = shell ? activeAccount(shell) : null;
  const mine = vault.entries
    .filter((e) => e.accountId === acc?.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const neverCount = vault.never.filter((n) => n.accountId === acc?.id).length;
  const MAX_SHOW = 30;
  const items: MenuItemConstructorOptions[] = [];
  // vault init 失败/子进程崩溃：不再静默「（暂无）」，给用户显式重试入口
  if (vault.initFailed) {
    items.push(
      { label: '⚠️ 密码库初始化失败，已保存的密码暂时不可见', enabled: false },
      { label: '重试初始化…', click: () => void retryVault() },
      { type: 'separator' },
    );
  }
  items.push(
    { label: acc ? `「${acc.name}」已保存的密码（点击删除）` : '请先选择账号', enabled: false },
    ...(mine.length === 0
      ? [{ label: '（暂无）', enabled: false } as MenuItemConstructorOptions]
      : mine.slice(0, MAX_SHOW).map(
          (e): MenuItemConstructorOptions => ({
            label: `${hostOf(e.origin)} — ${e.label}`.slice(0, 80),
            click: () => void deleteCredEntry(e.id),
          }),
        )),
    ...(mine.length > MAX_SHOW ? [{ label: `…另有 ${mine.length - MAX_SHOW} 条`, enabled: false } as MenuItemConstructorOptions] : []),
    { type: 'separator' },
    {
      label: `恢复「从不保存」的网站（${neverCount}）`,
      enabled: neverCount > 0,
      click: () => {
        if (!acc) return;
        void vault.restoreNever(acc.id).then(() => sendStateAll());
      },
    },
    {
      label: '清除当前账号全部已保存密码…',
      enabled: !!acc && (mine.length > 0 || neverCount > 0),
      click: () => {
        if (acc) void clearAccountCreds(acc.id);
      },
    },
  );
  return { label: '密码', submenu: items };
}

/** 菜单「重试初始化」：重新拉起 vault 子进程（杀旧起新在 Vault.retry 内完成） */
function retryVault(): void {
  void vault.retry().then(() => {
    console.log(`[workpier] vault retry: available=${vault.available} failed=${vault.initFailed} entries=${vault.entries.length}`);
    buildMenu();
    sendStateAll();
  });
}

/** 「账号」菜单：重命名、清除 Cookie（作用于当前账号） */
function accountMenu(): MenuItemConstructorOptions {
  const shell = focusedShell();
  const acc = shell ? activeAccount(shell) : null;
  const items: MenuItemConstructorOptions[] = acc && shell
    ? [
        { label: `当前账号：${acc.name}`, enabled: false },
        { label: '在新窗口打开', click: () => openNewWindow(acc.id) },
        { label: '重命名', click: () => requestRename(shell, acc.id) },
        { type: 'separator' },
        ...cookieMenuItems(shell, acc),
      ]
    : [{ label: '请先选择账号', enabled: false }];
  items.push(
    { type: 'separator' },
    { label: '清除所有账号的 Cookie…', enabled: accounts.length > 0, click: () => void clearAllAccountsCookies() },
  );
  return { label: '账号', submenu: items };
}

let menuSig = '';
/** 当前账号 / 已存密码 / vault 可用性变化时才重建菜单（sendState 很频繁） */
function menuSignature(): string {
  const shell = focusedShell();
  const id = shell?.activeId ?? null;
  return JSON.stringify([
    shell?.win.id ?? 0,
    id,
    shell ? activeAccount(shell)?.name : null,
    accounts.length,
    shell?.activeBerthId,
    shell ? visibleAccounts(shell).length : 0,
    aliveShells().map((s) => [s.win.id, s.win.getTitle()]),
    vault.available,
    vault.initFailed,
    vault.entries.filter((e) => e.accountId === id).map((e) => [e.id, e.origin, e.label]),
    vault.never.filter((n) => n.accountId === id).length,
  ]);
}
function refreshMenuIfNeeded(): void {
  const sig = menuSignature();
  if (sig === menuSig) return;
  buildMenu();
}

function buildMenu(): void {
  menuSig = menuSignature();
  const front = (): Shell | null => focusedShell();
  const zoom = (delta: number): void => {
    const shell = front();
    const wc = shell ? activeWc(shell) : null;
    if (!wc) return;
    const next = delta === 0 ? 1 : Math.min(3, Math.max(0.5, wc.getZoomFactor() + delta));
    wc.setZoomFactor(next);
  };
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        {
          label: '收起 / 展开侧边栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            const shell = front();
            if (shell) setSidebarCollapsed(shell, !shell.sidebarCollapsed);
          },
        },
        { type: 'separator' },
        { label: '刷新当前标签页', accelerator: 'CmdOrCtrl+R', click: () => { const s = front(); if (s) activeWc(s)?.reload(); } },
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => { const s = front(); if (s) activeWc(s)?.goBack(); } },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => { const s = front(); if (s) activeWc(s)?.goForward(); } },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        { label: '在页面中查找…', accelerator: 'CmdOrCtrl+F', click: () => { const s = front(); if (s) openFindbar(s); } },
        { label: '查找下一个', accelerator: 'CmdOrCtrl+G', click: () => { const s = front(); if (s) findStep(s, true); } },
        { label: '查找上一个', accelerator: 'CmdOrCtrl+Shift+G', click: () => { const s = front(); if (s) findStep(s, false); } },
        { type: 'separator' },
        {
          label: '开发者工具（当前标签页）',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => { const s = front(); if (s) activeWc(s)?.openDevTools({ mode: 'bottom' }); },
        },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '标签页',
      submenu: [
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const shell = front();
            if (!shell) return;
            const acc = activeAccount(shell) ?? visibleAccounts(shell)[0];
            if (acc) newTabForAccount(shell, acc);
          },
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const shell = front();
            const tab = shell ? activeTab(shell) : null;
            if (shell && tab) closeTab(shell, tab.id);
          },
        },
        { type: 'separator' },
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+[', click: () => { const s = front(); if (s) cycleTab(s, -1); } },
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Shift+]', click: () => { const s = front(); if (s) cycleTab(s, 1); } },
      ],
    },
    accountMenu(),
    passwordMenu(),
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () => void checkForUpdatesInteractive(preUpdateExit),
        },
        { type: 'separator' },
        { role: 'about' },
      ],
    },
    // 不用 role:'windowMenu'：它自带「关闭窗口 ⌘W」，会与「关闭标签页 ⌘W」抢快捷键
    {
      label: '窗口',
      submenu: [
        { id: 'new-window', label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => openNewWindow() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...aliveShells().map(
          (s): MenuItemConstructorOptions => ({
            label: s.win.getTitle() || 'WorkPier',
            type: 'checkbox',
            checked: s.win.isFocused(),
            click: () => {
              if (s.win.isDestroyed()) return;
              if (s.win.isMinimized()) s.win.restore();
              s.win.show();
              s.win.focus();
            },
          }),
        ),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 窗口 ---------- */

/** 更新握手成功、老进程退出前的清理（process.exit 不触发 before-quit；手动/自动更新共用） */
function preUpdateExit(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveAccountsNow();
  try {
    fs.rmSync(runningFlagFile(), { force: true });
  } catch {
    /* ignore */
  }
}

/** 这个窗口当前页的网址。新窗口用来接着看同一页，登录态仍是这个账号的。 */
function pageUrlOf(shell: Shell): string {
  const tab = activeTab(shell);
  if (!tab) return '';
  const live = shell.views.get(tab.id)?.webContents.getURL();
  if (live && isHttpUrl(live)) return live;
  return isHttpUrl(tab.url) ? tab.url : '';
}

/**
 * 再开一个软件窗口。
 * accountId 指定时打开那个账号；不指定时打开当前窗口正在看的账号和页面。
 */
function openNewWindow(accountId?: string): void {
  const src = focusedShell();
  const acc = accountId
    ? accounts.find((a) => a.id === accountId) ?? null
    : src
      ? activeAccount(src)
      : null;
  const berthId = acc ? berthOfAccount(acc, berthIds()) : (src?.activeBerthId ?? bootBerthId);
  let bootUrl = '';
  if (acc) {
    if (src && src.activeId === acc.id) bootUrl = pageUrlOf(src);
    if (!bootUrl && acc.home && isHttpUrl(acc.home)) bootUrl = acc.home;
  }
  createShell({
    primary: false,
    activeBerthId: berthId,
    sidebarCollapsed: src?.sidebarCollapsed ?? bootSidebarCollapsed,
    berthActive: { ...(src?.berthActive ?? bootBerthActive) },
    bootAccountId: acc?.id ?? null,
    bootUrl,
  });
}

function installDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(
    Menu.buildFromTemplate([{ label: '新建窗口', click: () => openNewWindow() }]),
  );
}

interface CreateShellOpts {
  primary: boolean;
  activeBerthId?: string;
  sidebarCollapsed?: boolean;
  berthActive?: Record<string, string>;
  bootAccountId?: string | null;
  bootUrl?: string;
  /** 只有启动时的主窗口处理更新握手 */
  startup?: boolean;
}

function createShell(opts: CreateShellOpts): Shell {
  const anchor = !opts.primary ? focusedShell()?.win.getBounds() : undefined;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    ...(anchor ? { x: anchor.x + 28, y: anchor.y + 28 } : {}),
    // macOS：hiddenInset + 系统红绿灯；Windows：hidden 全自绘（renderer 补窗口控制按钮）
    ...(IS_WIN
      ? { titleBarStyle: 'hidden' as const }
      : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 18 } }),
    backgroundColor: '#F5F7FA',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const shell: Shell = {
    win,
    primary: opts.primary,
    activeId: null,
    activeBerthId: opts.primary ? bootBerthId : (opts.activeBerthId ?? bootBerthId),
    berthActive: opts.primary ? { ...bootBerthActive } : { ...(opts.berthActive ?? {}) },
    sidebarCollapsed: opts.primary ? bootSidebarCollapsed : (opts.sidebarCollapsed ?? bootSidebarCollapsed),
    localTabs: new Map(),
    views: new Map(),
    berthOverlay: null,
    berthOverlayOpen: false,
    berthOverlayAnchor: { x: 0, y: 0, w: 0, h: 0 },
    findbar: null,
    findbarOpen: false,
    findText: '',
    bootAccountId: opts.bootAccountId ?? null,
    bootUrl: opts.bootUrl ?? '',
  };
  shells.push(shell);
  if (IS_WIN) {
    win.setAutoHideMenuBar(true);
    win.setMenuBarVisibility(false);
  }
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    if (!(opts.primary && opts.startup && updateToken)) return;
    try {
      fs.writeFileSync(updateToken, 'ok', { encoding: 'utf-8' });
    } catch {
      /* 写失败由老实例 30s 超时回滚兜底 */
    }
    setTimeout(() => {
      try {
        fs.rmSync(updateToken, { force: true });
      } catch {
        /* ignore */
      }
    }, 10_000).unref?.();
    retrySingleInstanceLock();
  });

  const relayout = (): void => layoutViews(shell);
  win.on('resize', relayout);
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);
  win.on('focus', () => refreshMenuIfNeeded());
  win.on('closed', () => {
    destroyShell(shell);
    refreshMenuIfNeeded();
  });

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => bootShell(shell));
  return shell;
}

/** 窗口界面加载完：主窗口恢复上次账号；后开的窗口打开指定账号的当前页 */
function bootShell(shell: Shell): void {
  if (shell.win.isDestroyed()) return;
  if (shell.primary) {
    if (crashRecoveryPending) {
      sendState(shell);
      return;
    }
    if (shell.activeId === null && accounts.length > 0) {
      const vis = visibleAccounts(shell);
      const target = vis.find((a) => a.id === savedActiveId) ?? vis[0];
      if (target) switchAccount(shell, target.id);
      else sendState(shell);
    } else {
      sendState(shell);
    }
    return;
  }
  const wanted = shell.bootAccountId;
  const acc =
    (wanted ? accounts.find((a) => a.id === wanted) : undefined) ?? visibleAccounts(shell)[0] ?? null;
  if (!acc) {
    sendState(shell);
    return;
  }
  shell.activeBerthId = berthOfAccount(acc, berthIds());
  const t = newTabRecord(shell.bootUrl);
  shell.localTabs.set(acc.id, { tabs: [t], activeTabId: t.id });
  switchAccount(shell, acc.id);
}

function destroyShell(shell: Shell): void {
  for (const [tabId, view] of [...shell.views]) {
    shell.views.delete(tabId);
    prewarmedTabs.delete(tabId);
    wcMap.delete(view.webContents.id);
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.close();
      } catch {
        /* 窗口正在拆 */
      }
    }
  }
  if (shell.primary) spareByAccount.clear();
  for (const extra of [shell.berthOverlay, shell.findbar]) {
    if (extra && !extra.webContents.isDestroyed()) {
      try {
        extra.webContents.close();
      } catch {
        /* ignore */
      }
    }
  }
  const i = shells.indexOf(shell);
  if (i >= 0) shells.splice(i, 1);
}

/* ---------- 应用生命周期 ---------- */

/** 更新启动时老实例仍握着单实例锁：写完握手信号后轮询补拿（老实例收到信号即退出） */
function retrySingleInstanceLock(): void {
  const deadline = Date.now() + 30_000;
  const tryLock = (): void => {
    // 拿到锁（老实例已退出）即可停；拿不到（老实例卡死）超时后放弃，本会话多开保护失效可接受
    if (app.requestSingleInstanceLock()) return;
    if (Date.now() > deadline) return;
    setTimeout(tryLock, 500).unref?.();
  };
  setTimeout(tryLock, 500).unref?.();
}

// 更新启动的瞬间老实例还握着锁（它在等我们的握手信号），此时拿不到锁是预期内的
const gotLock = app.requestSingleInstanceLock() || !!updateToken;
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const shell = focusedShell() ?? aliveShells()[0];
    if (!shell) return;
    if (shell.win.isMinimized()) shell.win.restore();
    shell.win.show();
    shell.win.focus();
  });

  app.whenReady().then(() => {
    // 上次更新的兜底清理（成功确认 / 失败残渣）
    reconcilePendingUpdate();
    // 运行标记：本次会话存活信号（崩溃/强杀时不会被删，下次启动据此进入恢复流程）
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileAtomic(runningFlagFile(), String(Date.now()));
    } catch (err) {
      console.error('[workpier] write running flag failed:', err);
    }
    pruneCrashDumps();

    loadAccounts();
    loadBerths();
    // 上次异常退出 → 恢复横幅；正常退出 → 直接恢复上次会话（原行为）
    crashRecoveryPending = crashedLastRun && accounts.length > 0;

    // 密码库子进程（utilityProcess）：密钥与加解密隔离在子进程内
    void vault
      .init(app.getPath('userData'), accounts.map((a) => a.id))
      .then(() => {
        console.log(
          `[workpier] vault init: available=${vault.available} failed=${vault.initFailed} entries=${vault.entries.length} never=${vault.never.length}`,
        );
        buildMenu();
        sendStateAll();
      });

    registerIpc();
    installDockMenu();
    buildMenu();
    applyPermissionPolicy(session.defaultSession);
    createShell({ primary: true, startup: true });
    schedulePrewarm(15_000);

    // 启动 5s 后静默检查 GitHub 最新 Release：失败/无新版不打扰，有新版才提醒
    setTimeout(() => void checkForUpdatesOnLaunch(preUpdateExit), 5_000).unref?.();
  });

  app.on('before-quit', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (prewarmTimer) clearTimeout(prewarmTimer);
    if (uiSaveTimer) {
      clearTimeout(uiSaveTimer);
      uiSaveTimer = null;
    }
    saveAccountsNow(); // 内部含 saveUiNow：去抖中的 UI 状态在此 flush
    // 正常退出：删运行标记（下次启动不做崩溃恢复）
    try {
      fs.rmSync(runningFlagFile(), { force: true });
    } catch {
      /* ignore */
    }
  });

  // 兜底：任何退出路径（含非正常但事件仍触发的场景）都清掉标记
  app.on('will-quit', () => {
    try {
      fs.rmSync(runningFlagFile(), { force: true });
    } catch {
      /* ignore */
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
