# 生成提示：做一个「侧栏聊天室」DSH 插件（dsh-salon）

> 把这一整份文件交给你的 AI，让它按里面的规格从零生成代码。
> 你在 DSH（DeepSeek Harness）里跑它。全文是规格与验收标准，不是示意。

---

## 0. 一句话任务

在 DSH 桌面端的左侧栏加一个聊天入口：点开是一间「屋」，你可以在设置里把**已经存在的会话**叫进来，被叫进来的会话能在屋里说话、也能看见别人说话；说话方式是在输入框里写字、选「发给谁」，投递成功与失败都必须如实回报，不许假称「已送达」。

产物是一个 DSH 插件包（一个 npm 包 + 一条 bundle patch + 一个客户端模块），零第三方依赖，只用 Node 内置模块和 DSH 宿主提供的服务。

---

## 1. 硬约束

1. 只用 Node 内置模块（`node:fs/promises`、`node:path`、`node:http`、`node:crypto`）与宿主注入的服务；不引入任何 npm 依赖。
2. **不要**建会话，**不要**改预设补丁，**不要**在预设里挂任何模块。屋里坐的是「已经存在的会话」——按 `sessionId` 认人。
3. 所有状态落在插件自己的目录：`<stateDir>/room.jsonl`（账）、`<stateDir>/room.json`（名单与房间名）、`<stateDir>/names.json`（昵称与头像字）、`<stateDir>/files/`（附件）、`<stateDir>/salon.log`（诊断日志）。
4. 账本 append-only：只追加，不改别人的行。
5. 一切「送没送到」必须能区分：成功与失败分开报，失败要带原因。
6. 中文界面，文案自己写清楚，不写「已送达」当兜底。

---

## 2. 宿主契约（照抄，不要自己发明）

### 2.1 包结构

```
dsh-salon/
  package.json
  cordis.patch.yml
  index.js          # 宿主那一半（服务端）
  client.js         # 窗口那一半（浏览器端）
  src/room.js       # 账本读写
  test-room.mjs     # 离线自测（假宿主 + 真 HTTP）
  README.md
```

### 2.2 package.json

```json
{
  "name": "dsh-salon",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-modules"
      ],
      "platform": "web"
    }
  }
}
```

要点：
- `exports` 必须有 `"./client"`。漏了它，宿主解析 `dsh-salon/client` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，整个插件起不来（HTTP 路由也一起没有）。
- `dsh.client.inject` 的模块名要写在 `exports` 之外也能被宿主解析；`platform: "web"` 表示只在 Web GUI 加载。

### 2.3 cordis.patch.yml（插件自己的默认配置）

只能有**一条**顶层 `- insert:`：

```yaml
- insert:
    - id: salon-room
      name: dsh-salon
      config:
        mode: room
        port: 40765
        stateDir: <插件目录>/state
        owner: <屋主的名字>
        workspaces:
          - <工作区绝对路径 1>
          - <工作区绝对路径 2>
```

`workspaces` 决定「哪些会话能被叫进来」：只列这些目录下、未归档、非子代理的会话。

### 2.4 服务端模块形状

```js
export const name = 'salon-room';
export const inject = ['webServer', 'tools'];   // 声明依赖，宿主才会等它们就绪
export function apply(ctx, rawConfig) { … }
```

- `inject` 必须显式声明会用到的服务。用 `ctx.get('x')` 摸服务而不声明，取不到时会**静默**跳过，症状是「插件不报错、路由全 404」。
- 用 `ctx.effect(fn, 'label')` 包住全部注册，`fn` 返回 dispose 函数。
- 服务取法统一写 `ctx.webServer ?? ctx.get?.('webServer')` 这种双写法，兼容两种注入形态。

### 2.5 客户端模块形状

`client.js` 不是普通 ES 模块，必须用宿主的模块加载器包一层：

```js
window.__ModuleLoader__.load({
  id: 'dsh-salon',            // 必须等于包名
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef, useMemo } = React;

    let DSH_MARKDOWN = null;
    try { DSH_MARKDOWN = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText || null; } catch {}

    function apply(ctx) { … }

    exports.name = 'dsh-salon';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
```

可 `require` 的模块只有宿主静态模块表里那几个：`react`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。**不要** `require` 自己的相对路径模块（客户端只有一个文件，全部内联）。

---

## 3. 服务端规格（index.js）

### 3.1 配置归一

`normalize(raw)` 产出 `{ mode, port, stateDir, owner, workspaces }`：
- `mode` 只认 `'room'`；
- `port` 默认 `40765`；
- `stateDir` 默认 `<插件目录>/state`，绝对化；
- `owner` 必填，缺失时启动直接抛错（不许猜）；
- `workspaces` 是字符串数组，绝对路径，去尾斜杠。

### 3.2 会话枚举（谁能进店）

```js
async function listSessions() {
  const controller = ctx.get('sessionController');
  const out = await controller?.list({});          // { items: [{ sessionId, cwd, running, origin, projections: { values: { title } } }] }
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? []);
  return (out?.items ?? []).filter(row =>
    row?.sessionId &&
    row.origin !== 'subagent' &&
    !archived.has(row.sessionId) &&
    config.workspaces.some(w => sameDir(row.cwd, w))
  );
}
```
- 枚举一次约 82–195ms（94 间会话实测），需要 10 秒 TTL 缓存；状态查询可以传 `{ fresh: true }` 绕过缓存。
- `sameDir(a,b)`：去尾斜杠 + 转小写再比；Windows 路径大小写不敏感。

### 3.3 名字从哪来

- 默认用会话的标题（`projections.values.title`），空标题 → 「未命名会话」。
- 自己改过（存在 `names.json`，键是 `sessionId`，屋主用 `'owner'`）就用改过的名字。
- 重名一律加后缀直到唯一：先 `基名·<sessionId 后四位>`，还撞就 `基名·<后四位>·<n>`。
- 头像字 = 用户指定的一字，没指定就取名字第一个字符（用 `Array.from(text)[0]`，别用 `text[0]`，emoji 会被劈半）。
- 名字上限 24 字，去换行；改成别人已经叫着的名字 → 400「「X」已经有人叫了——换个名字」。

### 3.4 投递（本插件最容易写错的地方）

```js
async function deliver(member, text, mode = 'queue') {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    // ① 会话服务：能开冷会话，也能投进正被窗口占着的会话
    await ctx.get('sessionController').prompt({
      sessionId: member.sessionId,
      requestId: newId(),
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, abort.signal);
    return '会话服务';
  } catch (error) { /* 记日志，继续 */ }
  // ② 宿主手里那间
  const agent = ctx.get('agents')?.get?.(member.sessionId)?.agent;
  if (typeof agent?.followup === 'function') { … }
  // ②b 会话正跑着时 followup 会落空，插话才是送到眼前的那条
  if (typeof agent?.steer === 'function') { … }
  // ③ 唤醒再投
  const resumed = await ctx.get('agents')?.resume?.({ resumeSessionId: member.sessionId });
  …
  throw new Error(`「${member.name}」那间会话打不开（${member.sessionId}）—— ${每条失败原因}`);
}
```

四个必须遵守的事实：
1. `sessionController.prompt` 的**第二个参数是 `AbortSignal`**，不是消息来源。传对象会得到 `TypeError: signal.throwIfAborted is not a function`。
2. `agents.get(sessionId)` 对**不存在**的会话也会返回一个带 `followup` 的空壳：投进去不报错、什么也不发生。所以成功与否只能以「投递这一路没抛错」为准，并且必须在日志里写清是哪一路。
3. 会话正被窗口占着时 `followup` 会报 `session "…" is already owned by an active write handle`，此时 `steer` 或 `prompt` 才是对的。
4. 投递失败要**逐路记录原因**，最终拼进给用户看的「没叫醒（原因）」里；不许只回一句「已送达」。

`userPayload(text)`（②③ 路用）：
```js
{ id: newId(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: id } }
```

### 3.5 说话（say）

入参 `{ from, text, to, files, mode }`：
- `to` 是名字数组；其中 `'*'`、`'所有人'`、`'@所有人'` 视为「全体」。
- 账上落的**永远是当场那几个真名字**，不落 `*`。
- 没给 `to` 时退回正文里的 `@名字` 解析；ASCII 名字要卡边界（`new RegExp('@'+escaped+'(?![\\w-])')`），中文名用 `includes`，长名字优先匹配。
- 一次可以让多人同时收到：用 `Promise.allSettled` 并行投；串行会让五个人各等 15 秒。
- 投递失败的每个人，要在账上追加一条系统行 `#<seq> <失败说明>`（`kind: 'system'`）。「账上写着 → 某某，看着像送到了」是最坑的一种谎。
- 叫醒的正文要自带上下文起点：`【<房间名> #<seq>】<谁>：<正文>`，附件给磁盘绝对路径，末尾一句「要看前后文用 salon_read（since: <seq-1>），不想看就不看」。
- 返回 `{ ok: true, row, woke: ['名字：会话服务／没叫醒（原因）'] }`。

### 3.6 收话（会话自己说的话进账）

```js
ctx.on('session/event', (session, event) => {
  if (event?.type !== 'assistant/message') return;
  if (event?.surfaceOp === 'prepend') return;          // 历史回放不算新话
  const message = event?.data?.message;
  if (!message?.id || seen.has(message.id)) return;
  seen.add(message.id);                                // Set，上限 400，超了清
  const text = textOf(message.content);                 // 只留 {type:'text'} 块；整条里含 tool-call 就丢
  if (!text) return;
  appendMessage(room, { from: <屋里这位的名字>, text, kind: 'say' });
}, { global: true });
```
只认屋里已绑定成员说的话（用 `sessionId` 反查名字），不认识的会话一律不落账。

### 3.7 附件

- `POST /api/upload?name=<原名>&size=<字节>`，body 是原始字节。
- 落盘名：`<Date.now().toString(36)>-<4 位随机 hex>-<清洗过的原名>`；原名过滤 `[\\/:*?"<>|\x00-\x1f]`、截 120 字；空文件 → 400「空文件不收」。
- 上限 `32 MiB`：先看 `?size=` 早拦，边收边数；超限 → 413「文件太大：上限 32.0 MB」并 `req.destroy()`。
- `GET /files/<stored>`：`path.basename(stored) !== stored` 直接拒（防 `..` 穿越）；统一 `x-content-type-options: nosniff`、`cache-control: no-store`；**svg 一律 `application/octet-stream` + `content-disposition: attachment`**（与 GUI 同源，直接当图片回放会成同源 XSS）。
- 附件对象：`{ name, stored, size, type, url: '/salon/files/<stored>' }`；给会话的正文里写**磁盘绝对路径**。

### 3.8 路由表（全部走同源前缀 `/salon`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/messages?since=<seq>` | 增量读账 `{ rows, last }` |
| GET | `/api/status` | `{ title, owner, ownerInitial, members:[{name,initial,nick,sessionId,archived}], names, rows }` |
| GET | `/api/config` | 设置窗口用：`{ title, owner, ownerInitial, members, sessions:[可叫的会话], workspaces, problem }` |
| POST | `/api/say` | `{ text, to, files, mode }` |
| POST | `/api/title` | `{ title }`，24 字，空 = 「群聊」 |
| POST | `/api/name` | `{ target, name, initial }`，target 可为 `'owner'`／名字／sessionId |
| POST | `/api/upload?name=&size=` | 附件 |
| GET | `/files/<stored>` | 取附件 |
| POST | `/api/member/add` | `{ sessionId }`，把会话叫进来 |
| POST | `/api/member/remove` | `{ name }`，移出（屋主不可移） |

其它一律 JSON 404：`没有这个门：<METHOD> <path>`。

三种注册/挂载方式同时保留：
1. `ctx.webServer.register({ kind:'prefix', path:'/salon', handler })`（面板走这个，同源）；
2. 另开独立端口 `http.createServer` 听 `127.0.0.1:<port>`（兜底与命令行调试）；
3. handler 里**先剥掉 `/salon` 前缀**再进路由，两边共用同一套 `handleApi(method, pathname, searchParams, io)`。

### 3.9 来源校验与响应头

```js
function originAllowed(req) {
  const origin = String(req?.headers?.origin ?? '').trim();
  if (!origin) return true;                       // 本机 curl / node 不带 Origin
  if (origin === 'null') return false;
  try {
    const { hostname } = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch { return false; }
}
```
拒时 403「这个是本机的东西：不接外来的页面」。所有响应统一加 `x-content-type-options: nosniff`。

### 3.10 工具：`salon_read`

注册到宿主工具表，让被叫醒的会话能按需回看屋里的对话（不主动塞，让它自己决定看不看）：

```js
const tools = ctx.tools ?? ctx.get?.('tools');
if (!tools?.register) { log('这个宿主没有 tools 服务：会话读不到屋里的话'); return; }

// 每个字段自带 required 标记，由小工具拼成 JSON Schema
const schema = fields => {
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(fields)) {
    const { required: isRequired, ...rest } = field ?? {};
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  const out = { type: 'object', properties, additionalProperties: false };
  if (required.length) out.required = required;
  return out;
};

tools.register({
  name: 'salon_read',
  description: '读这间屋最近的对话。叫醒你的那句话不包含前后文；要不要看由你决定——不调用就等于没看。',
  parameters: schema({
    since: { type: 'integer', description: '只读序号大于它的（上次读到哪儿），默认 0', required: false },
    limit: { type: 'integer', description: '最多读几条，默认 20', required: false },
  }),
  output: {
    schema: schema({ text: { type: 'string', required: true } }),
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args = {}) {
    // 读账、过滤 row.seq > since、取最近 limit 条
    // 每条一行："#12 20:31 汐：正文　[附件名 → 磁盘绝对路径]"
    return { text: '拼好的多行文本' };      // execute 必须返回 { text }
  },
});
```
默认 `since=0`（读最近 20 条）、`limit` 上限 200；没内容时回「屋里还静着，一句话都没有。」或「序号 N 之后屋里没有人说话。」

### 3.11 启动与日志

启动顺序：注册工具 → 挂 `session/event` → 挂宿主路由 → 开独立端口 → 读 `room.json` 与 `names.json` → 打一行开门日志：

```
门开了：手里 2 位（汐、沧溟）；webServer=有；agents=有
```

所有关键动作双写：`console.log` + 追加 `<stateDir>/salon.log`（时间戳 ISO）。日志里必须能看出「投递走了哪一路、成没成、原话是什么」。

---

## 4. 客户端规格（client.js）

### 4.1 挂载位置

```js
ctx.slots.inject('sidebar.panellist', () => {
  const panel = ctx.slots.register({ name: 'main', key: 'salon' }, () => h(Panel));
  const row = ctx.slots.register({
    name: 'sidebar.panellist', id: 'salon', order: 4,
    label: () => ROOM_TITLE || '群聊',
  }, () => h(Icon));
  return () => { row?.(); panel?.(); };
});
```
- `main` 是「往里注册」的槽，**不能** `ctx.slots.inject('main', …)`——那样不报错、界面全空。
- 面板与侧栏那一行的 key/id 必须一致（都是 `'salon'`），点图标才开面板。

### 4.2 面板结构（自上而下）

1. 顶栏：房间名（点击可改）+ 齿轮（开设置）+ 人数。
2. 消息列：`.salon-flow`，`max-width: var(--dsh-chat-content-width, 748px)`，`margin: 0 auto`，间距 `var(--dsh-chat-flow-gap, 12px)`。
3. 输入区：底栏卡片，含「发给」chips、「叫醒方式」下拉、输入框、回形针、发送。

消息行：
- 屋主：靠右，气泡（`padding: 10px 16px; border-radius: var(--dsw-radius-xl); background: var(--dsw-specific-bubble); font-size: var(--dsh-content-font-size, 14px); line-height: 22px`；宿主自己用的是 `calc(22px + delta)`，跟着它取同一个值即可）。
- 成员：靠左，无气泡；头像（按名字 hash 取色的一枚圆，中间放头像字）+ 名字 + 时刻 + 正文（正文用宿主自己的 Markdown 渲染器）。
- 系统行：居中灰字（加入/移出/投递失败）。

### 4.3 Markdown 与图片

- 优先用宿主渲染器：`require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText`，props `{ text, streaming:false, labels, pathImages }`；`labels` 形如 `{ code:{copyLabel,copiedLabel,toolbarLabels:{codeLabel,wrapLabel,unwrapLabel}}, footnotes }`。
- `pathImages.resolve(value)`：只放行 `http(s)` 与 `/salon/files/`，`/files/` 补上 `/salon` 前缀，其它返回 `undefined`（当文字显示，别出碎图标）。
- 用一个 ErrorBoundary 包住，渲染抛错就退回本地最简渲染，不白屏。
- 拿不到 `MarkdownText` 时退回本地实现（粗体、行内码、围栏代码块、标题、引用、有序/无序列表、链接、图片）——**用 React 元素拼，不要拼 HTML 字符串**。

### 4.4 宽度把手（照抄宿主行为，别自己算）

- 常量：`CONTENT_MIN = 640`、`CONTENT_EDGE_BUDGET = 176`、`CONTENT_FALLBACK_MAX = 920`。
- `resolveContentWidth(column, pref)`：`max = Math.max(CONTENT_MIN, column - CONTENT_EDGE_BUDGET)`；有 pref 取 `clamp(pref, 640, max)`；没 pref 取 `Math.max(680, Math.min(column * 0.64, CONTENT_FALLBACK_MAX))`。
- 左右各一条把手：`width: min(10px, calc((100% - var(--salon-content-width)) / 2 - 24px - 24px))`，左边 `right: calc(50% + var(--salon-content-width)/2 + 24px)`，右边对称。
- 拖动：`setPointerCapture` → 移动时 `outward = side === 'right' ? dx : -dx`、`width = base + outward * 2`；用 `requestAnimationFrame` 合并；只在 `pointerup` 时写 `localStorage`；双击恢复默认（删 key）。
- 用 `ResizeObserver` 量面板宽度，别用 `window.innerWidth`。

### 4.5 交互

- 「发给」是一组 chips（可多选）：每个成员一枚，「所有人」单独一枚（选中它时清掉其他人）；归档成员禁用并标「已归档」。
- 「叫醒方式」：`排队（它跑完这轮再看）` → `mode:'queue'`；`打断（插进它当前这步）` → `mode:'steer'`。
- 附件三个入口：回形针选文件、`onPaste` 收剪贴板图片、面板级拖放（拖动时显示虚框）；选中即上传，chip 可点 × 去掉。
- 轮询 `/api/messages?since=<last>` 每 1.5 秒；只有「已经贴底」时才自动滚到底（`scrollHeight - scrollTop - clientHeight < 48`）。
- 出错要显示在输入框下面（`连不上屋：<原因>`），不能吞。
- 时间：当天只显示 `HH:MM`，跨天显示 `MM-DD HH:MM`。

### 4.6 设置窗口（齿轮）

- 房间名：输入框，留空 = 「群聊」，24 字。
- 屋主一行：昵称 + 头像字。
- 每个成员一行：昵称、头像字、工作区（只读显示）、状态（已开/运行中/已归档）、「重开会话」、「移出」（两下确认：第一下变「确定移出？」）。
- 「叫一位进来」：下拉只列 `cfg.sessions`（已过滤），点「叫进来」→ `POST /api/member/add`；没有可选的会话时提示「没有可叫的会话——先去 DSH 里开一间（在已登记的工作区里、没归档）」。
- 保存后立刻刷新面板。

---

## 5. 数据文件格式

`room.jsonl`（每行一条，append-only）：
```json
{"seq":12,"ts":"2026-11-15T00:31:07.123Z","from":"汐","text":"……","to":["沧溟"],"files":[],"kind":"say"}
```
- `seq` 从 1 递增，由「读最后一行 → +1」得出，写入用追加；同一进程内用 promise 链串行化避免并发撞号。
- `kind`：`say`（人/会话说的）、`system`（系统行）。
- 读的时候坏行跳过，不让一条坏行毁掉整本账。

`room.json`：
```json
{ "title": "群聊", "members": [ { "name": "汐", "sessionId": "session-…" } ] }
```
`names.json`：
```json
{ "owner": { "name": "……", "initial": "…" }, "session-…": { "name": "……", "initial": "…" } }
```
写文件统一：先写 `<file>.tmp` 再 `rename` 覆盖。

---

## 6. 验收清单（必须真跑，不许只写）

写一个 `test-room.mjs`：**假宿主 + 真 HTTP**。假宿主提供 `webServer.register`、`agents.get/resume`、`sessionController.list/prompt`、`workspaceRegistry.list/archivedSessionIds`、`tools.register`、`on()`、`effect()`；用临时目录当 `stateDir`；在空闲端口起服务，用 `fetch` 打。

必须覆盖（每一条都要真断言，不许 `|| true`）：

**基础**
1. 开机只有屋主，账里 0 条；`/api/status` 200。
2. 把会话叫进来：名字默认取会话标题；同一会话不能叫两次；不存在的会话要明说找不到。
3. 只列 `workspaces` 里、未归档、非子代理的会话；第三个目录的会话不列。
4. 说一句话落账（`seq` 递增、`to` 正确）；不选人只落账、不叫任何人。
5. 投递成功才算送达：`woke` 里是「会话服务」/「宿主手里那间」/「唤醒再投」之一。
6. 四条投递路全失败 → 回「没叫醒（原因）」，**且不含「已送达」**。
7. 会话回话进账（模拟 `session/event` 的 `assistant/message`）；同 `message.id` 不重复落；含 `tool-call` 的中间叙述不落；`surfaceOp:'prepend'` 不落。
8. `salon_read` 注册成功、能按 `since` 读增量、读到头给出「没有人说话」。

**指向**
9. `to` 给两人：两人都被叫、账上 `to` 是两人。
10. `to: ['*']`（或「所有人」）：账上落的是全员真名，`*` 不落账。
11. 混一个不存在的人：明说这个人没叫到，另一个人照发。

**附件**
12. 上传 → 返回名字/大小/网址；取回字节与原文完全一致。
13. `/files/..%2Froom.jsonl` 与 `/api/files/..%2Froom.jsonl` 都 404。
14. 空文件 400；`?size=` 超限 413；边收边数超限也 413。
15. 附件随话落账；给会话的正文里是磁盘绝对路径；只发附件不写字也能发。

**安全**
16. `Origin: https://evil.example` → 403；本机 `Origin` → 200。
17. svg 回放：`content-type: application/octet-stream` + `content-disposition: attachment` + `nosniff`。

**名字**
18. 改名后：`/api/status` 里的名字变、能用新名字投到、头像字只取一个字、留空回默认、查无此人 400、撞名 400。

**房间**
19. 房间改名后 `/api/status` 的 `title` 变；留空回「群聊」；加人/移人之后名字还在。

**移出**
20. 移出后名单里没有、`@` 不再叫他、移出屋主 400、移出后账上有一条系统行。

跑法：`node test-room.mjs`，末行打印「全通。」，失败要打印第一条断言的期望与实际。

---

## 7. 已知坑（每一条都真的发生过，写完请自查）

| 现象 | 真正原因 | 正确写法 |
| --- | --- | --- |
| 插件在，但所有路由 404、不报错 | 模块 `inject` 没声明 `webServer`，`ctx.get('webServer')` 取不到就静默跳过 | `export const inject = ['webServer','tools']` |
| 整个插件起不来，报 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `package.json` 的 `exports` 少了 `"./client"` | 三个入口都要写 |
| 侧栏没有图标，界面空白、不报错 | 写了 `ctx.slots.inject('main', …)`；`main` 是往里注册的槽 | 在 `inject('sidebar.panellist', …)` 里同时注册 `main` 与 `sidebar.panellist` |
| 投递报 `signal.throwIfAborted is not a function` | `sessionController.prompt` 第二个参数是 `AbortSignal`，传了对象 | `prompt(request, new AbortController().signal)` |
| 投递「成功」但对方永远不说话 | `agents.get(不存在的会话)` 也返回带 `followup` 的空壳，投进去不报错也不生效 | 以「这一路没抛错」为送达；先走 `sessionController.prompt` |
| 会话正在跑时投不进去，报 `already owned by an active write handle` | 会话被窗口的写句柄占着 | 改走 `prompt`，或 `agent.steer()` |
| 名单写进去后账本空了 | 名单文件与账本用了同一个路径 | 拆成 `room.json` 与 `room.jsonl` 两个文件 |
| 账上写着「→ 某人」，其实没送到 | 失败只写进了 `woke`，没进账 | 失败单独追加 `kind:'system'` 的一行 |
| 客户端每个选项都是 `undefined` | `/api/status` 回的是字符串数组，客户端按对象取 `.name` | 统一回对象数组，另给一个纯名字数组 |
| 预设里挂的模块「加了却没生效」 | 补丁里写了**第二个**顶层 `- insert:`，宿主只吃第一条 | 只保留一条 insert；要挂子模块就写进同一条的 `plugins` 列表 |
| 移动插件目录后账本分叉 | 进程还在用旧路径，`appendMessage` 的 `ensureDir` 把旧目录又建出来 | 先停进程/重启，再在新路径写 |
| `node --check` 通过但代码是坏的 | 用 heredoc 拼含 `$&`、反引号、反斜杠的字符串，被折行吞掉代码 | 改这类代码用文件替换，或直接编辑行 |

---

## 8. 交付要求

1. 输出上面「2.1 包结构」里的全部文件，代码完整可跑，不留 `TODO`。
2. 注释写「为什么」，不写「是什么」；每一处违反直觉的写法都要有一句理由（尤其是投递四步与 `inject` 声明）。
3. `README.md` 写：三条规矩、安装四步、用法、接口表、已知限制。
4. 安装步骤（写进 README）：

```bash
# 1) 把插件目录放到任意位置，例如 /path/to/salon
# 2) 在 DSH profile 里登记（profile 目录通常是 <DSH_HOME>/profiles/desktop）
#    node_modules 里做联接：
#    Windows: mklink /J node_modules\dsh-salon <插件目录>
#    Linux/macOS: ln -s <插件目录> node_modules/dsh-salon
# 3) package.json 里加：
#    "dependencies": { "dsh-salon": "link:<插件目录>" }
#    "dsh": { "profile": { "bundles": [ …原有条目…, "dsh-salon" ] } }
# 4) 重启 DSH
```

5. 最后自检并贴出结果：`node --check index.js`、`node --check client.js`、`node --check src/room.js`、`node test-room.mjs`（要看到「全通。」）。

---

## 9. 一句话总结（给生成它的 AI）

这不是「聊天界面 + 后端」的普通 CRUD 应用：它的难点全在**和宿主会话打交道**。会话是别人已经在跑的东西，你只能「投话进去」和「把它的回话捞出来」；投递有四条路、每一条都会失败，而**失败必须让人看见**。渲染、拖宽、附件这些，一律优先复用宿主已有的实现，别自己造。
