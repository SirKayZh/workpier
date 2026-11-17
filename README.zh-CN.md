# WorkPier

> **同一个网站，多个账号一起在线。** WorkPier 是给「一个网站要登好几个号」的人用的桌面浏览器。云控制台、文档、邮箱，或者任何网站都可以。每个账号待在侧边栏里，点一下就切过去。当前页面不用重新加载，其它账号也不用退出。
>
> **Stay signed in to several accounts at once.** Each account lives in the sidebar. Click it, and you are there.

![platform](https://img.shields.io/badge/platform-macOS%20|%20Windows-blue)
![electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)
![license](https://img.shields.io/badge/license-MIT-green)
![release](https://img.shields.io/github/v/release/SirKayZh/workpier?label=release)

[English](README.md) · **简体中文**

<p align="center">
  <img src="assets/workpier.iconset/icon_256x256.png" width="128" alt="WorkPier 图标">
</p>

<p align="center">
  <a href="https://github.com/SirKayZh/workpier/releases"><img src="https://img.shields.io/badge/⬇️_下载最新版-3b82f6?style=for-the-badge" alt="下载"></a>
  &nbsp;
  <a href="https://github.com/SirKayZh/workpier/issues/new"><img src="https://img.shields.io/badge/🐛_反馈问题-gray?style=for-the-badge" alt="反馈问题"></a>
</p>

---

<p align="center">
  <img src="docs/images/accounts-browsing.png" width="512" alt="侧边栏放着多个账号，网页照常打开">
</p>

<p align="center">
  <em>多个账号待在侧边栏里。换账号时，正在看的页面不用重新加载。</em>
</p>

<p align="center">
  <img src="docs/images/new-tab-workspaces.png" width="360" alt="新标签页和工作区列表">&nbsp;
  <img src="docs/images/edit-shortcuts.png" width="360" alt="编辑新标签页上的常用网站">
</p>

<p align="center">
  <em>新标签页先问要登录哪个网站（左）。常用网站可以改名、调顺序、删掉（右）。</em>
</p>

---

## 为什么用 WorkPier

再开一个 Chrome 用户，或者再开一个浏览器，就是又一个窗口、又一个要来回找的地方。WorkPier 把这些登录放在同一个窗口里。你没在看的那个账号，仍然是登录着的。

| | **WorkPier** | **Chrome 多用户** | **多开几个浏览器** |
|---|:---:|:---:|:---:|
| **价格** | 免费，开源 | 免费 | 免费 |
| **多个登录放在一个窗口** | 可以 | 每个用户自己一个窗口 | 每个登录一个应用 |
| **切换时页面不重载** | 点侧边栏即可 | 切换用户会整窗换掉 | 要去别的应用里找 |
| **每个账号自己的标签页** | 有 | 有 | 有 |
| **同一个账号开两个窗口对照** | 可以 | 可以 | 可以 |
| **密码跟着这个账号走** | 是 | 按用户配置 | 按浏览器 |
| **数据留在这台电脑** | 是 | 同步可以关掉 | 是 |
| **macOS 和 Windows** | 都有 | 都有 | 都有 |

---

## 能做什么

### 多个账号并排待着

- 添加账号不用填表。出来一个新标签页，输入网址，或者点你常开的网站。
- 在网页里照常登录，扫码或密码都可以。能认出来的时候，WorkPier 会自己起名字。随时可以改。
- 同一个网站可以同时登着不同账号，互不影响。
- macOS 上 `⌘1` 到 `⌘9` 切到当前工作区里的第几个账号。Windows 上点侧边栏。

### 标签、窗口，还有上次那一页

- 每个账号有自己的标签页。`⌘T` 新建，`⌘W` 关闭，标签可以拖动排序。
- 新建窗口（`⌘N`，macOS 也可以在程序坞右键图标）打开你正在看的这一页，还是这个账号，方便两页对照。
- 关掉一个窗口，其它窗口还在。后开的窗口里临时开的标签不会被记住。主窗口的标签下次打开还在。
- 可以把这一页收进收藏。新标签页上可以放每天要开的网站。
- `⌘F` 在当前页面里查找。

### 下次打开还是登录着的

- 退出再打开，回到上次的账号和标签页。
- 网站本来不落盘、一退出就丢的登录，会保留到浏览器允许的最长时间（400 天）。每次打开，以及开着的时候每 12 小时，这个日期会再往后推。
- 网站服务器自己让登录失效时，还是要重新登录。WorkPier 续不了一张服务器已经作废的票据。
- 从旧名字 CloudDock 升级上来的，第一次打开会自动把原来的账号和已保存密码搬过来。

### 密码分开存

- 登录成功之后，会问要不要保存密码。
- 下次打开这个登录页，自动填入。
- 账号 B 看不到账号 A 保存的密码。删掉账号时，它保存的密码一起删掉。

### 工作区

- 侧边栏可以分成多个工作区，云账号和文档不用挤在同一列。
- 侧边栏可以收成一排头像。`⌘B` 展开或收起，选择会被记住。

---

## 安装

到 [Releases](https://github.com/SirKayZh/workpier/releases) 下载最新安装包。

**macOS（Apple 芯片）**

- 打开 `WorkPier-<版本>.dmg`，把 WorkPier 拖进「应用程序」。
- 应用没有公证。如果系统提示无法验证开发者，在 Finder 里右键应用，选「打开」，或在终端执行：

```bash
xattr -cr /Applications/WorkPier.app
```

**Windows**

- 下载 `WorkPier-<版本>-win-x64.zip`，解压到任意目录，双击 `WorkPier\WorkPier.exe`。不用安装，也不用管理员权限。
- SmartScreen 弹出时，选「更多信息」，再选「仍要运行」。

已经装着旧版本的，启动大约 5 秒后会提示更新，也可以在「帮助 → 检查更新」里自己检查。

每一版改了什么，写在 [更新记录](CHANGELOG.md)。[Releases](https://github.com/SirKayZh/workpier/releases) 页面上是同一份说明。

---

## 快捷键

菜单里的快捷键，macOS 用 `⌘`，Windows 用 `Ctrl`。

| 动作 | macOS | Windows |
| --- | --- | --- |
| 切换账号 | ⌘1 – ⌘9 | 点侧边栏 |
| 新建标签页 | ⌘T | Ctrl+T |
| 关闭标签页 | ⌘W | Ctrl+W |
| 新建窗口 | ⌘N | Ctrl+N |
| 上一个 / 下一个标签页 | ⌘⇧[ / ⌘⇧] | Ctrl+Shift+[ / ] |
| 后退 / 前进 | ⌘[ / ⌘] | Ctrl+[ / ] |
| 收藏此页 | ⌘D | Ctrl+D |
| 页内查找 | ⌘F | Ctrl+F |
| 查找下一个 / 上一个 | ⌘G / ⌘⇧G | Ctrl+G / Ctrl+Shift+G |
| 刷新 | ⌘R | Ctrl+R |
| 收起侧边栏 | ⌘B | Ctrl+B |
| 放大 / 缩小 / 还原 | ⌘= / ⌘- / ⌘0 | Ctrl+= / Ctrl+- / Ctrl+0 |
| 开发者工具 | ⌘⌥I | Ctrl+Alt+I |

---

## 隐私

WorkPier 跑在你自己的电脑上。打开的网页只在你和那个网站之间。WorkPier 不加统计，崩溃记录也不上传。

- 保存的密码在磁盘上是加密的。macOS 的密钥放在登录钥匙串里，Windows 的密钥只属于当前这个 Windows 用户。网页里的脚本读不回 WorkPier 替你存的密码。
- 账号数据在 macOS 的 `~/Library/Application Support/WorkPier`，Windows 的 `%APPDATA%\WorkPier`。
- 想彻底重来，先退出 WorkPier，再删掉这个文件夹。

---

## 反馈

- [提一个问题，或说一个想要的功能](https://github.com/SirKayZh/workpier/issues/new)

---

## 开发

```bash
git clone https://github.com/SirKayZh/workpier.git
cd workpier
npm install          # 需要 Node >= 22.12
npm run typecheck
npm test
npm start
```

不想碰到自己正在用的账号时，换一个数据目录：

```bash
WORKPIER_DATA_DIR=/tmp/workpier-dev npm start
```

```bash
npm run package            # macOS Apple 芯片 → release/WorkPier.app、dmg、更新包
./scripts/package-win.sh   # Windows x64 绿色包，并写进同一份 update.json
```

安装包默认检查 `https://github.com/SirKayZh/workpier/releases/latest/download/update.json`。发版时要同时带上 macOS 更新包和 Windows 更新包，否则 Windows 上的用户会看到一个自己装不上的更新。

---

## 许可证

[MIT](LICENSE) © 2026 SirKayZh
