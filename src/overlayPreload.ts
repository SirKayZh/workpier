import { contextBridge, ipcRenderer } from 'electron';
import type { Berth } from './types';

export interface OverlayInit {
  kind?: 'berth' | 'bookmarks';
  berths?: Berth[];
  activeBerthId?: string;
  anchor: { x: number; y: number; w: number; h: number };
  collapsed?: boolean;
  bookmarks?: Array<{ id: string; title: string; url: string }>;
}

/** 工作区下拉浮层（盖在网页视图之上的透明全窗口视图）可用的受限 API */
contextBridge.exposeInMainWorld('overlayApi', {
  onInit: (cb: (init: OverlayInit) => void): void => {
    ipcRenderer.on('overlay:init', (_e, init: OverlayInit) => cb(init));
  },
  onRename: (cb: (id: string) => void): void => {
    ipcRenderer.on('overlay:rename', (_e, id: unknown) => cb(String(id)));
  },
  ready: (): Promise<void> => ipcRenderer.invoke('overlay:ready'),
  close: (): Promise<void> => ipcRenderer.invoke('overlay:close'),
  switchBerth: (id: string): Promise<boolean> => ipcRenderer.invoke('berths:switch', id),
  addBerth: (name: string): Promise<unknown> => ipcRenderer.invoke('berths:add', name),
  renameBerth: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('berths:rename', id, name),
  menu: (id: string): Promise<void> => ipcRenderer.invoke('berths:menu', id),
  openBookmark: (url: string): Promise<boolean> => ipcRenderer.invoke('bookmarks:open', url),
  removeBookmark: (id: string): Promise<boolean> => ipcRenderer.invoke('bookmarks:remove', id),
});
