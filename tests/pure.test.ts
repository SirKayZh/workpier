import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BERTH_ID,
  PALETTE,
  berthOfAccount,
  homeFor,
  hostnameOf,
  isHttpUrl,
  registrableDomain,
  reorderAccountsInBerth,
  reorderTabs,
  bookmarkKey,
  sanitizeBookmarks,
  normalizeSiteUrl,
  sanitizeQuickSites,
  DEFAULT_QUICK_SITES,
  findbarAnchor,
  accountHotkeyDigit,
  chromeHotkey,
  isPasteShortcut,
  permissionCheckGranted,
  sessionPermissionAllowed,
  LEGACY_SESSION_COOKIE_MAX_REMAIN_SEC,
  loginCookieKey,
  loginCookieNeedsRewrite,
  sanitizePersistedCookieMap,
  SESSION_COOKIE_RENEW_SLACK_SEC,
  SESSION_COOKIE_TTL_SEC,
  shouldExtendLoginCookie,
  resolveInput,
  sanitizeAccount,
  sanitizeBerth,
  siteLabel,
} from '../src/pure';

describe('resolveInput（地址栏输入解析）', () => {
  it('空输入返回 null', () => {
    expect(resolveInput('')).toBeNull();
    expect(resolveInput('   ')).toBeNull();
  });

  it('完整 URL 原样返回', () => {
    expect(resolveInput('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(resolveInput('HTTP://EXAMPLE.COM')).toBe('HTTP://EXAMPLE.COM');
  });

  it('localhost / IP 补 http://（内网控制台常见）', () => {
    expect(resolveInput('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveInput('192.168.1.10:8080/admin')).toBe('http://192.168.1.10:8080/admin');
    expect(resolveInput('127.0.0.1')).toBe('http://127.0.0.1');
  });

  it('裸域名补 https://', () => {
    expect(resolveInput('github.com')).toBe('https://github.com');
    expect(resolveInput('a.b.com.cn/x')).toBe('https://a.b.com.cn/x');
    expect(resolveInput('example.com:8443')).toBe('https://example.com:8443');
  });

  it('含空格的搜索词走 Bing 搜索', () => {
    expect(resolveInput('腾讯云 控制台')).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent('腾讯云 控制台')}`,
    );
  });

  it('无点号的单字不是域名，按搜索处理', () => {
    expect(resolveInput('hello')).toBe(`https://www.bing.com/search?q=hello`);
  });
});

describe('registrableDomain（注册域）', () => {
  it('普通二级域', () => {
    expect(registrableDomain('console.cloud.tencent.com')).toBe('tencent.com');
    expect(registrableDomain('github.com')).toBe('github.com');
  });

  it('com.cn / co.uk 一类三级注册域', () => {
    expect(registrableDomain('a.b.com.cn')).toBe('b.com.cn');
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('IP 与单段 host 原样返回', () => {
    expect(registrableDomain('1.2.3.4')).toBe('1.2.3.4');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('hostnameOf / siteLabel / homeFor', () => {
  it('hostname 小写化并去 www.', () => {
    expect(hostnameOf('https://WWW.Example.COM/x')).toBe('example.com');
    expect(hostnameOf('not a url')).toBe('');
  });

  it('已知站点显示友好名称', () => {
    expect(siteLabel('https://console.cloud.tencent.com/')).toBe('腾讯云');
    expect(siteLabel('https://github.com/login')).toBe('GitHub');
  });

  it('未知站点取注册域', () => {
    expect(siteLabel('https://docs.ffmpeg.org/')).toBe('ffmpeg.org');
  });

  it('腾讯云站点的账号首页直达控制台', () => {
    expect(homeFor('https://console.tencentcloud.com/xxx')).toBe('https://console.tencentcloud.com/');
    expect(homeFor('https://cloud.tencent.com/login')).toBe('https://console.cloud.tencent.com/');
    expect(homeFor('https://github.com/login')).toBe('https://github.com/');
  });
});

describe('isHttpUrl', () => {
  it('只认 http(s)', () => {
    expect(isHttpUrl('https://a.com')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl(123)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe('sanitizeAccount（磁盘脏数据防御）', () => {
  const base = {
    id: 'abc123',
    name: '测试账号',
    tabs: [
      { id: 't1', url: 'https://a.com/', title: 'A' },
      { id: 't1', url: 'javascript:evil', title: 'dup' }, // 重复 id，应被丢弃
    ],
  };

  it('合法数据通过并去重 tab id', () => {
    const a = sanitizeAccount(base);
    expect(a).not.toBeNull();
    expect(a?.tabs).toHaveLength(1);
    expect(a?.tabs[0].id).toBe('t1');
  });

  it('非法 url 的 tab 被置空（回起始页）而非保留', () => {
    const a = sanitizeAccount({ ...base, tabs: [{ id: 't2', url: 'file:///x', title: 'x' }] });
    expect(a?.tabs[0].url).toBe('');
  });

  it('id 不合法 / 类型不对整体拒绝', () => {
    expect(sanitizeAccount(null)).toBeNull();
    expect(sanitizeAccount('x')).toBeNull();
    expect(sanitizeAccount({ ...base, id: 'has space' })).toBeNull();
    expect(sanitizeAccount({ ...base, id: 'x'.repeat(65) })).toBeNull();
    expect(sanitizeAccount({ ...base, name: 42 })).toBeNull();
  });

  it('缺失字段回退默认值', () => {
    const a = sanitizeAccount({ id: 'ok1', name: '' });
    expect(a?.name).toBe('未命名');
    expect(a?.color).toBe(PALETTE[0]);
    expect(a?.tabs).toEqual([]);
    expect(a?.activeTabId).toBeNull();
    expect(a?.autoName).toBe(false);
  });

  it('超长字段截断', () => {
    const a = sanitizeAccount({ ...base, name: 'x'.repeat(99), note: 'y'.repeat(99) });
    expect(a?.name).toHaveLength(30);
    expect(a?.note).toHaveLength(60);
  });

  it('uin/nameSource 升级兼容', () => {
    const legacy = sanitizeAccount({ id: 'ok2', name: '10001', autoName: true, uin: '10001' });
    expect(legacy?.nameSource).toBe('uin');
    const bad = sanitizeAccount({ id: 'ok3', name: 'x', uin: '12ab' });
    expect(bad?.uin).toBeUndefined();
  });
});

import { isNewerVersion, sanitizeUpdateManifest, buildWinUpdateScript } from '../src/pure';

describe('sanitizeUpdateManifest（更新清单校验）', () => {
  const ok = { version: '1.6.0', zip: 'CloudDock-1.6.0-update.zip', sha256: 'a'.repeat(64) };

  it('合法清单原样通过，sha256 归一为小写', () => {
    const m = sanitizeUpdateManifest({ ...ok, sha256: 'A'.repeat(64), notes: 'x'.repeat(600) });
    expect(m?.version).toBe('1.6.0');
    expect(m?.sha256).toBe('a'.repeat(64));
    expect(m?.notes).toHaveLength(500);
  });

  it('结构/字段不合法整体拒绝', () => {
    expect(sanitizeUpdateManifest(null)).toBeNull();
    expect(sanitizeUpdateManifest('x')).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, version: 'v1.2' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, version: '1.2' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, sha256: 'zz' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, zip: 'a/b.zip' })).toBeNull(); // 不允许路径分隔符
    expect(sanitizeUpdateManifest({ ...ok, zip: '' })).toBeNull();
  });
});

describe('sanitizeUpdateManifest Windows 字段（win_zip / win_sha256）', () => {
  const base = { version: '2.7.0', zip: 'WorkPier-2.7.0-update.zip', sha256: 'a'.repeat(64) };

  it('成对出现且合法 → 通过；无 win 字段的纯 macOS 清单也照常通过', () => {
    const m = sanitizeUpdateManifest({ ...base, win_zip: 'WorkPier-2.7.0-win-x64.zip', win_sha256: 'B'.repeat(64) });
    expect(m?.win_zip).toBe('WorkPier-2.7.0-win-x64.zip');
    expect(m?.win_sha256).toBe('b'.repeat(64)); // 归一小写
    const macOnly = sanitizeUpdateManifest(base);
    expect(macOnly?.win_zip).toBeUndefined();
    expect(macOnly?.win_sha256).toBeUndefined();
  });

  it('🔴 半拉子字段 / 路径分隔符 / 坏 sha → 整份清单拒绝（防止装错平台的包）', () => {
    expect(sanitizeUpdateManifest({ ...base, win_zip: 'x.zip' })).toBeNull(); // 只有 win_zip
    expect(sanitizeUpdateManifest({ ...base, win_sha256: 'b'.repeat(64) })).toBeNull(); // 只有 win_sha256
    expect(sanitizeUpdateManifest({ ...base, win_zip: 'a/b.zip', win_sha256: 'b'.repeat(64) })).toBeNull();
    expect(sanitizeUpdateManifest({ ...base, win_zip: 'x.zip', win_sha256: 'zz' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...base, win_zip: '', win_sha256: 'b'.repeat(64) })).toBeNull();
  });
});

describe('buildWinUpdateScript（Windows 更新脚本生成）', () => {
  const opts = {
    exe: 'C:\\Apps\\WorkPier\\WorkPier.exe',
    bundle: 'C:\\Apps\\WorkPier',
    backup: 'C:\\Apps\\WorkPier.previous',
    newDir: 'C:\\Users\\k\\AppData\\Roaming\\WorkPier\\update-staging\\extracted\\WorkPier',
    token: 'C:\\Users\\k\\AppData\\Roaming\\WorkPier\\update-ok-123.token',
  };

  it('含全部关键步骤：等待退出 → 双版本换目录 → 启动新版 → 回滚分支', () => {
    const s = buildWinUpdateScript(opts);
    expect(s).toContain('tasklist /FI "IMAGENAME eq WorkPier.exe"');
    expect(s).toContain('robocopy "%OLD%" "%BAK%"');
    expect(s).toContain('robocopy "%NEW%" "%OLD%"');
    expect(s).toContain('--workpier-update-token');
    expect(s).toContain(':rollback');
    expect(s).toContain('del "%~f0"');
    // 路径注入到 set 语句
    expect(s).toContain(`set "EXE=${opts.exe}"`);
    expect(s).toContain(`set "BAK=${opts.backup}"`);
  });

  it('路径中的 % 转义为 %%（防 cmd 变量展开）', () => {
    const s = buildWinUpdateScript({ ...opts, bundle: 'C:\\Apps\\Work%1Pier' });
    expect(s).toContain('set "OLD=C:\\Apps\\Work%%1Pier"');
    expect(s).not.toContain('set "OLD=C:\\Apps\\Work%1Pier"');
  });

  it('CRLF 行尾（cmd 脚本规范）', () => {
    const s = buildWinUpdateScript(opts);
    expect(s.includes('\r\n')).toBe(true);
    // 不允许出现裸 \n（非 CRLF 的换行）：按 CRLF 切开后每行内不得再含 \n 或 \r
    expect(s.split('\r\n').every((line) => !line.includes('\n') && !line.includes('\r'))).toBe(true);
  });
});

describe('isNewerVersion（语义化版本比较）', () => {
  it('主/次/修订逐段比较', () => {
    expect(isNewerVersion('1.6.0', '1.5.9')).toBe(true);
    expect(isNewerVersion('1.5.9', '1.6.0')).toBe(false);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.5.0', '1.5.0')).toBe(false);
    expect(isNewerVersion('1.5.0', '1.5.0')).toBe(false);
  });

  it('段数不齐时缺省按 0 补', () => {
    expect(isNewerVersion('1.6', '1.5.9')).toBe(true);
    expect(isNewerVersion('1.5.0.1', '1.5.0')).toBe(true);
  });
});

describe('sanitizeBerth（工作区数据校验，v2.0）', () => {
  it('合法数据往返', () => {
    const b = sanitizeBerth({ id: 'wiki', name: ' iWiki ', icon: '📚', createdAt: 123 });
    expect(b).toEqual({ id: 'wiki', name: 'iWiki', icon: '📚', createdAt: 123 });
  });

  it('缺省字段兜底：icon 默认 ⚓️、createdAt 默认现在', () => {
    const b = sanitizeBerth({ id: 'docs', name: '企微文档' });
    expect(b?.icon).toBe('⚓️');
    expect(typeof b?.createdAt).toBe('number');
  });

  it('名称超长截断到 12 字符', () => {
    const b = sanitizeBerth({ id: 'x', name: '一二三四五六七八九十一二三四五' });
    expect(b?.name).toHaveLength(12);
  });

  it('结构不合法整体拒绝', () => {
    expect(sanitizeBerth(null)).toBeNull();
    expect(sanitizeBerth('x')).toBeNull();
    expect(sanitizeBerth({ id: '', name: 'x' })).toBeNull(); // 空 id
    expect(sanitizeBerth({ id: 'a b', name: 'x' })).toBeNull(); // id 含空格（不匹配 \w）
    expect(sanitizeBerth({ id: 'x', name: '' })).toBeNull();
    expect(sanitizeBerth({ id: 'x', name: '   ' })).toBeNull();
  });
});

describe('berthOfAccount（账号归区判定，v2.0）', () => {
  const acc = (berthId?: string) => ({ id: 'a1', name: 'n', note: '', color: '#000000', createdAt: 0, berthId, tabs: [], activeTabId: null });

  it('无 berthId（v2.0 前老数据）归默认区', () => {
    expect(berthOfAccount(acc())).toBe(DEFAULT_BERTH_ID);
  });

  it('有 berthId 且工作区存在 → 该区', () => {
    expect(berthOfAccount(acc('wiki'), new Set(['wiki', DEFAULT_BERTH_ID]))).toBe('wiki');
  });

  it('berthId 指向已删工作区 → 归默认区（工作区删除后账号自动回巢）', () => {
    expect(berthOfAccount(acc('gone'), new Set([DEFAULT_BERTH_ID]))).toBe(DEFAULT_BERTH_ID);
  });

  it('不传工作区集合时不做存在性校验（内部口径）', () => {
    expect(berthOfAccount(acc('anything'))).toBe('anything');
  });
});

describe('sanitizeAccount 透传 berthId（v2.0）', () => {
  it('合法 berthId 保留', () => {
    const a = sanitizeAccount({ id: 'a1', name: 'n', berthId: 'wiki', tabs: [] });
    expect(a?.berthId).toBe('wiki');
  });

  it('非法/缺失 berthId 置空（归默认区由 berthOfAccount 兜底）', () => {
    expect(sanitizeAccount({ id: 'a1', name: 'n', berthId: '', tabs: [] })?.berthId).toBeUndefined();
    expect(sanitizeAccount({ id: 'a1', name: 'n', berthId: 123, tabs: [] })?.berthId).toBeUndefined();
    expect(sanitizeAccount({ id: 'a1', name: 'n', tabs: [] })?.berthId).toBeUndefined();
  });
});

describe('reorderAccountsInBerth（工作区内账号拖拽重排，v2.3）', () => {
  const mk = (id: string, berthId?: string) => ({
    id, name: id, note: '', color: '#000000', createdAt: 0, berthId, tabs: [], activeTabId: null,
  });
  // 全局顺序：区A(云账号)与区B交错排列
  const accounts = [mk('a1'), mk('b1', 'B'), mk('a2'), mk('b2', 'B'), mk('a3'), mk('b3', 'B')];

  it('重排本区账号，其他区账号相对顺序不受影响', () => {
    const next = reorderAccountsInBerth(accounts, DEFAULT_BERTH_ID, ['a3', 'a1', 'a2']);
    expect(next.map((a) => a.id)).toEqual(['a3', 'b1', 'a1', 'b2', 'a2', 'b3']);
  });

  it('B 区重排时 A 区位置保持', () => {
    const next = reorderAccountsInBerth(accounts, 'B', ['b2', 'b3', 'b1']);
    expect(next.map((a) => a.id)).toEqual(['a1', 'b2', 'a2', 'b3', 'a3', 'b1']);
  });

  it('少一个 id（非完整列表）→ 原样返回（引用不变）', () => {
    expect(reorderAccountsInBerth(accounts, DEFAULT_BERTH_ID, ['a1', 'a2'])).toBe(accounts);
  });

  it('混入其他区的 id → 拒绝', () => {
    expect(reorderAccountsInBerth(accounts, DEFAULT_BERTH_ID, ['a1', 'b1', 'a2', 'a3'])).toBe(accounts);
  });

  it('重复 id → 拒绝', () => {
    expect(reorderAccountsInBerth(accounts, DEFAULT_BERTH_ID, ['a1', 'a2', 'a2', 'a3'])).toBe(accounts);
  });

  it('0/1 个账号的区 → 无操作', () => {
    expect(reorderAccountsInBerth([mk('x1'), mk('y1', 'B')], 'B', ['y1'])).toHaveLength(2);
    expect(reorderAccountsInBerth([mk('x1')], 'B', [])).toHaveLength(1);
  });
});

describe('findbarAnchor 搜索栏落位', () => {
  it('常规：贴网页区右上角，留 margin', () => {
    expect(findbarAnchor({ x: 232, y: 88, width: 1200, height: 800 }, 340, 42, 10)).toEqual({
      x: 232 + 1200 - 340 - 10,
      y: 98,
      width: 340,
      height: 42,
    });
  });

  it('网页区过窄：宽度收缩、贴左（不溢出）', () => {
    const r = findbarAnchor({ x: 0, y: 88, width: 200, height: 600 }, 340, 42, 10);
    expect(r.width).toBe(190);
    expect(r.x).toBe(0);
  });

  it('网页区宽度为 0：不产出负宽度', () => {
    const r = findbarAnchor({ x: 0, y: 0, width: 0, height: 0 }, 340, 42, 10);
    expect(r.width).toBe(0);
    expect(r.x).toBe(0);
  });
});

const tab = (id: string): { id: string; url: string; title: string } => ({ id, url: '', title: id });

describe('reorderTabs（标签拖拽重排）', () => {
  const tabs = [tab('t1'), tab('t2'), tab('t3')];

  it('完整新顺序会重排，标签对象本身不动', () => {
    const next = reorderTabs(tabs, ['t3', 't1', 't2']);
    expect(next.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
    expect(next[0]).toBe(tabs[2]);
  });

  it('顺序没变返回原数组', () => {
    expect(reorderTabs(tabs, ['t1', 't2', 't3'])).toBe(tabs);
  });

  it('少一个、多一个、重复都拒绝', () => {
    expect(reorderTabs(tabs, ['t2', 't1'])).toBe(tabs);
    expect(reorderTabs(tabs, ['t1', 't2', 't3', 't4'])).toBe(tabs);
    expect(reorderTabs(tabs, ['t1', 't1', 't2'])).toBe(tabs);
  });

  it('只有一个标签时不重排', () => {
    const one = [tab('only')];
    expect(reorderTabs(one, ['only'])).toBe(one);
  });
});

describe('收藏与快捷打开', () => {
  it('bookmarkKey 去掉 hash，非 http 地址不算', () => {
    expect(bookmarkKey('https://github.com/login#top')).toBe('https://github.com/login');
    expect(bookmarkKey('file:///tmp/a')).toBe('');
    expect(bookmarkKey('不是网址')).toBe('');
  });

  it('sanitizeBookmarks 丢掉坏数据，同一地址只留第一条', () => {
    const list = sanitizeBookmarks([
      { id: 'a', title: ' GitHub ', url: 'https://github.com/login#x', createdAt: 1 },
      { id: 'b', title: '重复', url: 'https://github.com/login', createdAt: 2 },
      { id: 'bad id', title: 'x', url: 'https://example.com' },
      { id: 'c', title: '', url: 'http://localhost:3000/app' },
      'nope',
    ]);
    expect(list.map((b) => b.id)).toEqual(['a', 'c']);
    expect(list[0].title).toBe('GitHub');
    expect(list[0].url).toBe('https://github.com/login');
    expect(list[1].title).toBe('http://localhost:3000/app');
  });

  it('normalizeSiteUrl 补 https，不接受一句话', () => {
    expect(normalizeSiteUrl('github.com/login')).toBe('https://github.com/login');
    expect(normalizeSiteUrl('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a');
    expect(normalizeSiteUrl('腾讯云')).toBeNull();
    expect(normalizeSiteUrl('')).toBeNull();
  });

  it('默认快捷打开能原样通过校验，空数组合法，非数组拒绝', () => {
    const kept = sanitizeQuickSites(DEFAULT_QUICK_SITES);
    expect(kept).toEqual(DEFAULT_QUICK_SITES);
    expect(sanitizeQuickSites([])).toEqual([]);
    expect(sanitizeQuickSites({ name: 'x' })).toBeNull();
  });

  it('会话 Cookie 续到浏览器上限，旧的 30 天 Cookie 只在首次收编', () => {
    const now = 1_700_000_000;
    const sessionCookie = { name: 'skey', domain: '.cloud.tencent.com', path: '/', session: true };
    const legacy = {
      name: 'uin',
      domain: '.cloud.tencent.com',
      path: '/',
      session: false,
      expirationDate: now + 10 * 24 * 3600,
    };
    const longLived = {
      name: 'sid',
      domain: '.github.com',
      path: '/',
      session: false,
      expirationDate: now + 200 * 24 * 3600,
    };
    const managed = new Set<string>();

    expect(shouldExtendLoginCookie(sessionCookie, managed, now, false)).toBe(true);
    expect(shouldExtendLoginCookie(legacy, managed, now, true)).toBe(true);
    expect(shouldExtendLoginCookie(legacy, managed, now, false)).toBe(false);
    expect(shouldExtendLoginCookie(longLived, managed, now, true)).toBe(false);
    expect(legacy.expirationDate - now).toBeLessThanOrEqual(LEGACY_SESSION_COOKIE_MAX_REMAIN_SEC);

    managed.add(loginCookieKey(legacy));
    expect(shouldExtendLoginCookie(legacy, managed, now, false)).toBe(true);
    expect(loginCookieKey(sessionCookie)).toBe('.cloud.tencent.com\t/\tskey');
  });

  it('到期日已经顶到上限附近时不再重写', () => {
    const now = 1_700_000_000;
    const fresh = {
      name: 'skey',
      domain: '.cloud.tencent.com',
      path: '/',
      session: false,
      expirationDate: now + SESSION_COOKIE_TTL_SEC - SESSION_COOKIE_RENEW_SLACK_SEC,
    };
    const aging = {
      ...fresh,
      expirationDate: now + SESSION_COOKIE_TTL_SEC - SESSION_COOKIE_RENEW_SLACK_SEC - 1,
    };
    expect(loginCookieNeedsRewrite({ ...fresh, session: true }, now)).toBe(true);
    expect(loginCookieNeedsRewrite(fresh, now)).toBe(false);
    expect(loginCookieNeedsRewrite(aging, now)).toBe(true);
    expect(SESSION_COOKIE_TTL_SEC).toBe(400 * 24 * 60 * 60);
  });

  it('续期名单：丢掉非法账号 id，键去重', () => {
    expect(sanitizePersistedCookieMap(null)).toEqual({});
    expect(sanitizePersistedCookieMap(['x'])).toEqual({});
    expect(
      sanitizePersistedCookieMap({
        'abc-1': ['.a.com\t/\tskey', '.a.com\t/\tskey', '', 1],
        '../etc': ['.a.com\t/\tskey'],
      }),
    ).toEqual({ 'abc-1': ['.a.com\t/\tskey'] });
  });

  it('快捷打开：去空名、去重、保留用户顺序', () => {
    const list = sanitizeQuickSites([
      { id: 'b', name: ' 文档 ', url: 'docs.example.com', color: 'red' },
      { id: 'a', name: '仓库', url: 'https://github.com' },
      { id: 'b', name: '重复 id', url: 'https://example.com' },
      { id: 'z', name: '   ', url: 'https://example.com/z' },
    ]);
    expect(list?.map((s) => s.id)).toEqual(['b', 'a']);
    expect(list?.[0].url).toBe('https://docs.example.com/');
    expect(list?.[0].color).toBe(PALETTE[0]);
    expect(list?.[0].name).toBe('文档');
  });
});

describe('accountHotkeyDigit', () => {
  it('Windows 认 Ctrl+数字，不认 Win 键', () => {
    expect(accountHotkeyDigit({ control: true, code: 'Digit1' }, 'win32')).toBe(1);
    expect(accountHotkeyDigit({ control: true, code: 'Digit9' }, 'win32')).toBe(9);
    expect(accountHotkeyDigit({ meta: true, code: 'Digit1' }, 'win32')).toBeNull();
    expect(accountHotkeyDigit({ control: true, alt: true, code: 'Digit1' }, 'win32')).toBeNull();
    expect(accountHotkeyDigit({ control: true, shift: true, code: 'Digit1' }, 'win32')).toBeNull();
    expect(accountHotkeyDigit({ control: true, code: 'Numpad1' }, 'win32')).toBeNull();
  });

  it('macOS 认 ⌘数字，不认单独的 Ctrl', () => {
    expect(accountHotkeyDigit({ meta: true, code: 'Digit3' }, 'darwin')).toBe(3);
    expect(accountHotkeyDigit({ control: true, code: 'Digit1' }, 'darwin')).toBeNull();
    expect(accountHotkeyDigit({ meta: true, control: true, code: 'Digit1' }, 'darwin')).toBeNull();
  });
});

describe('chromeHotkey', () => {
  it('Windows 的 Ctrl+F / Ctrl+N 打开查找和新窗口', () => {
    expect(chromeHotkey({ control: true, code: 'KeyF' }, 'win32')).toBe('find');
    expect(chromeHotkey({ control: true, code: 'KeyN' }, 'win32')).toBe('new-window');
    expect(chromeHotkey({ control: true, code: 'KeyT' }, 'win32')).toBe('new-tab');
    expect(chromeHotkey({ control: true, code: 'KeyW' }, 'win32')).toBe('close-tab');
    expect(chromeHotkey({ control: true, shift: true, code: 'KeyG' }, 'win32')).toBe('find-prev');
    expect(chromeHotkey({ control: true, alt: true, code: 'KeyI' }, 'win32')).toBe('devtools');
    expect(chromeHotkey({ control: true, code: 'Digit0' }, 'win32')).toBe('zoom-reset');
    expect(chromeHotkey({ meta: true, code: 'KeyF' }, 'win32')).toBeNull();
    expect(chromeHotkey({ control: true, shift: true, code: 'KeyN' }, 'win32')).toBeNull();
  });

  it('macOS 认 ⌘F / ⌘N', () => {
    expect(chromeHotkey({ meta: true, code: 'KeyF' }, 'darwin')).toBe('find');
    expect(chromeHotkey({ meta: true, code: 'KeyN' }, 'darwin')).toBe('new-window');
    expect(chromeHotkey({ control: true, code: 'KeyF' }, 'darwin')).toBeNull();
  });
});

describe('粘贴', () => {
  it('macOS 认 ⌘V，不认单独的 Ctrl+V', () => {
    expect(isPasteShortcut({ meta: true, code: 'KeyV', key: 'v' }, 'darwin')).toBe(true);
    expect(isPasteShortcut({ control: true, code: 'KeyV', key: 'v' }, 'darwin')).toBe(false);
    expect(isPasteShortcut({ meta: true, shift: true, code: 'KeyV', key: 'v' }, 'darwin')).toBe(false);
    expect(isPasteShortcut({ meta: true, alt: true, code: 'KeyV', key: 'v' }, 'darwin')).toBe(false);
  });

  it('Windows 认 Ctrl+V 和 Shift+Insert', () => {
    expect(isPasteShortcut({ control: true, code: 'KeyV', key: 'v' }, 'win32')).toBe(true);
    expect(isPasteShortcut({ shift: true, code: 'Insert', key: 'Insert' }, 'win32')).toBe(true);
    expect(isPasteShortcut({ meta: true, code: 'KeyV', key: 'v' }, 'win32')).toBe(false);
  });

  it('粘贴时放行剪贴板读取，平时不放行', () => {
    expect(permissionCheckGranted('clipboard-read', true)).toBe(true);
    expect(permissionCheckGranted('clipboard-read', false)).toBe(false);
    expect(permissionCheckGranted('deprecated-sync-clipboard-read', false)).toBe(true);
    expect(permissionCheckGranted('clipboard-sanitized-write', false)).toBe(true);
    expect(permissionCheckGranted('media', true)).toBe(false);
    expect(permissionCheckGranted('geolocation', false)).toBe(false);
    expect(sessionPermissionAllowed('clipboard-read')).toBe(false);
    expect(sessionPermissionAllowed('notifications')).toBe(true);
  });
});
