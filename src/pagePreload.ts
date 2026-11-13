/**
 * 注入到每个账号标签页（含 iframe）的脚本：
 *  1. 捕获登录表单提交 -> 上报主进程（是否保存由用户在界面确认）
 *  2. 发现登录框 -> 向主进程请求【该账号 + 当前网站 origin】已保存的登录信息并自动填充
 *  3. 上报登录页活动信号（仍在输密码 / 密码框已消失），供主进程判断是否还处在同一次登录过程中
 *
 * 运行在隔离世界（contextIsolation + sandbox），页面脚本无法访问这里的 ipcRenderer。
 * 注意：sandbox 预加载脚本只能 require('electron')，所以保持单文件、不引用本地模块。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { QuickSite } from './types';

const TEXT_SEL =
  'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="search"]';
const SUBMIT_TEXT = /登录|登入|log\s?in|sign\s?in|submit|确定|下一步|继续|next/i;

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

function visiblePasswords(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    (p) => !p.disabled && isVisible(p),
  );
}

/** 找到和密码框同属一个登录表单的容器 */
function findContainer(pwd: HTMLInputElement): ParentNode {
  if (pwd.form) return pwd.form;
  let node: HTMLElement | null = pwd.parentElement;
  for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
    if (node.querySelector(TEXT_SEL)) return node;
  }
  return document;
}

/** 密码框之前的可见文本输入框（用户名/邮箱/主账号 ID 等），最多取靠近密码框的 3 个 */
function userInputsFor(pwd: HTMLInputElement): HTMLInputElement[] {
  const all = Array.from(findContainer(pwd).querySelectorAll<HTMLInputElement>(TEXT_SEL));
  return all
    .filter(
      (el) =>
        !el.disabled &&
        !el.readOnly &&
        isVisible(el) &&
        (el.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    )
    .slice(-3);
}

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  // 触发框架（React/Vue）的受控输入更新
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ---------- 捕获 ---------- */

const DUP_WINDOW = 800; // 同一次提交会同时触发 submit/click/keydown，800ms 内视为重复
let lastSig = '';
let lastAt = 0;

function tryCapture(): void {
  try {
    const pwds = visiblePasswords().filter((p) => p.value);
    // 多个密码框 = 注册 / 修改密码，不处理
    if (pwds.length !== 1) return;
    const pwd = pwds[0];
    const values = userInputsFor(pwd).map((el) => el.value.trim());
    while (values.length > 0 && values[0] === '') values.shift();
    if (values.length === 0 || values[values.length - 1] === '') return;
    const sig = `${values.join('\u0000')}\u0001${pwd.value}`;
    const now = Date.now();
    // 只做提交瞬间的去重：用完即清，保证「稍后再说」之后再登录一次仍会重新上报
    if (sig === lastSig && now - lastAt < DUP_WINDOW) return;
    lastSig = sig;
    lastAt = now;
    ipcRenderer.send('cred:captured', { fields: values, password: pwd.value });
  } catch {
    /* 页面结构异常时静默 */
  }
}

document.addEventListener('submit', tryCapture, true);
document.addEventListener(
  'click',
  (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest?.('button, input[type="submit"], [role="button"], a');
    if (!btn) return;
    const text = (btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '';
    const isSubmit = (btn as HTMLButtonElement).type === 'submit' || SUBMIT_TEXT.test(text);
    if (isSubmit) {
      tryCapture();
      watchSubmit();
    }
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'INPUT') {
      tryCapture();
      watchSubmit();
    }
  },
  true,
);

/* ---------- 与主进程保持「同一次登录过程」 ---------- */

/** 输密码过程中持续心跳：登录流程可能有滑块、二次验证，耗时会超过固定的等待窗口 */
let lastPing = 0;
function ping(): void {
  const now = Date.now();
  if (now - lastPing < 1000) return;
  lastPing = now;
  try {
    ipcRenderer.send('cred:active');
  } catch {
    /* 忽略 */
  }
}

/** 点了登录但没跳转（如密码错误、风控拦截）：密码框消失就告诉主进程别再等这次登录 */
let formGoneTimer: ReturnType<typeof setTimeout> | null = null;
function watchSubmit(): void {
  if (formGoneTimer) clearTimeout(formGoneTimer);
  formGoneTimer = setTimeout(() => {
    formGoneTimer = null;
    if (visiblePasswords().length === 0) {
      try {
        ipcRenderer.send('cred:form-gone');
      } catch {
        /* 忽略 */
      }
    }
  }, 6000);
}

document.addEventListener(
  'input',
  (e) => {
    const el = e.target as HTMLElement | null;
    if (el && el.tagName === 'INPUT') ping();
  },
  true,
);

/* ---------- 自动填充 ---------- */

const handled = new WeakSet<HTMLInputElement>();
let running = false;

async function autofill(): Promise<void> {
  if (running) return;
  const pwds = visiblePasswords().filter((p) => !handled.has(p) && !p.value);
  if (pwds.length === 0) return;
  // 多个密码框（注册/改密页）不自动填
  if (pwds.length > 1) return;
  running = true;
  try {
    const cred = (await ipcRenderer.invoke('cred:get')) as { fields: string[]; password: string } | null;
    for (const pwd of pwds) {
      handled.add(pwd);
      if (!cred || !Array.isArray(cred.fields)) continue;
      const inputs = userInputsFor(pwd);
      // 右对齐：离密码框最近的输入框 = 最后一个字段（用户名），往前依次是主账号 ID 等
      cred.fields.forEach((val, i) => {
        const idx = inputs.length - cred.fields.length + i;
        const el = idx >= 0 ? inputs[idx] : undefined;
        if (el && val && !el.value) setValue(el, val);
      });
      if (!pwd.value) setValue(pwd, cred.password);
    }
  } catch {
    /* 主进程拒绝或页面销毁：忽略 */
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void autofill();
  }, 300);
}

function start(): void {
  schedule();
  // 登录页多为 SPA / 动态 iframe，监听 DOM 变化
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

/* ---------- 起始页：地址输入交主进程解析 ---------- */
/**
 * start.html 的搜索框不再自带一份 resolve 拷贝（会与地址栏规则漂移），
 * 统一走主进程 resolveInput。主进程侧只对「停在起始页的已登记 tab」放行，
 * 普通网站页面即使发现这个 API 也只会得到 false。
 */
contextBridge.exposeInMainWorld('workpierStart', {
  open: (raw: string): Promise<boolean> => ipcRenderer.invoke('nav:start-input', raw),
  quickSites: (): Promise<QuickSite[] | null> => ipcRenderer.invoke('start:quick-sites'),
  saveQuickSites: (sites: unknown): Promise<QuickSite[] | null> => ipcRenderer.invoke('start:quick-sites-save', sites),
  resetQuickSites: (): Promise<QuickSite[] | null> => ipcRenderer.invoke('start:quick-sites-reset'),
  onQuickSites: (cb: (sites: QuickSite[]) => void): void => {
    ipcRenderer.on('start:quick-sites', (_event, sites: QuickSite[]) => cb(sites));
  },
});
