# ClipHistory — Windows 本地剪贴板历史工具

> 本文件是本项目「总指引」。任何 AI 助手 / 协作者在此项目工作前，先读本文件。
> 本文件内的路径与约定即为标准，改动代码前先核对这里。

---

## 一、项目概述

本地剪贴板历史记录工具，运行于 Windows，目标用户是零基础小白。

- **全程离线**：不联网、不上传任何剪贴板数据，数据只保存在本机。
- **捕获范围**：纯文本、截图图片、网页图片、资源管理器复制的文件。
- **核心功能**：卡片列表（按复制时间倒序）、点击一键重新复制、置顶、单条删除、备注、关键词搜索、系统托盘常驻、开机自启、按 1/3/5 天自动清理过期记录（**置顶记录不参与自动清理**）。
- **交付物**：完整可运行源码 + electron-builder 打包的 exe 安装包 + 面向零基础的 `docs/教程.md`。

## 二、技术栈与关键决策（改动前先确认理由）

| 项 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | Electron | 易打包、界面友好、可直接双击运行 |
| 渲染层 | 纯 HTML/CSS/JS，renderer 直接 `loadFile` | 无构建步骤、零框架依赖，小白易读；**禁止**引入 React / Vite / Webpack 等构建链 |
| 剪贴板监听 | 主进程 `setInterval` ~800ms 轮询 `clipboard.availableFormats()` | 避开需要 node-gyp / VS Build Tools 的原生监听模块（clipboard-event 等），小白装不了编译环境 |
| 数据库 | sql.js（SQLite 编译为 WASM，纯 JS） | 无原生依赖；`db.export()` 写文件持久化。**禁止**使用 better-sqlite3 等需 rebuild 的模块 |
| 图片存储 | PNG 落盘 + 缩略图，DB 只存文件名 | 避免大图塞进数据库 |
| 图片显示 | 自定义协议 `clipimg://`（`protocol.handle` + `net.fetch(pathToFileURL)`） | 按需加载、不占内存 |
| 文件复制记录 | 保存 `FileNameW` 原始 Buffer，点击时 `clipboard.writeBuffer` 恢复 | 支持把复制的文件原样再粘贴出来 |
| 托盘 | `Tray` + 窗口 close 时隐藏 | 后台常驻静默监听 |
| 开机自启 | `app.setLoginItemSettings({ openAtLogin })` | 无额外依赖 |
| 打包 | electron-builder NSIS 单 exe | 一键安装，小白可双击 |

## 三、标准文件路径

### 源码结构

| 作用 | 标准路径 |
|---|---|
| 主进程入口（窗口、协议、生命周期、装配各模块） | [src/main.js](src/main.js) |
| 预加载安全层（contextBridge 暴露 `window.clipHistory`） | [src/preload.js](src/preload.js) |
| 数据库封装（sql.js wasm 加载、建表、CRUD、防抖保存） | [src/db.js](src/db.js) |
| 业务层（插入去重、复制回写、置顶/删除/备注、清理定时） | [src/store.js](src/store.js) |
| 剪贴板轮询监听（类型识别、hash 去重、echo 抑制） | [src/clipboard-monitor.js](src/clipboard-monitor.js) |
| IPC 注册（全部 `ipcMain.handle`） | [src/ipc.js](src/ipc.js) |
| 托盘创建与退出逻辑 | [src/tray.js](src/tray.js) |
| 界面 HTML（搜索框 + 卡片列表 + 设置面板） | [renderer/index.html](renderer/index.html) |
| 界面样式（卡片 / 置顶 / 缩略图 / 搜索） | [renderer/style.css](renderer/style.css) |
| 界面逻辑（渲染卡片、搜索筛选、调 IPC） | [renderer/app.js](renderer/app.js) |
| 应用 / 安装包图标（256×256 PNG） | [build/icon.png](build/icon.png) |
| 托盘图标（32×32 PNG） | [build/tray-icon.png](build/tray-icon.png) |
| 打包配置（`build` 字段）与脚本 | [package.json](package.json) |
| 国内镜像加速 | [.npmrc](.npmrc) |
| 零基础分步教程 | [docs/教程.md](docs/教程.md) |

### 运行时数据（不在项目目录内，重装 / 更新不丢）

```
%APPDATA%\ClipHistory\
  ├─ clipboard.db      # SQLite 数据库（sql.js 导出）
  └─ images\           # 图片记录 <id>.png（及可选缩略图）
```

## 四、数据表结构

```sql
CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,          -- crypto.randomUUID()
  type        TEXT NOT NULL,             -- 'text' | 'image' | 'files'
  content     TEXT,                      -- text：完整文本（预览/搜索/回写）
  hash        TEXT NOT NULL,             -- 去重指纹（sha256）
  image_name  TEXT,                      -- image：images 目录下的文件名
  file_buf    TEXT,                      -- files：FileNameW 原始 Buffer 的 base64
  file_names  TEXT,                      -- files：路径列表 JSON（卡片显示）
  remark      TEXT NOT NULL DEFAULT '',  -- 备注（图片/文件靠它检索）
  pinned      INTEGER NOT NULL DEFAULT 0,-- 0/1
  pinned_at   INTEGER,                   -- 置顶时间（置顶组内排序）
  created_at  INTEGER NOT NULL,          -- 显示时间；重复复制时刷新
  updated_at  INTEGER
);
CREATE INDEX idx_records_created ON records(created_at DESC);
CREATE INDEX idx_records_hash   ON records(hash);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- key: 'retention_days' | 'autostart'
```

## 五、通信契约（IPC）

renderer 只能通过 `window.clipHistory` 与主进程通信（contextIsolation + contextBridge，禁用 nodeIntegration）。

| channel | 参数 | 说明 |
|---|---|---|
| `clip:loadList` | — | 返回按排序规则排好的记录数组 |
| `clip:copy` | `{ id }` | 按 type 回写剪贴板并设置 echo 抑制 |
| `clip:pin` | `{ id, pinned }` | 置顶 / 取消（置顶时写 pinned_at） |
| `clip:del` | `{ id }` | 删除记录 + 同步删除图片文件 |
| `clip:remark` | `{ id, remark }` | 设置备注 |
| `clip:getSettings` | — | 返回 retentionDays / autostart |
| `clip:setSettings` | `{ retentionDays?, autostart? }` | 生效自启 + 立即触发一次清理 |
| `clip:quit` | — | 真正退出（托盘退出） |
| `clip:changed` | （主进程→renderer 推送） | renderer 收到后重新 loadList |

**搜索在 renderer 端做**：`loadList` 一次取回紧凑数据，renderer 端 `input` 防抖 ~150ms 本地过滤。文本匹配 `content`；图片 / 文件匹配 `remark`。

## 六、核心逻辑约定（改动时特别注意）

1. **去重指纹**：文本 `sha256(utf8(text))`；图片 `sha256(image.toBitmap())`（**像素级**，不用 PNG 字节，保证同一图像稳定去重）；文件 `sha256(FileNameW buffer)`。
2. **重复内容**：hash 命中已有记录时只刷新 `created_at`，**不新增**记录、不重复落盘。
3. **echo 抑制**：用户点卡片回写剪贴板后，2 秒内轮询读到相同 hash 必须跳过（同时更新 `lastHash`），防止误新增 / 误刷新。
4. **类型识别优先级**：含 `FileNameW` / `FileName` → files；`readImage()` 非空 → image；`readText()` 非空白 → text；空白内容直接跳过。
5. **排序**：`ORDER BY pinned DESC, COALESCE(pinned_at, created_at) DESC, created_at DESC`（置顶组永远在顶部，不被新记录挤下去）。
6. **清理**：启动时 + 每小时定时，删除 `pinned = 0 AND created_at < now - 留存天数` 的记录，并同步删除图片文件、回收孤儿图片。留存可选 1 / 3 / 5 天。
7. **sql.js 打包**：用 `wasmBinary` 直接读 asar 内字节加载 wasm（`require.resolve('sql.js/dist/sql-wasm.wasm')`），避开 locateFile 路径问题。
8. **安全**：窗口参数 `contextIsolation: true, nodeIntegration: false, sandbox: true`；HTML 加 CSP（`default-src 'self'; img-src 'self' clipimg: data:`）。
9. **托盘**：`close` 事件 `preventDefault + hide()`，仅 `isQuiting` 时放行；`requestSingleInstanceLock()` 防双开。

## 七、开发命令

```bash
npm install        # 安装依赖（配合 .npmrc 国内镜像加速）
npm start          # 本地启动测试
npm run dist       # 打包 Windows exe 安装包（输出到 dist/）
```

## 八、隐私红线（绝对遵守）

- 不引入任何网络请求库、不发起任何网络请求；数据只写入本机 `%APPDATA%\ClipHistory\`。
- renderer 的 CSP 白名单从代码层面禁止加载任何远程内容。
- 剪贴板数据（文本 / 图片 / 文件）任何情况下都不允许离开本机。

## 九、端到端验证清单

- 复制文本 → 出现文本卡片；复制空白 / 空格 → 不记录。
- 连续复制相同内容 → 只保留一条且时间刷新为最新。
- 截图 / 网页图 → 图片卡片（不是文字卡片）。
- 复制文件 → 文件卡片；点击后在目标文件夹粘贴能得到原文件。
- 置顶旧记录后再复制新内容 → 置顶记录不被挤下去。
- 单条删除 → 卡片消失，图片文件同步删除。
- 搜索：文本按内容命中；图片 / 文件按备注命中。
- 清理：造一条过期记录，留存设为 1 天 → 过期普通记录被删、置顶的保留。
- 关窗口 → 隐藏到托盘；托盘退出 → 真退出；重启 → 数据与图片仍在。
- 开机自启开关 → 注册表 Run 键出现 / 消失对应条目。
- `npm run dist` 打包安装 exe 后，以上全部复测通过。

## 十、沟通语言

全程中文回复；代码注释 / 标识符可用英文。
