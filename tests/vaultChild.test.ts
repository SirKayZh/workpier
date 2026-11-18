/*
 * vaultChild 回归测试：不启动 Electron，用 fake parentPort 直接驱动 src/vaultChild.ts；
 * /usr/bin/security 替换为 tmp 下的 bash 替身（WORKPIER_VAULT_SECURITY_BIN 注入），
 * 绝不触碰真实登录钥匙串。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface VaultReply {
  id: number;
  result: Record<string, unknown>;
}

/** security 替身：条目按服务名存到 $WORKPIER_FAKE_KC_DIR（与真实 security 的 -s/-a/-w/-U 参数面兼容） */
const FAKE_SECURITY = `#!/bin/bash
DIR="\${WORKPIER_FAKE_KC_DIR:?}"
op="$1"; shift
svc=""; val=""
# 注意：find 的 -w 是无值标志（输出密码），add 的 -w 才带密钥值——两种都要兼容
while [ $# -gt 0 ]; do
  case "$1" in
    -s) svc="$2"; shift 2 ;;
    -a) shift 2 ;;
    -w) if [ -n "\${2:-}" ]; then val="$2"; shift 2; else shift; fi ;;
    *) shift ;;
  esac
done
f="$DIR/kc-$(printf '%s' "$svc" | tr -cd 'a-zA-Z0-9._-')"
case "$op" in
  find-generic-password)
    if [ -f "$f" ]; then cat "$f"; exit 0; else exit 1; fi ;;
  add-generic-password)
    printf '%s' "$val" > "$f" ;;
  *) exit 1 ;;
esac
`;

/** 加载一份全新的 vaultChild 模块实例（绑定到 fake parentPort），返回 ask() 客户端 */
async function loadVault(kcDir: string): Promise<{ ask: (op: string, extra?: Record<string, unknown>) => Promise<Record<string, any>> }> {
  const bin = path.join(kcDir, 'fake-security');
  fs.writeFileSync(bin, FAKE_SECURITY, { mode: 0o755 });
  process.env.WORKPIER_VAULT_SECURITY_BIN = bin;
  process.env.WORKPIER_FAKE_KC_DIR = kcDir;

  const port = new EventEmitter();
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (ev: string, fn: (e: { data: unknown }) => void) => {
      port.on(ev, fn);
    },
    postMessage: (msg: VaultReply) => {
      port.emit('reply', msg);
    },
  };
  vi.resetModules();
  await import('../src/vaultChild');

  let seq = 0;
  const ask = (op: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const id = ++seq;
      const h = (m: VaultReply): void => {
        if (m.id === id) {
          port.off('reply', h);
          resolve(m.result as Record<string, any>);
        }
      };
      port.on('reply', h);
      port.emit('message', { data: { ...extra, op, reqId: id } });
    });
  return { ask };
}

function readDisk(dataDir: string): { entries: unknown[]; never: unknown[] } {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf-8')) as { entries: unknown[]; never: unknown[] };
}

describe('vaultChild（fake security 驱动，不碰真实钥匙串）', () => {
  let dir: string;
  let kcDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdvault-'));
    kcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkc-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(kcDir, { recursive: true, force: true });
    delete process.env.WORKPIER_VAULT_SECURITY_BIN;
    delete process.env.WORKPIER_FAKE_KC_DIR;
  });

  it('init + save + decrypt 往返', async () => {
    const { ask } = await loadVault(kcDir);
    const init = await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(init.available).toBe(true);
    expect(init.meta.entries).toEqual([]);

    const save = await ask('save', {
      accountId: 'acc-1',
      origin: 'https://a.com',
      label: 'u1',
      login: { fields: ['u1'], password: 'p@ss-檐' },
    });
    expect(save.ok).toBe(true);
    expect(save.meta.entries).toHaveLength(1);

    const dec = await ask('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toEqual({ fields: ['u1'], password: 'p@ss-檐' });
  });

  it('删除一条密码后，回执用请求号而不是条目号，菜单数据里不再有它', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    const save = await ask('save', {
      accountId: 'acc-1',
      origin: 'https://a.com',
      label: 'alice',
      login: { fields: ['alice'], password: 's3cret-pass' },
    });
    const entryId = save.meta.entries[0].id as string;
    const removed = await ask('remove-entry', { id: entryId });
    expect(removed.meta.entries).toEqual([]);
    expect(readDisk(dir).entries).toHaveLength(0);
  });

  it('🔴 回归：init 传入不匹配的 accountIds 不得清空磁盘密文（accounts.json 损坏/重置场景）', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'x' } });
    await ask('save', { accountId: 'acc-1', origin: 'https://b.com', label: 'u2', login: { fields: ['u2'], password: 'y' } });
    expect(readDisk(dir).entries).toHaveLength(2);

    // 模拟账号列表重置成全新 ID（accounts.json 损坏后被空列表覆盖再重建）
    const m = await ask('init', { userDataDir: dir, accountIds: ['acc-NEW'] });
    expect(m.meta.entries).toHaveLength(0); // 展示层隐藏 …
    expect(readDisk(dir).entries).toHaveLength(2); // …但磁盘密文一条不少 ✅

    // 账号列表恢复后，条目重新可见（可逆，不是删除）
    const m2 = await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(m2.meta.entries).toHaveLength(2);
    const dec = await ask('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toEqual({ fields: ['u1'], password: 'x' });
  });

  it('空账号列表 = 状态未知，不过滤（与旧行为一致）', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'x' } });
    const m = await ask('init', { userDataDir: dir, accountIds: [] });
    expect(m.meta.entries).toHaveLength(1);
  });

  it('never 列表同样只隐藏不删除；restore-never 恢复', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    const n = await ask('never', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(n.meta.never).toHaveLength(1);
    const m = await ask('init', { userDataDir: dir, accountIds: ['acc-OTHER'] });
    expect(m.meta.never).toHaveLength(0);
    expect(readDisk(dir).never).toHaveLength(1); // 磁盘保留
    const r = await ask('restore-never', { accountId: 'acc-1' });
    expect(r.meta.never).toHaveLength(0);
    expect(readDisk(dir).never).toHaveLength(0); // 显式恢复才落盘删除
  });

  it('显式 drop-account 才真正落盘删除', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'x' } });
    const r = await ask('drop-account', { accountId: 'acc-1' });
    expect(r.meta.entries).toHaveLength(0);
    expect(readDisk(dir).entries).toHaveLength(0); // 用户显式删除账号 → 落盘删除
  });

  it('主密钥落钥匙串复用：重新 init 仍能解密旧密文', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'keep' } });
    // 重新加载模块（模拟应用重启；kcDir 即同一把"钥匙串"）
    const { ask: ask2 } = await loadVault(kcDir);
    const init = await ask2('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(init.available).toBe(true);
    expect(init.meta.entries).toHaveLength(1);
    const dec = await ask2('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toEqual({ fields: ['u1'], password: 'keep' });
  });

  it('dedup：同用户名同密码 → same=true；密码不同 → existingId', async () => {
    const { ask } = await loadVault(kcDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'old' } });
    const same = await ask('dedup', { accountId: 'acc-1', origin: 'https://a.com', fields: ['u1'], password: 'old' });
    expect(same.same).toBe(true);
    const diff = await ask('dedup', { accountId: 'acc-1', origin: 'https://a.com', fields: ['u1'], password: 'new' });
    expect(diff.same).toBe(false);
    expect(typeof diff.existingId).toBe('string');
    // 用户名大小写/空白不敏感
    const ci = await ask('dedup', { accountId: 'acc-1', origin: 'https://a.com', fields: [' U1 '], password: 'old' });
    expect(ci.same).toBe(true);
  });
});

/* ---------- Windows 分支：DPAPI 后端（fake powershell 恒等变换） ---------- */

/** powershell 替身：恒等变换（base64 in → 同值 out），足够驱动 DPAPI 后端的文件/密钥流程 */
const FAKE_POWERSHELL = `#!/bin/bash
cat
`;

/**
 * 以 win32 平台身份加载 vaultChild（process.platform mock + fake powershell 注入）。
 * macOS 上无法真调 DPAPI，恒等替身验证的是：密钥文件读写/校验/重生成/密文往返全链路。
 */
async function loadVaultWin(psDir: string): Promise<{ ask: (op: string, extra?: Record<string, unknown>) => Promise<Record<string, any>> }> {
  const bin = path.join(psDir, 'fake-powershell');
  fs.writeFileSync(bin, FAKE_POWERSHELL, { mode: 0o755 });
  process.env.WORKPIER_VAULT_POWERSHELL_BIN = bin;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const port = new EventEmitter();
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (ev: string, fn: (e: { data: unknown }) => void) => {
      port.on(ev, fn);
    },
    postMessage: (msg: VaultReply) => {
      port.emit('reply', msg);
    },
  };
  vi.resetModules();
  await import('../src/vaultChild');

  let seq = 0;
  const ask = (op: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const id = ++seq;
      const h = (m: VaultReply): void => {
        if (m.id === id) {
          port.off('reply', h);
          resolve(m.result as Record<string, any>);
        }
      };
      port.on('reply', h);
      port.emit('message', { data: { ...extra, op, reqId: id } });
    });
  return { ask };
}

describe('vaultChild（Windows DPAPI 分支，不碰真实系统）', () => {
  let dir: string;
  let psDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpvaultw-'));
    psDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpps-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(psDir, { recursive: true, force: true });
    delete process.env.WORKPIER_VAULT_POWERSHELL_BIN;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  it('init + save + decrypt 往返；主密钥经 DPAPI 加密落盘 master-key.bin', async () => {
    const { ask } = await loadVaultWin(psDir);
    const init = await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(init.available).toBe(true);
    // 密钥文件存在且非 32 字节裸密钥（DPAPI blob 包装；fake 恒等时 = 32B 密钥的 base64）
    const keyFile = path.join(dir, 'master-key.bin');
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.statSync(keyFile).size).toBeGreaterThan(0);

    const save = await ask('save', {
      accountId: 'acc-1',
      origin: 'https://a.com',
      label: 'u1',
      login: { fields: ['u1'], password: 'p@ss' },
    });
    expect(save.ok).toBe(true);
    const dec = await ask('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toEqual({ fields: ['u1'], password: 'p@ss' });
  });

  it('主密钥落盘复用：重新 init（模拟重启）仍能解密旧密文', async () => {
    const { ask: ask1 } = await loadVaultWin(psDir);
    await ask1('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask1('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'keep' } });
    const { ask: ask2 } = await loadVaultWin(psDir);
    const init = await ask2('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(init.available).toBe(true);
    expect(init.meta.entries).toHaveLength(1);
    const dec = await ask2('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toEqual({ fields: ['u1'], password: 'keep' });
  });

  it('🔴 密钥文件损坏 → 重新生成密钥，旧密文视为未保存（绝不明文降级）', async () => {
    const { ask } = await loadVaultWin(psDir);
    await ask('init', { userDataDir: dir, accountIds: ['acc-1'] });
    await ask('save', { accountId: 'acc-1', origin: 'https://a.com', label: 'u1', login: { fields: ['u1'], password: 'old' } });
    // 破坏密钥文件（伪 DPAPI blob，fake 解不出 32B 密钥）
    fs.writeFileSync(path.join(dir, 'master-key.bin'), Buffer.from('garbage-not-a-key'));
    const { ask: ask2 } = await loadVaultWin(psDir);
    const init = await ask2('init', { userDataDir: dir, accountIds: ['acc-1'] });
    expect(init.available).toBe(true); // 新密钥已重新生成
    // 旧密文用新密钥解不开 → payload 为 null（视为未保存），但磁盘密文保留
    const dec = await ask2('decrypt', { accountId: 'acc-1', origin: 'https://a.com' });
    expect(dec.payload).toBeNull();
    expect(readDisk(dir).entries).toHaveLength(1);
  });

  it('PowerShell 不可用 → available=false（功能禁用，不生成明文密钥）', async () => {
    // 指向不存在的 powershell 替身
    process.env.WORKPIER_VAULT_POWERSHELL_BIN = path.join(psDir, 'no-such-bin');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const port = new EventEmitter();
    (process as unknown as { parentPort: unknown }).parentPort = {
      on: (ev: string, fn: (e: { data: unknown }) => void) => port.on(ev, fn),
      postMessage: (msg: VaultReply) => port.emit('reply', msg),
    };
    vi.resetModules();
    await import('../src/vaultChild');
    const ask = (op: string): Promise<Record<string, any>> =>
      new Promise((resolve) => {
        const id = 1;
        const h = (m: VaultReply): void => {
          if (m.id === id) {
            port.off('reply', h);
            resolve(m.result as Record<string, any>);
          }
        };
        port.on('reply', h);
        port.emit('message', { data: { id, op, userDataDir: dir, accountIds: ['acc-1'] } });
      });
    const init = await ask('init');
    expect(init.available).toBe(false);
    expect(fs.existsSync(path.join(dir, 'master-key.bin'))).toBe(false);
  });
});
