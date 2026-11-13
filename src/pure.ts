/**
 * 纯函数模块：不依赖 electron / fs，可直接被 vitest 单测覆盖。
 * main.ts 与页面桥共用，保证解析/清洗规则只有一份实现。
 */
import type { Account, Berth, Bookmark, QuickSite, Tab } from './types';

export const PALETTE = [
  '#0052D9', '#00A870', '#ED7B2F', '#7B61FF',
  '#E3737B', '#029BE5', '#B58A00', '#2E7D32',
];

/** 默认工作区：v2.0 前的全部老账号（无 berthId）自动归入 */
export const DEFAULT_BERTH_ID = 'cloud';

/** 账号所属工作区：berthId 缺省/无效（工作区已被删）= 默认区 */
export function berthOfAccount(acc: Account, berthIds?: Set<string>): string {
  const b = acc.berthId;
  return b && (!berthIds || berthIds.has(b)) ? b : DEFAULT_BERTH_ID;
}

/**
 * 工作区内账号重排（拖拽排序核心逻辑）：
 * orderedIds 必须恰好是「该工作区当前可见账号」的完整新顺序（多一个/少一个都拒绝）。
 * 语义：本区账号在全局数组中的「槽位集合」不变，只是槽位内按新顺序重新填充；
 * 其他工作区账号的位置与相对顺序完全不受影响。
 * 无变化/入参不合法时原样返回（引用不变，调用方可直接判 === 短路）。
 */
export function reorderAccountsInBerth(
  accounts: Account[],
  berthId: string,
  orderedIds: string[],
): Account[] {
  const berthIds = new Set(accounts.filter((a) => berthOfAccount(a) === berthId).map((a) => a.id));
  if (berthIds.size < 2) return accounts; // 0/1 个账号没有重排意义
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!berthIds.has(id) || seen.has(id)) return accounts; // 含外区 id / 重复 id → 拒绝
    seen.add(id);
  }
  if (seen.size !== berthIds.size) return accounts; // 不是完整列表 → 拒绝
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const queue = orderedIds.map((id) => byId.get(id)).filter((a): a is Account => Boolean(a));
  const result: Account[] = [];
  let qi = 0;
  for (const a of accounts) {
    if (berthIds.has(a.id)) {
      const acc = queue[qi];
      if (acc) result.push(acc);
      qi += 1;
    } else {
      result.push(a);
    }
  }
  return result;
}

/** 磁盘读入的 Berth 结构/类型校验（berths.json） */
export function sanitizeBerth(raw: unknown): Berth | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<Berth>;
  if (typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id)) return null;
  if (typeof b.name !== 'string' || b.name.trim().length === 0) return null;
  return {
    id: b.id,
    name: b.name.trim().slice(0, 12),
    // emoji 可能是多 code point（ZWJ 序列），不能 slice 粗暴截断；长度超限视为无效给默认值
    icon: typeof b.icon === 'string' && b.icon.length > 0 && b.icon.length <= 16 ? b.icon : '⚓️',
    createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
  };
}

/** 常见站点的友好名称（后缀匹配），其余取注册域名 */
const SITE_NAMES: Array<[string, string]> = [
  ['tencentcloud.com', '腾讯云'],
  ['qcloud.com', '腾讯云'],
  ['tencent.com', '腾讯云'],
  ['aliyun.com', '阿里云'],
  ['amazonaws.com', 'AWS'],
  ['aws.amazon.com', 'AWS'],
  ['azure.com', 'Azure'],
  ['microsoftonline.com', 'Microsoft'],
  ['github.com', 'GitHub'],
  ['google.com', 'Google'],
];

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 取注册域（粗略处理 com.cn / co.uk 一类二级后缀） */
export function registrableDomain(host: string): string {
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  const sld = new Set(['com', 'co', 'net', 'org', 'gov', 'edu']);
  const n = parts.length >= 3 && sld.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function siteLabel(url: string): string {
  const host = hostnameOf(url);
  if (!host) return '';
  const hit = SITE_NAMES.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  return hit ? hit[1] : registrableDomain(host);
}

/** 账号「首页」：腾讯云直达控制台，其它站点取站点根 */
export function homeFor(url: string): string {
  const host = hostnameOf(url);
  if (host === 'tencentcloud.com' || host.endsWith('.tencentcloud.com')) return 'https://console.tencentcloud.com/';
  if (/(^|\.)(tencent|qcloud)\.com$/.test(host)) return 'https://console.cloud.tencent.com/';
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return url;
  }
}

/** 把用户在地址栏输入的内容解析为 URL：网址 / localhost / IP 直接打开，其余当作搜索词 */
export function resolveInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

export function isHttpUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

/**
 * 标签重排：orderedIds 必须恰好是当前标签 id 的完整新顺序。
 * 少一个、多一个、重复、或顺序没变，都原样返回（引用不变）。
 */
export function reorderTabs(tabs: Tab[], orderedIds: string[]): Tab[] {
  if (tabs.length < 2) return tabs;
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id) || !tabs.some((t) => t.id === id)) return tabs;
    seen.add(id);
  }
  if (seen.size !== tabs.length) return tabs;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const next = orderedIds.map((id) => byId.get(id)).filter((t): t is Tab => Boolean(t));
  if (next.length !== tabs.length) return tabs;
  if (next.every((t, i) => t === tabs[i])) return tabs;
  return next;
}

/** 收藏去重键：只认 http(s)，去掉 hash。非法地址返回空串。 */
export function bookmarkKey(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

const BOOKMARK_MAX = 200;

/** 磁盘上的收藏。非数组当空；坏条目丢掉；同一地址只留第一条。 */
export function sanitizeBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  for (const item of raw) {
    if (out.length >= BOOKMARK_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const b = item as Partial<Bookmark>;
    if (typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id) || seenId.has(b.id)) continue;
    if (typeof b.url !== 'string') continue;
    const url = bookmarkKey(b.url);
    if (!url || seenUrl.has(url)) continue;
    seenId.add(b.id);
    seenUrl.add(url);
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 80) : '';
    out.push({
      id: b.id,
      title: title || url,
      url,
      createdAt: typeof b.createdAt === 'number' ? b.createdAt : 0,
    });
  }
  return out;
}

/** 快捷打开只收「像网址」的输入，不把一句话变成搜索。 */
export function normalizeSiteUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text) || text.length > 2000) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname;
    if (host !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 新标签页默认快捷打开（与旧版写死的八个站点一致） */
export const DEFAULT_QUICK_SITES: QuickSite[] = [
  { id: 'tencent', name: '腾讯云', url: 'https://cloud.tencent.com/login?s_url=https%3A%2F%2Fconsole.cloud.tencent.com%2F', color: '#0052D9' },
  { id: 'aliyun', name: '阿里云', url: 'https://account.aliyun.com/login/login.htm', color: '#ED7B2F' },
  { id: 'aws', name: 'AWS', url: 'https://console.aws.amazon.com/', color: '#B58A00' },
  { id: 'azure', name: 'Azure', url: 'https://portal.azure.com/', color: '#029BE5' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/login', color: '#24292F' },
  { id: 'google', name: 'Google', url: 'https://accounts.google.com/', color: '#E3737B' },
  { id: 'microsoft', name: 'Microsoft', url: 'https://login.microsoftonline.com/', color: '#7B61FF' },
  { id: 'notion', name: 'Notion', url: 'https://www.notion.so/login', color: '#2E7D32' },
];

const QUICK_SITE_MAX = 24;

/**
 * 校验快捷打开列表。不是数组返回 null（调用方保留原列表）；
 * 空数组是合法的（用户把快捷方式全删了）。
 */
export function sanitizeQuickSites(raw: unknown): QuickSite[] | null {
  if (!Array.isArray(raw)) return null;
  const out: QuickSite[] = [];
  const seenId = new Set<string>();
  const seenUrl = new Set<string>();
  for (const item of raw) {
    if (out.length >= QUICK_SITE_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<QuickSite>;
    if (typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id) || seenId.has(s.id)) continue;
    if (typeof s.name !== 'string') continue;
    const name = s.name.trim().slice(0, 16);
    if (!name) continue;
    if (typeof s.url !== 'string') continue;
    const url = normalizeSiteUrl(s.url);
    if (!url || seenUrl.has(url)) continue;
    seenId.add(s.id);
    seenUrl.add(url);
    const color = typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)
      ? s.color
      : PALETTE[out.length % PALETTE.length];
    out.push({ id: s.id, name, url, color });
  }
  return out;
}

/** 对磁盘读入的数据做结构/类型校验，脏数据不会拖垮渲染或会话分区 */
export function sanitizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<Account>;
  if (typeof a.id !== 'string' || !/^[\w-]{1,64}$/.test(a.id)) return null;
  if (typeof a.name !== 'string') return null;
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  if (Array.isArray(a.tabs)) {
    for (const t of a.tabs as unknown[]) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Partial<Tab>;
      if (typeof tt.id !== 'string' || !tt.id || seen.has(tt.id)) continue;
      seen.add(tt.id);
      tabs.push({
        id: tt.id,
        url: isHttpUrl(tt.url) ? tt.url : '',
        title: typeof tt.title === 'string' ? tt.title : '',
      });
    }
  }
  return {
    id: a.id,
    name: a.name.slice(0, 30) || '未命名',
    note: typeof a.note === 'string' ? a.note.slice(0, 60) : '',
    color: typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[0],
    createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
    berthId: typeof a.berthId === 'string' && a.berthId.length > 0 ? a.berthId : undefined,
    autoName: a.autoName === true,
    // 升级兼容：旧版已按 UIN 自动命名的账号标记为 uin 来源，避免被站点域名覆盖
    nameSource:
      a.nameSource === 'host' || a.nameSource === 'login' || a.nameSource === 'uin'
        ? a.nameSource
        : a.autoName === true && typeof a.uin === 'string'
          ? 'uin'
          : undefined,
    home: isHttpUrl(a.home) ? a.home : undefined,
    uin: typeof a.uin === 'string' && /^\d{4,20}$/.test(a.uin) ? a.uin : undefined,
    ownerUin: typeof a.ownerUin === 'string' && /^\d{4,20}$/.test(a.ownerUin) ? a.ownerUin : undefined,
    tabs,
    activeTabId: typeof a.activeTabId === 'string' ? a.activeTabId : null,
  };
}

/* ---------- 更新清单（Chrome 式自更新：manifest 校验 + 版本比较） ---------- */

export interface UpdateManifest {
  version: string;
  /** zip 文件名（本地 feed = 相对 manifest 的路径；http feed = 相对 URL 或绝对 URL） */
  zip: string;
  sha256: string;
  /**
   * Windows 更新包（可选，win_zip / win_sha256 必须成对出现）：
   * 与 macOS 的 zip 字段平行 —— 单一 update.json 同时描述两个平台的产物，
   * Windows 端只认 win_* 字段，macOS 端只认 zip/sha256，互不干扰。
   */
  win_zip?: string;
  win_sha256?: string;
  notes?: string;
}

/**
 * 校验 update.json 的结构：version 必须是 x.y.z 形态、zip 不含路径分隔符
 * （只允许「文件名」，路径由主进程基于 manifest 位置拼接，防止清单里塞绝对路径/穿越路径）。
 */
export function sanitizeUpdateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<UpdateManifest>;
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) return null;
  if (typeof m.zip !== 'string' || m.zip.length === 0 || m.zip.length > 200) return null;
  if (/[/\\]/.test(m.zip)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null;
  let winZip: string | undefined;
  let winSha: string | undefined;
  if (m.win_zip !== undefined || m.win_sha256 !== undefined) {
    // 字段出现就必须成对且合法（半拉子 win 字段直接判整份清单无效，防止装错包）
    if (typeof m.win_zip !== 'string' || m.win_zip.length === 0 || m.win_zip.length > 200) return null;
    if (/[/\\]/.test(m.win_zip)) return null;
    if (typeof m.win_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.win_sha256)) return null;
    winZip = m.win_zip;
    winSha = m.win_sha256.toLowerCase();
  }
  return {
    version: m.version,
    zip: m.zip,
    sha256: m.sha256.toLowerCase(),
    win_zip: winZip,
    win_sha256: winSha,
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 500) : undefined,
  };
}

/* ---------- Windows 更新脚本 ---------- */

/**
 * 生成 Windows 更新 apply-update.cmd（纯字符串拼装，可单测）。
 * 流程（Windows 上运行中的 exe 文件被锁，不能原地覆盖 → 换目录模型）：
 *  1. 轮询等待 WorkPier.exe（含 Chromium 子进程，镜像名相同）全部退出（最长 60s）
 *  2. robocopy /MOVE 旧目录 → *.previous（双版本回滚保障，同 macOS .app.previous）
 *  3. robocopy /MOVE 新目录（staging 解包产物）→ 旧目录原名
 *  4. start 新版 exe（带更新 token）；任一步失败 → 回滚 .previous → 启动旧版
 *  5. 脚本自删（staging 目录随旧目录被 move 走/由新版 reconcile 清理）
 * robocopy：系统组件，跨卷安全（cmd move 跨盘失败）、退出码 <8 即成功。
 */
export function buildWinUpdateScript(opts: {
  exe: string;
  bundle: string;
  backup: string;
  newDir: string;
  token: string;
}): string {
  const esc = (p: string): string => p.replace(/%/g, '%%');
  const EXE = esc(opts.exe);
  const OLD = esc(opts.bundle);
  const BAK = esc(opts.backup);
  const NEW = esc(opts.newDir);
  const TOKEN = esc(opts.token);
  return [
    '@echo off',
    'setlocal enableextensions',
    `set "EXE=${EXE}"`,
    `set "OLD=${OLD}"`,
    `set "BAK=${BAK}"`,
    `set "NEW=${NEW}"`,
    `set "TOKEN=${TOKEN}"`,
    'rem WorkPier 自更新脚本（由主进程生成）：等待退出 → 双版本换目录 → 启动新版',
    'rem 1) 等待应用退出（最长 60s；镜像名过滤覆盖主进程与 Chromium 子进程）',
    'set /a tries=0',
    ':waitloop',
    'tasklist /FI "IMAGENAME eq WorkPier.exe" 2>nul | find /I "WorkPier.exe" >nul',
    'if errorlevel 1 goto doapply',
    'set /a tries+=1',
    'if %tries% geq 60 goto doapply',
    'timeout /t 1 /nobreak >nul',
    'goto waitloop',
    '',
    ':doapply',
    'rem 2) 旧目录 → *.previous（保留一代用于回滚）',
    'if exist "%BAK%" rmdir /s /q "%BAK%"',
    'robocopy "%OLD%" "%BAK%" /E /MOVE /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul',
    'if errorlevel 8 goto rollback',
    'rem 3) 新目录 → 原名',
    'robocopy "%NEW%" "%OLD%" /E /MOVE /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul',
    'if errorlevel 8 goto rollback',
    'rem 4) 启动新版（带更新握手 token；启动失败由用户重试，pending-update.json 兜底清理）',
    'start "" "%EXE%" --workpier-update-token "%TOKEN%"',
    'del "%~f0" >nul 2>&1',
    'exit /b 0',
    '',
    ':rollback',
    'rem 换目录失败：恢复旧目录并启动旧版（pending-update.json 由旧版启动时清理）',
    'if not exist "%OLD%" robocopy "%BAK%" "%OLD%" /E /MOVE /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul',
    'if exist "%EXE%" start "" "%EXE%"',
    'del "%~f0" >nul 2>&1',
    'exit /b 0',
    '',
  ].join('\r\n');
}

/** 语义化版本比较：candidate 是否比 current 新（逐段数值比较） */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((x) => /^\d+$/.test(x) ? Number(x) : 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 矩形（结构化最小定义，避免 pure.ts 依赖 electron 类型） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 页内查找浮层的落位：网页区右上角、留 margin 间距；
 * 网页区过窄时宽度收缩并贴左（至少保留 margin）。
 */
export function findbarAnchor(view: Rect, width: number, height: number, margin: number): Rect {
  const w = Math.max(0, Math.min(width, view.width - margin));
  return {
    x: view.x + Math.max(0, view.width - w - margin),
    y: view.y + margin,
    width: w,
    height,
  };
}
