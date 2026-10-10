# WAB — WhatsApp 多账号客户去重

TikTok 引流到 WhatsApp，多个账号分别跑在 AdsPower 不同环境里，彼此看不到对方的客户。
WAB 在每个环境里装一个 Chrome 扩展，自动读取 WhatsApp Web 的聊天列表并上报到**本机**的一个小服务；
同一个客户出现在两个以上账号时，直接在 WhatsApp Web 页面上提醒，并在总览面板里汇总。

```
AdsPower 环境 1 (WhatsApp Web + 扩展) ─┐
AdsPower 环境 2 (WhatsApp Web + 扩展) ─┼─► http://127.0.0.1:3900  (Node + SQLite) ─► 总览面板
AdsPower 环境 N (WhatsApp Web + 扩展) ─┘
```

所有数据都在本机 `server/data/wab.db`，不上传任何地方。扩展**只读**聊天列表，不发消息、不改任何设置。

---

## 一、安装服务（只做一次）

需要 Node.js 20 以上（<https://nodejs.org> 下载 LTS 版装上即可）。Windows / macOS 都可以。

```bash
cd WAB
npm install
```

### 临时启动（第一次跑、调试用）

- Windows：双击 `windows\start-wab.cmd`（或命令行 `npm run dev`）
- macOS：`npm run dev`

打开 <http://127.0.0.1:3900> 就是总览面板。关掉窗口服务就停。

### 开机自启（推荐）

**Windows**：双击 `windows\install-autostart.cmd`。
它会编译服务端，注册一个名为「WAB Server」的计划任务：登录时后台启动（无黑窗口），崩溃后 1 分钟内自动重启。
日志在 `server\data\server.log`。卸载双击 `windows\uninstall-autostart.cmd`。
（在「任务计划程序」里也能看到和管理这个任务。）

**macOS**：`./launchd/install.sh`，卸载 `./launchd/uninstall.sh`。日志在 `server/data/server.log`。

---

## 二、打包扩展

```bash
npm run build:ext -- --zip
```

或者直接 `cd extension && npm run zip`。产物：`extension/wab-extension.zip`（解压版在 `extension/dist/`）。
打包是纯 Node 实现，Windows 上不需要装任何压缩工具。

---

## 三、装进 AdsPower

1. 打开 AdsPower 客户端 → 左侧「应用中心」（或「扩展」/「插件」，不同版本名字略有差别）
2. 「上传扩展」/「自定义扩展」→ 选 `extension/wab-extension.zip`
3. 把它应用到**全部环境**（或你跑 WhatsApp 的那个分组）
4. 打开任意一个环境，进入 <https://web.whatsapp.com>，登录后右下角会出现 **WAB** 按钮：
   - 绿色 `WAB ✓`：已同步，本账号没有重复客户
   - 红色 `WAB ⚠ 3`：本账号有 3 个客户也出现在别的账号里，点开看名单，点名单可直接跳到那个聊天
   - 灰色 `WAB ✕`：连不上服务，点开看错误
5. 浏览器工具栏里的扩展图标（红色感叹号）点开是状态 popup，可以手动「立即同步」、改服务地址、打开总览面板

> **首次部署务必验证**：AdsPower 环境一般配了代理。Chromium 默认不会把 127.0.0.1 走代理，
> 但如果 popup 里报"无法连接 http://127.0.0.1:3900"，去该环境的代理设置里把
> `127.0.0.1,localhost` 加进「代理例外 / 不走代理」列表。

> 需要 AdsPower 内核版本对应 **Chrome 111 以上**（扩展用了 Manifest V3 的 `world: "MAIN"`）。

---

## 四、日常使用

### 页面上的提醒

- **聊天列表**：重复客户的那一行左上角有红色 ⚠ 角标，鼠标悬停显示它还在哪些账号出现过
- **打开聊天**：顶部出现红色横幅「此客户已在账号 美区-2 出现过（首次 2026-10-01）」，带状态和备注
- **新客户刚进来**：收到第一条消息时立即查重，有重复会在页面顶部弹 toast，同时弹系统通知（Windows 为托盘气泡，macOS 为通知中心）

### 同步时机

打开 WhatsApp Web 后立即同步一次，之后每 5 分钟全量同步一次；新消息到达时即时同步那一个聊天。
也可以点右下角面板里的「立即同步」。

### 总览面板 <http://127.0.0.1:3900>

- 顶部「**每日进粉**」：账号 × 日期的表格，每格是该账号当天新进的客户数，红色「重 N」表示其中 N 个之前已在别的账号出现过；
  第一行是全部账号合计和**净新客**（去掉重复后真正的新客户）。可选近 7 / 14 / 30 天，「导出 CSV」导出同样的表。
  按这台电脑的时区切天。账号刚接入时（首次同步后 10 分钟内）导入的历史聊天不算进粉
- 默认「只看重复」。可以按账号、状态筛选，搜索号码 / 名称
- 每个客户可改**状态**（新客户 / 跟进中 / 已成交 / 已流失）和**备注**，会同步显示到所有环境的横幅里
- 「账号」区域给每个号起**别名**（如「美区-2」），提醒里就显示别名而不是号码
- 「导出 CSV」导出当前筛选结果

---

## 五、客户是怎么识别的

- 客户唯一标识 = **手机号**（E.164 纯数字，如 `8613800138000`）
- WhatsApp 正在逐步用 **LID**（`xxx@lid`，隐藏号码的匿名 ID）代替号码。扩展会同时记录号码和 LID，
  并用 wa-js 的 `getPnLidEntry` 做互查；只要号码或 LID 任一相同，就算同一个客户
- 如果某个客户先以 LID 出现、后来又解析出了号码，两条记录会自动合并
- 群聊、广播、频道一律忽略

**已知限制**：同一个人换了手机号，目前识别不了（可以在面板里手动备注）。

---

## 六、目录结构

```
server/            Node + Fastify + SQLite（node:sqlite，零原生依赖）
  src/db.ts        数据模型、合并与去重逻辑
  src/routes/      /api/sync /api/check /api/customers /api/accounts /api/stats /api/daily /api/export.csv
  public/          总览面板（纯 HTML/JS，无 CDN 依赖）
  data/wab.db      数据库（自动生成）
extension/         Chrome 扩展（Manifest V3，esbuild 打包）
  src/inject.ts    页面主世界：加载 wa-js，读聊天列表、监听新消息
  src/content.ts   隔离世界：调服务、渲染角标 / 横幅 / 浮动面板
  src/background.ts  service worker：实际向 127.0.0.1 发请求
  src/popup.*      扩展图标的弹窗
windows/           Windows 开机自启（计划任务）
launchd/           macOS 开机自启
```

## 七、API（给以后扩展用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sync` | `{ account:{wid,phone?,alias?}, chats:[{phone?,lid?,pushname?,lastMsgAt?}] }` → 返回本账号的重复名单 |
| GET | `/api/check?wid=…&excludeAccount=…` | 单个客户查重 |
| GET | `/api/customers?dup=1&account=&status=&q=&limit=&offset=` | 客户列表 |
| PATCH | `/api/customers/:id` | `{ status?, note?, displayName?, source? }` |
| GET | `/api/accounts` / PATCH `/api/accounts/:id` | 账号列表、改别名 |
| GET | `/api/stats` | 统计（含 `fansToday` 今日进粉、`fansTodayDup` 其中重复） |
| GET | `/api/daily?days=14` | 每日进粉：`{ days, accounts, cells[accountId][day]: {total,dup}, totals[day]: {total,dup,unique} }` |
| GET | `/api/daily.csv?days=14` | 每日进粉导出（账号 × 日期） |
| GET | `/api/export.csv?dup=1` | 导出 |

环境变量：`WAB_PORT`（默认 3900）、`WAB_DB`（数据库路径）、`WAB_NOTIFY=0` 关闭系统通知。

## 八、测试

```bash
npm test
```

服务端单元测试：号码归一化、跨账号去重、LID 合并等。

```bash
npm run e2e
```

扩展端到端测试：用 Chrome for Testing 加载扩展，打开一个模拟 WhatsApp Web 页面（相同 DOM 结构，wa-js 换成读假数据的模拟实现），
真实走一遍「上报服务 → 角标 → 横幅 → 新消息即时查重 → 浮动面板 → popup 状态」。
需要 Chrome for Testing 或 Chromium（正式版 Chrome 不允许命令行加载扩展），没有的话先装：

```bash
npx @puppeteer/browsers install chrome@stable
```

截图输出在 `extension/test/screenshots/`。注意：这个测试验证的是扩展自身的逻辑，**不能**代替在真实 WhatsApp Web 上验证 wa-js 的字段。

## 九、备份

数据库只有一个文件：`server/data/wab.db`，定期拷贝即可（服务运行中拷贝也安全，SQLite WAL 模式）。

## 十、更新

代码在 GitHub 私有仓库 <https://github.com/1Time6/wab>。

### 第一次：用 git 装（只做一次）

1. 装 Git for Windows：<https://git-scm.com/download/win>（一路下一步）
2. 打开命令行，克隆到你想放的位置（会弹浏览器让你登录 GitHub 授权）：

   ```bat
   git clone https://github.com/1Time6/wab.git C:\WAB
   cd C:\WAB
   npm install
   ```

3. 如果之前已经在别的文件夹跑过 WAB：先双击旧文件夹里的 `windows\uninstall-autostart.cmd`，
   再把旧的 `server\data\wab.db` 拷到 `C:\WAB\server\data\` 下（没有 data 文件夹就新建一个）
4. 双击 `C:\WAB\windows\install-autostart.cmd`

### 以后每次更新

双击 **`windows\update.cmd`**。它会：

1. 从 GitHub 拉最新代码（本地改过文件会停下来提示，不会覆盖）
2. 装依赖、编译服务端、重新打包扩展
3. 重启后台服务并检查是否起来了（编译失败就不动旧服务）
4. 如果这次更新改了扩展，会提醒你把 `extension\wab-extension.zip` 重新上传到 AdsPower

已经是最新时什么都不做；想强制重新编译重启，命令行执行 `windows\update.cmd -Force`。
