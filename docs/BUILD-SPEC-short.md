# 生成提示（短版）：DSH 侧栏聊天室插件 dsh-salon

给你（AI）一个完整规格，从零写出这个插件。宿主是 DeepSeek Harness（DSH）桌面端。

## 任务

在 DSH 左侧栏加一个聊天入口。点开是一间屋；用户在设置里把**已经存在的会话**叫进来；被叫进来的会话能在屋里说话，也能读到别人说的话。说话是「写字 + 选发给谁 + 投递」；送到还是没送到必须如实回报。

## 硬约束

1. 只用 Node 内置模块与宿主注入的服务，零 npm 依赖。
2. **不建会话、不改预设、不在预设里挂模块**。屋里坐的是已存在的 `sessionId`。
3. 状态全落在插件自己的 `stateDir`：`room.jsonl`（账，append-only）、`room.json`（名单+房间名）、`names.json`（昵称/头像字）、`files/`（附件）、`salon.log`（诊断）。
4. 一切「送没送到」要能区分；失败必须进账，不许用「已送达」兜底。
5. 中文界面。

## 文件

```
dsh-salon/{package.json, cordis.patch.yml, index.js, client.js, src/room.js, test-room.mjs, README.md}
```

## 宿主契约（照抄）

**package.json** —— 必须有 `"./client"` 这条导出，漏了整个插件起不来：

```json
{ "name":"dsh-salon","type":"module","private":true,
  "exports":{".":"./index.js","./client":"./client.js","./package.json":"./package.json"},
  "dsh":{"bundle":{"patch":"./cordis.patch.yml"},
         "client":{"inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots",
                             "@deepseek-ai/dsh-client-ui-conversation",
                             "@deepseek-ai/dsh-client-ui-sidebar-right",
                             "@deepseek-ai/dsh-client-modules"],"platform":"web"}} }
```

**cordis.patch.yml** —— 只能有**一条**顶层 `- insert:`：

```yaml
- insert:
    - id: salon-room
      name: dsh-salon
      config: { mode: room, port: 40765, stateDir: <插件目录>/state, owner: <屋主名>, workspaces: [<工作区1>, <工作区2>] }
```

**index.js**：`export const name='salon-room'; export const inject=['webServer','tools']; export function apply(ctx, rawConfig){}`，全部注册包在 `ctx.effect(fn,'label')` 里，`fn` 返回 dispose。

**client.js**：不是普通 ES 模块，必须包一层：

```js
window.__ModuleLoader__.load({ id:'dsh-salon', factory: require => {
  const module={exports:{}}, exports=module.exports;
  const React=require('react'); const {createElement:h,useState,useEffect,useRef}=React;
  function apply(ctx){ … }
  exports.name='dsh-salon'; exports.inject=['slots']; exports.apply=apply;
  return module.exports; } });
```

可 `require` 的只有：`react`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

**客户端挂载**（`main` 是往里注册的槽，不能 inject）：

```js
ctx.slots.inject('sidebar.panellist', () => {
  const panel = ctx.slots.register({ name:'main', key:'salon' }, () => h(Panel));
  const row   = ctx.slots.register({ name:'sidebar.panellist', id:'salon', order:4, label:()=>'群聊' }, () => h(Icon));
  return () => { row?.(); panel?.(); };
});
```

## 服务端要点

- **谁能进店**：`ctx.get('sessionController').list({})` → `items[{sessionId,cwd,origin,projections.values.title}]`；丢掉 `origin==='subagent'`、丢掉 `ctx.get('workspaceRegistry').archivedSessionIds` 里的、只留 `cwd` 在 `workspaces` 里的。枚举一次 80–200ms，做 10 秒缓存。
- **投递四步**（这是全插件的难点）：
  1. `sessionController.prompt({sessionId, requestId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone}, abort.signal)` —— **第二参是 AbortSignal**，自设 15 秒超时；
  2. `agents.get(id)?.agent.followup(payload)`；
  3. 同一 agent `steer(payload)`（会话正跑着时 followup 会落空）；
  4. `agents.resume({resumeSessionId})` 再 followup。
  每一路失败都要 `log` 出原话；全败抛 `「X」那间会话打不开（id）—— <各路原因>`。payload = `{id, role:'user', content:[{type:'text',text}], source:{kind:'user', rpcId:id}}`。
- **说话**：`to` 是名字数组，`'*'`/`'所有人'` 当全体；账上**永远落真名字**；多人 `Promise.allSettled` 并行；没送到的人追加一条 `kind:'system'` 的行说明原因。叫醒正文带起点：`【<房间名> #<seq>】<谁>：<正文>` + 附件磁盘绝对路径 + 一句「要看前后文用 salon_read，不想看就不看」。
- **收话**：`ctx.on('session/event', cb, {global:true})`，只认 `event.type==='assistant/message'`、跳过 `surfaceOp==='prepend'`、按 `message.id` 去重（Set 上限 400）、只留 `{type:'text'}` 块（整条含 `tool-call` 就丢），按 `sessionId` 反查屋里名字后 append。
- **工具**：`ctx.tools ?? ctx.get('tools')` 上注册 `salon_read`（`since`/`limit`，默认 20，上限 200），`execute` 返回 `{text}`；每行 `#12 20:31 汐：正文　[附件名 → 路径]`。
- **路由**（同源前缀 `/salon`，handler 先剥前缀）：`GET /api/messages?since`、`GET /api/status`（`{title,owner,ownerInitial,members:[{name,initial,nick,sessionId,archived}],names,rows}`）、`GET /api/config`、`POST /api/say`、`POST /api/title`、`POST /api/name`、`POST /api/upload?name=&size=`、`GET /files/<stored>`、`POST /api/member/add`、`POST /api/member/remove`；其余 JSON 404。
- **附件**：落盘名 `<36进制时间>-<4hex>-<清洗后原名>`；上限 32 MiB（超了 413，空文件 400）；`basename(stored)!==stored` 拒（防穿越）；svg 一律回 `application/octet-stream` + `content-disposition: attachment`，全部响应加 `x-content-type-options: nosniff`。
- **来源**：无 `Origin` 放行（本机 curl/node），`'null'` 拒，hostname 必须是 `127.0.0.1`/`localhost`/`::1`，否则 403。
- 启动打一行：`门开了：手里 N 位…；webServer=有/没有；agents=有/没有`；关键动作双写 console + `state/salon.log`。

## 客户端要点

- 顶栏（房间名可点改 + 齿轮）、消息列（屋主靠右气泡、成员靠左头像+名字、系统行居中灰字）、输入区（「发给」多选 chips +「叫醒方式」排队/打断 + 输入框 + 回形针 + 发送）。
- 样式走宿主 token：`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-specific-bubble`、`--dsw-specific-input-major`、`--dsh-content-font-size`、`--dsh-chat-flow-gap`；消息列 `max-width: var(--dsh-chat-content-width,748px); margin:0 auto`。
- Markdown 直接用宿主的：`require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText`，props `{text, streaming:false, labels, pathImages}`；拿不到再退回本地最简渲染；外面包一层 ErrorBoundary。
- 宽度把手照宿主公式：`max=Math.max(640, column-176)`，有偏好取 `clamp(pref,640,max)`，否则 `Math.max(680, Math.min(column*0.64, 920))`；拖动 `outward = side==='right' ? dx : -dx`、`width = base + outward*2`；rAF 合并，只在 pointerup 落 `localStorage`，双击恢复默认。
- 附件三入口：回形针、粘贴、拖放；选中即上传，chip 可 ×。轮询 1.5 秒；只在贴底时自动滚；错误显示在输入框下方。

## 12 个坑（都真发生过，写完自查）

| 现象 | 原因 | 正确写法 |
| --- | --- | --- |
| 插件在，路由全 404 且不报错 | `inject` 没声明 `webServer` | `export const inject=['webServer','tools']` |
| 插件起不来，报 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `exports` 缺 `"./client"` | 三个入口都写 |
| 侧栏没图标、界面空白不报错 | `ctx.slots.inject('main', …)` | 在 `inject('sidebar.panellist', …)` 里一起注册 |
| `signal.throwIfAborted is not a function` | `prompt` 第二参传了对象 | 传 `new AbortController().signal` |
| 「投递成功」但对方从不说话 | `agents.get(不存在的会话)` 返回带 `followup` 的空壳 | 先走 `prompt`；以「没抛错」为送达 |
| `already owned by an active write handle` | 会话被窗口写句柄占着 | 改走 `prompt` 或 `steer` |
| 写名单后账本空了 | 名单与账本同路径 | `room.json` / `room.jsonl` 分开 |
| 账上写着「→ 某人」其实没送到 | 失败只进返回值没进账 | 追加 `kind:'system'` 行 |
| 下拉每一项都是 `undefined` | `/api/status` 回了字符串数组 | 回对象数组 + 另给纯名字数组 |
| 预设里挂的模块「加了不生效」 | 补丁里有第二个顶层 `- insert:` | 只留一条；子模块写进 `plugins` |
| 挪目录后账本分叉 | 进程还在旧路径，`ensureDir` 又建出来 | 先重启再说话 |
| `node --check` 通过但代码是坏的 | heredoc 拼含 `$&`/反引号/反斜杠的串被折行 | 用文件替换或直接改行 |

## 验收（必须真跑）

写 `test-room.mjs`：假宿主（`webServer.register`、`agents`、`sessionController.list/prompt`、`workspaceRegistry`、`tools.register`、`on`、`effect`）+ 临时 `stateDir` + 空闲端口 + 真 `fetch`。断言里**不许出现 `|| true`**。

至少覆盖：
1. 开机只有屋主、账为 0；枚举只出 `workspaces` 里未归档非子代理的会话。
2. 叫会话进来：默认名取标题、同会话不能叫两次、不存在的会话要明说。
3. 说话落账；不选人只落账；`to` 两人两人都被叫；`['*']` 落全员真名。
4. 四路全失败 → 回「没叫醒（原因）」，**不含「已送达」**。
5. 会话回话进账；同 `message.id` 不重复；含 `tool-call` 的不落；`prepend` 不落。
6. 附件：往返字节一致；`..%2F` 路径 404；空文件 400；超 32 MiB 413；只发附件也能发。
7. `Origin: https://evil.example` → 403；本机 → 200。
8. 改名（成员/屋主/房间）生效、留空回默认、撞名 400；移出后 `@` 不再叫他且落系统行。

跑完末行打印「全通。」。

## 安装（写进 README）

1. 插件目录放任意位置。
2. `<DSH_HOME>/profiles/desktop/node_modules/` 里做联接：Windows `mklink /J dsh-salon <插件目录>`，别处 `ln -s`。
3. profile 的 `package.json`：`dependencies["dsh-salon"]="link:<插件目录>"`，`dsh.profile.bundles` 里加 `"dsh-salon"`（改前备份）。
4. 重启 DSH。

## 交付自检

`node --check index.js`、`node --check client.js`、`node --check src/room.js`、`node test-room.mjs`，把输出贴出来。

## 一句提醒

这插件的难点不在界面，在**和宿主会话打交道**：会话是别人已经在跑的东西，你只能投话进去、把回话捞出来；四条投递路每条都会失败，而失败必须让人看见。界面、渲染、拖宽、附件一律优先复用宿主已有的实现，别自己造。
