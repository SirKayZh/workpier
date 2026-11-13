import { contextBridge, ipcRenderer } from 'electron';
import type { Account, AppState, Berth } from './types';

contextBridge.exposeInMainWorld('api', {
  /** 运行平台（'darwin' | 'win32'）：渲染层据此切换 ⌘/Ctrl 文案与 Windows 自绘标题栏 */
  platform: process.platform,
  /** Windows 自绘标题栏的窗口控制（send 型：无返回值，不阻塞 UI 线程） */
  winControl: (action: 'minimize' | 'maximize' | 'close'): void => ipcRenderer.send('win:control', action),
  list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
  add: (name?: string, note?: string): Promise<Account> =>
    ipcRenderer.invoke('accounts:add', name, note),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:remove', id),
  rename: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('accounts:rename', id, name),
  switch: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:switch', id),
  /** 拖拽排序：orderedIds = 当前工作区可见账号的完整新顺序 */
  reorder: (orderedIds: string[]): Promise<boolean> => ipcRenderer.invoke('accounts:reorder', orderedIds),
  berthsList: (): Promise<Berth[]> => ipcRenderer.invoke('berths:list'),
  berthAdd: (name: string, icon?: string): Promise<Berth | null> =>
    ipcRenderer.invoke('berths:add', name, icon),
  berthRename: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('berths:rename', id, name),
  berthRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('berths:remove', id),
  berthSwitch: (id: string): Promise<boolean> => ipcRenderer.invoke('berths:switch', id),
  newTab: (url?: string): Promise<boolean> => ipcRenderer.invoke('tabs:new', url),
  closeTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke('tabs:close', tabId),
  switchTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke('tabs:switch', tabId),
  /** 拖拽排序：orderedIds = 当前窗口当前账号标签的完整新顺序 */
  reorderTabs: (orderedIds: string[]): Promise<boolean> => ipcRenderer.invoke('tabs:reorder', orderedIds),
  toggleBookmark: (): Promise<boolean> => ipcRenderer.invoke('bookmarks:toggle'),
  removeBookmark: (id: string): Promise<boolean> => ipcRenderer.invoke('bookmarks:remove', id),
  /** 收藏夹浮层：盖在网页上面。anchor 是书签按钮在窗口里的矩形 */
  bookmarkPanelToggle: (anchor: { x: number; y: number; w: number; h: number }): Promise<boolean> =>
    ipcRenderer.invoke('bookmarks:panel-toggle', anchor),
  onBookmarkPanel: (cb: (open: boolean) => void): void => {
    ipcRenderer.on('bookmarks:panel', (_event, open: unknown) => cb(Boolean(open)));
  },
  nav: (action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): Promise<void> =>
    ipcRenderer.invoke('nav:action', action),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('nav:url', url),
  credSave: (): Promise<boolean> => ipcRenderer.invoke('cred:save'),
  credDismiss: (never: boolean): Promise<boolean> => ipcRenderer.invoke('cred:dismiss', never),
  /** 崩溃恢复横幅的用户选择：true=恢复上次会话，false=重新开始 */
  resolveCrash: (restore: boolean): Promise<boolean> => ipcRenderer.invoke('crash:resolve', restore),
  toggleSidebar: (collapsed?: boolean): Promise<boolean> => ipcRenderer.invoke('ui:sidebar', collapsed),
  focusUi: (): Promise<void> => ipcRenderer.invoke('ui:focus'),
  accountMenu: (id: string): Promise<void> => ipcRenderer.invoke('accounts:menu', id),
  onRenameStart: (cb: (id: string) => void): void => {
    ipcRenderer.on('rename:start', (_event, id: unknown) => cb(String(id)));
  },
  /** 工作区下拉：传入触发器在窗口内的矩形，主进程在最顶层开/关浮层 */
  berthPanelToggle: (anchor: { x: number; y: number; w: number; h: number }): Promise<boolean> =>
    ipcRenderer.invoke('berths:panel-toggle', anchor),
  onBerthPanel: (cb: (open: boolean) => void): void => {
    ipcRenderer.on('berth:panel', (_event, open: unknown) => cb(Boolean(open)));
  },
  onState: (cb: (state: AppState) => void): void => {
    ipcRenderer.on('state:update', (_event, state: AppState) => cb(state));
  },
});
