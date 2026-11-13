export interface Tab {
  id: string;
  url: string;
  title: string;
}

/** 收藏的网页（全局，不跟账号走；打开时进当前账号的当前标签） */
export interface Bookmark {
  id: string;
  title: string;
  /** 已去掉 hash 的 http(s) 地址，用来判断是不是同一页 */
  url: string;
  createdAt: number;
}

/** 新标签页上的快捷打开 */
export interface QuickSite {
  id: string;
  name: string;
  url: string;
  color: string;
}

export interface Account {
  id: string;
  name: string;
  note: string;
  color: string;
  createdAt: number;
  /** 所在工作区（Berth）id；缺省/无效 = DEFAULT_BERTH_ID（云账号），v2.0 前的老数据自动归默认区 */
  berthId?: string;
  /** true = 名称由登录结果自动识别（用户手动重命名后置 false，不再覆盖） */
  autoName?: boolean;
  /** 自动名称的来源，优先级 uin > login > host：host=站点域名，login=登录页输入的用户名，uin=腾讯云 UIN */
  nameSource?: 'host' | 'login' | 'uin';
  /** 该账号的「首页」：首次打开的站点（⌂ 按钮回到这里；为空则回到起始页） */
  home?: string;
  /** （腾讯云站点专属）当前登录的操作者 UIN（子账号登录时与 ownerUin 不同） */
  uin?: string;
  /** 主账号 UIN */
  ownerUin?: string;
  tabs: Tab[];
  activeTabId: string | null;
}

/** 工作区（Berth）：同类型网页的聚合容器，如「云账号」「iWiki」「企微文档」 */
export interface Berth {
  id: string;
  name: string;
  /** emoji 图标，如 ☁️ */
  icon: string;
  createdAt: number;
}

/** 待用户确认的「保存密码」提示（不含密码） */
export interface PendingSave {
  accountId: string;
  /** 用户名展示文本，如「user@example.com」 */
  label: string;
  /** 网站（host[:port]） */
  host: string;
  /** true = 同一用户名已有保存记录，本次是更新密码 */
  update: boolean;
}

export interface AppState {
  /** 当前工作区内的账号（主进程已按 activeBerthId 过滤） */
  accounts: Account[];
  berths: Berth[];
  activeBerthId: string;
  activeId: string | null;
  activeTabId: string | null;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  pending: PendingSave | null;
  /** 侧边栏是否收起为窄栏 */
  sidebarCollapsed: boolean;
  /** 上次未正常退出且用户尚未选择：渲染层显示「恢复上次会话」内嵌横幅 */
  crashRecovery: boolean;
  /** 收藏夹（新的在前） */
  bookmarks: Bookmark[];
  /** 当前地址已在收藏夹里（起始页 / 非 http 地址为 false） */
  bookmarked: boolean;
}

/** 密码条目元数据（不含密文/明文；镜像到主进程供菜单展示） */
export interface CredMeta {
  id: string;
  accountId: string;
  origin: string;
  label: string;
  updatedAt: number;
}

export interface NeverSave {
  accountId: string;
  origin: string;
}

/** 页面注入脚本向主进程上报的登录表单内容 */
export interface CapturedLogin {
  fields: string[];
  password: string;
}

/** 主进程回给页面注入脚本的自动填充内容 */
export interface FillPayload {
  fields: string[];
  password: string;
}
