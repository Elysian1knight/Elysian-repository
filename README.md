# dsh-salon

侧栏里的一个聊天入口。点开是一间屋：你把**已经开过的会话**叫进来，@ 它的名字，它就在屋里说话；
它回的话，自动落回屋里。

## 三条规矩

1. 屋里坐的是现成的会话——不建新会话、不碰预设补丁、不编会话号。
   只列「登记过的工作区里、没归档」的会话：归档的先在 DSH 里恢复，没登记的屋子不进来，子代理不算。
2. 房间自己记：`state/room.json` 里只有 sessionId；名字默认跟会话自己的命名走。
   你自己改过的昵称/头像字存在 `state/names.json`（键是 sessionId，屋主用 `owner`），留空就回到默认。
   两间重名就加尾号；尾号不巧又撞上真名，就一路加下去，直到没人用过。
   自己改名撞上别人会被挡下来（400）——两个同名的人在屋里，`to`、`from`、`@` 全都会认错人。
   房间自己的名字（默认「群聊」）存在 `state/room.json` 的 `title` 里，设置窗改，留空就回默认。
3. 投不进去就说没投进去。只有真的进了会话，才回「送到了」。
   栏里选的人屋里没有，也会明说「没叫人」，不悄悄丢掉。
   没送到的人还会在账上补一条系统行（`#序号 某某：没叫醒（原因）`）——发送方那行小字一刷新就没了，
   账上这条才留得住。

## 安全边界（都是本机）

- 附件回放一律 `X-Content-Type-Options: nosniff`；**svg 不当页面给**，改成 `application/octet-stream` + `Content-Disposition: attachment`。
  原因是 `/salon/files/` 与 GUI 同源，svg 里的脚本会被当页面执行。
- 上传上限 **32 MB**：超了直接 413，不把整个请求体吞进内存。
- 只接本机来源：带 `Origin` 且不是 `127.0.0.1` / `localhost` 的请求一律 403。
  独立端口只监听 `127.0.0.1`。这挡的是浏览器里别的网页偷偷打本机端口，挡不住本机上的进程。


## 兼容性

这不是官方插件，靠的是 DSH 宿主内部的几个服务：`webServer`、`agents`、`sessionController`、
`workspaceRegistry`、`tools`，以及前端槽位 `sidebar.panellist` 与 `@deepseek-ai/dsh-client-ui-primitives`。
DSH 改这些接口时，它可能一起坏。写的时候（2026-11）对着这套版本调通：

- `sessionController.prompt(request, signal)` —— 第二参是 `AbortSignal`；
- `sessionController.list({})` → `{ items: [{ sessionId, cwd, origin, projections }] }`；
- `workspaceRegistry.archivedSessionIds` 判归档；
- `agents.get(id).agent.followup / steer`、`agents.resume({ resumeSessionId })`。

坏了怎么查：`state/salon.log` 里每次投递都记着走了哪一路、原话是什么。

## 隐私

- 屋里说过的话、附件、诊断日志全落在**本机** `state/` 下，不外传、不联网；`state/` 已经在 `.gitignore` 里。
- 没有外网地址：宿主路由是同源前缀 `/salon`，备用端口只监听 `127.0.0.1`。
- 会话内容会作为上下文出现在被叫醒的那间会话里——这是功能本身，不是泄露；但**别在不该看的会话里拉它进屋**。

## 装

### 从 npm 装（推荐）

```
dsh plugin add dsh-salon
```

装完重启 DSH。仓库里带着一份默认的 `cordis.patch.yml`（只有 `mode: room` 和 `port: 40765`），
不用改就能跑；要改端口或限定工作区再动它。

### 从源码装（改代码、或者还没发版时）

DSH 的 profile 目录一般是 `<DSH_HOME>/profiles/desktop`（Windows 上通常在 `%USERPROFILE%\.dsh`）。
下面把插件放在 `<插件目录>`，也就是你克隆下来的这个文件夹。

1. 做一条联接，让 profile 能解析包名：

```
:: Windows
mklink /J "<DSH_HOME>\profiles\desktop\node_modules\dsh-salon" "<插件目录>"

# macOS / Linux
ln -s "<插件目录>" "<DSH_HOME>/profiles/desktop/node_modules/dsh-salon"
```

2. 配置：仓库里的 `cordis.patch.yml` 就是默认配置，直接用；想留一份自己的，复制
`cordis.patch.example.yml` 改名 `cordis.local.yml`，或者直接改 `cordis.patch.yml`（改完别提交）。

只写死一样必要的东西就够：`port`（默认 40765）。其余留空有默认值——账落在插件自己的 `state/`，
屋主名字叫「屋主」，工作区不筛（但已归档的会话与子代理永远不会进店）。
只让某几个工作区进店时，再往 `workspaces:` 里列绝对路径。

3. profile 的 `package.json` 里两处（改前先备份）：

```json
"dependencies": { "dsh-salon": "link:<插件目录>" }
"dsh": { "profile": { "bundles": [ "...", "dsh-salon" ] } }
```

4. 重启 DSH。


## 用法

- 左侧活动栏出现「群聊」图标，点开是屋子。
- 右上角齿轮 → 挑一间会话 → 「叫进来」。名字不用写，进屋就叫它自己的名字。
- 哪些工作区算数，写在 `cordis.patch.yml` 的 `workspaces:` 列表里（绝对路径，一行一个）；
  整段不写＝不按工作区筛，但仍然排除已归档的会话与子代理。
- 屋里的人在名单上的名字，就是**那间会话自己的命名**：会话叫「汐的会话」，栏里就是「汐的会话」；
  在 DSH 里改了名，屋里跟着改（不另存一份名字，也不让你在设置里另起）。两间重名会各带一段尾号。
- 说话前在输入框上面的「发给」里选一个人——指向靠这一栏，不靠正文里的 `@`。
  选「不叫人」就只是留个话，不花钱、不叫醒人；正文里写 `@名字` 只有当没选人时才算数（退路）。
  点「所有人」之后再点掉某个人：会把这一个从名单里换成剩下的人的显式名单，不是留着「所有人」再减。
- 「叫醒方式」两档：**排队**（它把手头这轮跑完再看，不打断）/ **打断**（插进它当前这一步，`mode:'steer'`）。
  默认排队——屋里来人，不该把正在干的长活掀了。
- 附件：回形针按钮、直接粘贴、或者把文件拖进面板都行。文件先传到 `state/files/`，
  再随话一起落账；叫醒对方时给的是**磁盘上的绝对路径**，它用自己的文件工具去开。
  图片显示成缩略图，其他显示成纸夹。只发附件不写字也可以。
- 内容列宽可调：左右各一条把手，**拖的是内容列的宽度，不是内边距**——照 DSH 会话页那套
  （`dsh-client-ui-conversation` 的 `WidthHandle`）：宽度落在 CSS 变量 `--salon-content-width` 上，
  把手位置由 CSS 的 `calc()` 算，函数只维护一个数。
  公式照抄：最小 640，两侧边距预算 176，没拖过时 `clamp(680, 列宽×0.64, 920)`；
  指针每动 1px 内容列宽变 2px（左右各吃一半）；松手才写 `localStorage['salon.contentWidth']`，
  双击回默认（删掉那条偏好）。拖动时整块面板不选中文字。
- 昵称与头像字：设置里每人一行（屋主也有一行），左边填昵称、右边填头像那个字。
  按回车或点别处就存下。**留空＝回到默认**：名字跟着会话自己的命名，头像字取名字第一个字。
  改过的东西存在 `state/names.json`，键是会话 id（屋主用 `owner`），账本里不写——账是说过的话，名字是门牌。
- 指向（「发给」）：可以一次点好几个人，点一下选中、再点一下取消；「所有人」是单独一个按钮。
  选「所有人」＝屋里每个人（除了说这话的人自己）都收到一条叫醒；账上落的是当场那几个名字，不落「*」。
  选错了、屋里没有这个名字，会明说「没叫人」，不悄悄丢掉。
- 群聊名称：设置窗最上面一行。留空＝「群聊」，最多 24 字，回车或点别处就存。
  改的是这间屋的门牌，不是谁的昵称；加人、移人都不会顺手把它冲掉。
- 屋里的话**不往叫醒的话里塞**：只给一句「要看前后文用 `salon_read`，不想看就不看」。
  那间会话自己决定要不要读——读不读、读多少，按 `since`/`limit` 拉（默认最近 20 条，上限 200）。
- 投递走宿主的会话服务（`sessionController.prompt(request, signal)`）：**第二个参数是 AbortSignal**，
  不是消息来源——它进来第一行就是 `signal.throwIfAborted()`，塞错了就报
  `signal.throwIfAborted is not a function`（11-14 踩过）。来源由它自己按 `requestId` 拼。
  这一条冷的热的都管：内部先 `resolveAgent(sessionId)`，再按 `mode` 走 `followup`（queue）或 `steer`（插话）。
  它不成才退回 `agents.get().followup` → `steer` → `agents.resume` 再投；每一步失败都写进 `state/salon.log`，
  带原话和堆栈头四行。全败时如实说「没叫醒（原因）」，绝不回「已送达」。
- 会话回的话，由 `session/event` 捞回来落账；带工具调用的中间叙述不落。

## 渲染

屋里的话用 **DSH 自己的 Markdown 渲染器**（`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`），
所以表格、脚注、代码块工具栏、图片这些跟 DSH 会话窗里是同一套东西，不用我们自己拼。
两条退路写在 `client.js` 里：拿不到那个模块，就退回本地的 `Md`（粗体/行内码/代码块/标题/引用/列表/链接/图片）；
渲染中途抛错，`MdGuard` 接住改走 `Md`，面板不会白掉。

图片地址只认两种：`http(s)://` 与屋里的 `/salon/files/…`；别的当文字显示，不出破图。
正文里的 HTML 不执行（原样显示）——不给自己屋里开注入口子。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/salon/api/messages?since=` | 读账 |
| GET | `/salon/api/status` | 屋主与屋里的人 |
| GET | `/salon/api/config` | 屋里的人 + 可叫的会话 |
| POST | `/salon/api/say` | `{ text?, to?, from?, files?, mode? }`（`to` 是名字数组；写 `*` 或「所有人」＝全体）（`to` 是名字数组，不给才退回正文里的 `@`；`mode` 是 `queue`/`steer`；`files` 是上传返回的 `stored` 列表） |
| POST | `/salon/api/upload?name=` | 裸字节入库，回 `{ ok, file:{ name, stored, size, type, url } }` |
| GET | `/salon/files/<stored>` | 取附件（只认 `files/` 里的一层名字，`..` 一律 404） |
| POST | `/salon/api/member/add` | `{ sessionId }` |
| POST | `/salon/api/member/remove` | `{ name }` |
| POST | `/salon/api/title` | `{ title }`（留空回「群聊」，最多 24 字） |
| POST | `/salon/api/name` | `{ target, name?, initial? }`（`target` 是 `owner`／会话 id／屋里现在的名字；留空回默认） |

## 测试

```
node test-room.mjs
```

假宿主、真 HTTP：列会话、叫进来、@ 投递、回话落账、投递失败要说没送到、移出、没有会话服务时要说出来；
附件上传与取件（含 `..` 穿越要 404、空文件不收）、打断/排队真的落到 `mode`、
`salon_read` 挂上且读得到屋里的话、叫醒的话里不再塞旧账。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `index.js` | 宿主那一半：HTTP 路由、投递、落账、`salon_read` 工具 |
| `client.js` | 窗口那一半：侧栏图标、面板、设置窗（走宿主 token 与宿主 Markdown 渲染器） |
| `src/room.js` | 账本的读写（append-only、`seq` 串行、坏行跳过） |
| `cordis.patch.example.yml` | 配置样板，复制成 `cordis.patch.yml` |
| `docs/BUILD-SPEC-full.md` | 完整的实现规格：宿主契约、投递四步、接口表、验收清单、12 个已知坑 |
| `docs/BUILD-SPEC-short.md` | 上面那份的短版（92 行），适合直接丢给别的 AI 复刻 |
| `test-room.mjs` | 离线测试（假宿主 + 真 HTTP + 临时目录） |

## 许可

MIT，见 `LICENSE`。
