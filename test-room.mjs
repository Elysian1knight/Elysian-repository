/**
 * 离线测试：假宿主、真 HTTP。
 * 跑：node test-room.mjs
 *
 * 规则：只有「任务工作区里、没归档」的会话能进屋子。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

const ok = [];
const bad = [];
const check = (label, cond, extra = '') => (cond ? ok : bad).push(label + (cond ? '' : `  ← ${extra}`));

const WORK = path.join(os.tmpdir(), 'salon-work-a');
const AMO = path.join(os.tmpdir(), 'salon-work-b');
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'salon-'));
const port = 41100 + Math.floor(Math.random() * 80);

// sess-beta 在第二个工作区（也要能进来），sess-elsewhere 在第三个屋子（不该出现），
// sess-sub 是子代理、sess-archived 归档了——这两个也不该出现。
const sessions = [
  { sessionId: 'sess-alpha', cwd: WORK, running: false, projections: { values: { title: '甲的会话' } } },
  { sessionId: 'sess-beta', cwd: AMO, running: true, projections: { values: { title: '乙的会话' } } },
  { sessionId: 'sess-elsewhere', cwd: path.join(os.tmpdir(), 'salon-work-c'), projections: { values: { title: '别人的屋子' } } },
  { sessionId: 'sess-sub', cwd: WORK, origin: 'subagent', projections: { values: { title: '跑腿的' } } },
  { sessionId: 'sess-archived', cwd: WORK, projections: { values: { title: '收起来的' } } },
  { sessionId: 'sess-gamma', cwd: WORK, running: false, projections: { values: { title: '夜班' } } },
];
const archived = ['sess-archived'];

// 会话列表被枚举了几次：缓存有没有生效，就看这一笔。
let listCalls = 0;

const delivered = [];
const steered = [];
let followupBreaks = false;
const prompted = [];
let promptFails = false;
let allFail = false;
let withPrompt = true;
let events = [];
let noFollowup = false;

let liveSession = false;
const agents = {
  // 只有真的「开在窗口里」时，agents.get 才会给出一个带着嘴的 agent——
  // 这正是我们要靠它判断「会话活着」的那一样。
  get: id => (liveSession && !allFail ? {
    agent: {
      followup: async payload => {
        if (followupBreaks) throw new Error('signal.throwIfAborted is not a function');
        delivered.push({ id, payload });
      },
      steer: async payload => { steered.push({ id, payload }); },
    },
  } : undefined),
  resume: async ({ resumeSessionId }) => {
    if (allFail) throw new Error('session "x" is already owned by an active write handle');
    return { agent: { followup: async payload => { delivered.push({ id: resumeSessionId, payload }); } } };
  },
};

const webServer = { register: () => () => {} };
const tools = { list: [], register: spec => { tools.list.push(spec); } };
const ctx = {
  effect: fn => { fn(); },
  get: key => ({
    webServer,
    agents,
    sessionController: {
      list: async () => { listCalls += 1; return { items: sessions }; },
      ...(withPrompt ? {
        // 真宿主的样子：第二个参数是 AbortSignal，进来第一行就 throwIfAborted()。
        prompt: async (request, signal) => {
          if (typeof signal?.throwIfAborted !== 'function') {
            throw new Error('signal.throwIfAborted is not a function');
          }
          signal.throwIfAborted();
          if (promptFails || allFail) throw new Error('session/agent-busy: 那间会话正忙');
          prompted.push({ request, signal });
          return { accepted: true };
        },
      } : {}),
    },
    workspaceRegistry: { archivedSessionIds: archived },
    tools,
  })[key],
  on: (kind, handler) => { events.push({ kind, handler }); return () => {}; },
  webServer,
};

apply(ctx, { mode: 'room', port, stateDir, owner: '屋主', workspaces: [WORK, AMO] });
const settle = () => new Promise(r => setTimeout(r, 120));
await settle();
const base = `http://127.0.0.1:${port}`;
const get = p => fetch(base + p).then(r => r.json());
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ code: r.status, data: await r.json() }));

/* 一、只列本工作区、没归档的会话 */
const cfg0 = await get('/api/config');
const ids = cfg0.sessions.map(s => s.sessionId).sort().join(',');
check('列的是两个工作区里的会话（含第二个工作区）', ids === 'sess-alpha,sess-beta,sess-gamma', ids);
check('第三个屋子里的会话不列', !cfg0.sessions.some(s => s.sessionId === 'sess-elsewhere'), JSON.stringify(cfg0.sessions));
check('归档的会话不列', !cfg0.sessions.some(s => s.sessionId === 'sess-archived'), JSON.stringify(cfg0.sessions));
check('子代理会话不列', !cfg0.sessions.some(s => s.sessionId === 'sess-sub'), JSON.stringify(cfg0.sessions));

/* 二、叫进来 */
const added = await post('/api/member/add', { sessionId: 'sess-alpha' });
check('叫进来：名字默认用会话标题', added.code === 200 && added.data.config.members[0].name === '甲的会话', JSON.stringify(added.data));
const added2 = await post('/api/member/add', { sessionId: 'sess-gamma', name: '随便写个名字' });
check('名字不由人起：跟着会话自己的命名', added2.code === 200
  && added2.data.config.members.find(m => m.sessionId === 'sess-gamma')?.name === '夜班', JSON.stringify(added2.data));
check('叫进来：已在屋里的不再列进可选', !added2.data.config.sessions.some(s => s.sessionId === 'sess-alpha'), JSON.stringify(added2.data.config.sessions));
const dupAdd = await post('/api/member/add', { sessionId: 'sess-gamma' });
check('同一间会话不能再叫一次', dupAdd.code === 400 && /已经在屋里/.test(JSON.stringify(dupAdd.data)), JSON.stringify(dupAdd.data));
const amoAdd = await post('/api/member/add', { sessionId: 'sess-beta' });
check('第二个工作区的会话也能叫进来', amoAdd.code === 200, JSON.stringify(amoAdd.data));

/* 会话自己在 DSH 里改名，屋里的名字跟着改 */
sessions.find(s => s.sessionId === 'sess-beta').projections.values.title = '乙·改过的名字';
const renamed = await get('/api/config');
check('会话改名了：屋里的名字跟着改', renamed.members.find(m => m.sessionId === 'sess-beta')?.name === '乙·改过的名字', JSON.stringify(renamed.members));
check('可选名单里没有改名前的老名字', !renamed.members.some(m => m.name === '乙的会话'), JSON.stringify(renamed.members));
const sayNew = await post('/api/say', { text: '在吗', to: ['乙·改过的名字'] });
check('按新名字说话也投得到', /投进去了|投进了|先唤醒/.test(JSON.stringify(sayNew.data.woke)) && prompted.some(p2 => p2.request.sessionId === 'sess-beta'), JSON.stringify(sayNew.data));

/* 两间会话重名：加尾号区分，不让他们撞成一个 */
sessions.find(s => s.sessionId === 'sess-alpha').projections.values.title = '夜班';
const same = await get('/api/config');
const two = same.members.filter(m => m.name.startsWith('夜班'));
check('两间会话重名：各自加尾号，都还在', two.length === 2 && new Set(two.map(m => m.name)).size === 2, JSON.stringify(same.members));
sessions.find(s => s.sessionId === 'sess-alpha').projections.values.title = '甲的会话';
const otherRoom = await post('/api/member/add', { sessionId: 'sess-elsewhere' });
check('没登记的屋子叫不进来，并说清规则', otherRoom.code === 400 && /没登记的会话|只列/.test(JSON.stringify(otherRoom.data)), JSON.stringify(otherRoom.data));
const goneAdd = await post('/api/member/add', { sessionId: 'sess-archived' });
check('归档的会话叫不进来，并说「先恢复」', goneAdd.code === 400 && /归档了/.test(JSON.stringify(goneAdd.data)), JSON.stringify(goneAdd.data));
const room1 = JSON.parse(await fs.readFile(path.join(stateDir, 'room.json'), 'utf8'));
check('房间自己记着绑了哪几间会话', room1.members.map(m => m.sessionId).join(',') === 'sess-alpha,sess-gamma,sess-beta', JSON.stringify(room1));

/* 二·五、/api/status 要能喂给「发给」那一栏 */
const st = await get('/api/status');
check('/api/status 的 members 是对象（带 sessionId、归档标记）',
  Array.isArray(st.members) && st.members.every(m => typeof m === 'object' && m.sessionId) && st.members.length === 3,
  JSON.stringify(st.members));
check('/api/status 另给一份纯名字（正文 @ 高亮用）',
  Array.isArray(st.names) && st.names.length === 3 && st.names.includes('甲的会话'), JSON.stringify(st.names));

/* 三、说话 */

/* 会话正跑着、followup 落空时：靠插话把话送到它眼前
   （会话服务那条先让它失败，才轮得到 followup） */
promptFails = true;
followupBreaks = true;
liveSession = true;
const bySteer = await post('/api/say', { text: '插一句', to: ['夜班'] });
check('开着的会话 followup 落空：改用插话，也算送到', /插进去了/.test(JSON.stringify(bySteer.data.woke))
  && steered.length === 1 && !/没叫醒/.test(JSON.stringify(bySteer.data)), JSON.stringify(bySteer.data));
followupBreaks = false;
promptFails = false;
liveSession = false;

/* 会话服务能用时：一切都走它（冷的热的都它管） */
prompted.length = 0;
liveSession = true;
const said = await post('/api/say', { text: '在吗', to: ['夜班'] });
check('栏里选人：正文不带 @ 也能投到', prompted.length === 1 && prompted[0].request.sessionId === 'sess-gamma', JSON.stringify(prompted.map(p => p.request.sessionId)));
check('投递成功才说送达', said.data.woke.length === 1 && /投进去了/.test(said.data.woke[0]), JSON.stringify(said.data));
check('会话服务那一投，传的是真的 AbortSignal（不是消息来源）',
  (() => { const p3 = prompted[0]; return p3 && typeof p3.signal?.throwIfAborted === 'function' && typeof p3.signal.aborted === 'boolean'; })(),
  JSON.stringify({ hasSignal: prompted[0]?.signal !== undefined }));
const note = prompted[0].request.content[0].text;
check('叫醒的话只说这一句（带【三人间 #序号】和正文）', /【三人间 #\d+】/.test(note) && /在吗/.test(note), note);
check('不替它把旧账塞进去：要看自己调 salon_read', /salon_read/.test(note) && !/屋里最近这几句/.test(note), note);
check('叫醒的话里给它一个起点：since 就是这条之前', /since: \d+/.test(note), note);
check('走的是排队那一档（不打断它会话）', prompted[0].request.mode === 'queue', prompted[0].request.mode);
const steeredMode = await post('/api/say', { text: '这一句要插进去', to: ['夜班'], mode: 'steer' });
check('选「打断」：mode 传的是 steer', steeredMode.data.woke.length === 1
  && prompted[prompted.length - 1].request.mode === 'steer', prompted[prompted.length - 1]?.request.mode);
const beforeQuiet = prompted.length;
const quiet = await post('/api/say', { text: '不叫人' });
check('选「不叫人」就不叫人跑', quiet.data.woke.length === 0 && prompted.length === beforeQuiet, JSON.stringify(quiet.data));
const atFallback = await post('/api/say', { text: '@夜班 老办法' });
check('没给 to 时仍认正文里的 @（退路）', atFallback.data.woke.length === 1 && prompted.length === beforeQuiet + 1, JSON.stringify(atFallback.data));

/* 会话服务不给用时（老宿主）：退回 agents 那条 */
promptFails = true;
prompted.length = 0;
liveSession = true;
const viaOldPath = await post('/api/say', { text: '走老路', to: ['夜班'] });
check('会话服务不给用时：退回 agents 收件箱，也算送到', /投进了开着的会话/.test(JSON.stringify(viaOldPath.data.woke)) && delivered.length === 1, JSON.stringify(viaOldPath.data.woke));
check('退回时投的也是那句话', delivered[0].payload.content[0].text.includes('走老路'), JSON.stringify(delivered[0].payload.content));
promptFails = false;
liveSession = false;

/* 四、会话说的话落回屋里 */
const handler = events.find(e => e.kind === 'session/event').handler;
handler({ id: 'sess-gamma' }, { type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: '在的。' }] } } });
handler({ id: 'sess-gamma' }, { type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: '在的。' }] } } });
await settle();
const feed = await get('/api/messages?since=0');
const fromGamma = feed.messages.filter(r => r.from === '夜班');
check('回话落到屋里，且同一条不落两遍', fromGamma.length === 1 && fromGamma[0].text === '在的。', JSON.stringify(fromGamma));
handler({ id: 'sess-alpha' }, { type: 'assistant/message', data: { message: { id: 'm2', content: [{ type: 'tool-call' }] } } });
const feed2 = await get(`/api/messages?since=${feed.messages[feed.messages.length - 1].seq}`);
check('中间叙述（带工具调用）不落账', feed2.messages.length === 0, JSON.stringify(feed2.messages));

/* 五、投不进去必须说没送到 */
allFail = true;
const failed = await post('/api/say', { text: '还在吗', to: ['夜班'] });
check('投递失败：说「没叫醒」并带三条路各自的原因', /没叫醒/.test(JSON.stringify(failed.data))
  && /唤醒再投/.test(JSON.stringify(failed.data)) && /会话服务/.test(JSON.stringify(failed.data))
  && !/已送达|投进去了/.test(JSON.stringify(failed.data)), JSON.stringify(failed.data));
allFail = false;

/* 六、屋里坐着一个后来被归档的人 */
archived.push('sess-gamma');
const archView = await get('/api/config');
const gone = archView.members.find(m => m.sessionId === 'sess-gamma');
check('成员被归档后：标出「已归档」', gone?.archived === true, JSON.stringify(archView.members));
const archSay = await post('/api/say', { text: '说话', to: [gone?.name] });
check('对归档的成员说话：明说归档了', /归档了/.test(JSON.stringify(archSay.data)) && !/已送达/.test(JSON.stringify(archSay.data)), JSON.stringify(archSay.data));
archived.pop();

/* 七、移出 */
const removed = await post('/api/member/remove', { name: '夜班' });
check('移出：名单里少一位', removed.code === 200 && removed.data.config.members.length === 2, JSON.stringify(removed.data));
const ghostRemove = await post('/api/member/remove', { name: '没有这个人' });
check('移出不认识的人：说清楚', ghostRemove.code === 400 && /屋里没有/.test(JSON.stringify(ghostRemove.data)), JSON.stringify(ghostRemove.data));
const after = await get('/api/messages?since=0');
check('移出也落一行账', after.messages.some(r => r.kind === 'leave' && /离开了房间/.test(r.text)), JSON.stringify(after.messages.slice(-2)));

/* 七·五、附件：先上传，再随话发出去 */
const up = await fetch(`${base}/api/upload?name=${encodeURIComponent('样例 报告.txt')}`, {
  method: 'POST',
  body: Buffer.from('这是附件里的内容\n第二行', 'utf8'),
});
const upData = await up.json();
check('上传附件：返回名字、大小、取件网址', up.status === 200 && upData.ok === true
  && upData.file.name === '样例 报告.txt' && upData.file.size > 0
  && /^\/salon\/files\//.test(upData.file.url), JSON.stringify(upData));

const served = await fetch(`${base}${upData.file.url}`);
const servedText = await served.text();
check('附件取得到，字节没坏', served.status === 200 && servedText.startsWith('这是附件里的内容')
  && /text\/plain/.test(served.headers.get('content-type') ?? ''), servedText);
const nope = await fetch(`${base}/api/files/..%2Froom.jsonl`);
const nope2 = await fetch(`${base}/files/..%2Froom.jsonl`);
check('附件门不让人顺着 /.. 摸别的文件', nope.status === 404 && nope2.status === 404, `${nope.status}/${nope2.status}`);
const empty = await fetch(`${base}/api/upload?name=x.txt`, { method: 'POST', body: Buffer.alloc(0) });
check('空文件不收', empty.status === 400, String(empty.status));

/* 七·五之二、评审抓出来的三处：svg 同源、上传无上限、外站页面能直接打 */
const svgUp = await fetch(`${base}/api/upload?name=${encodeURIComponent('坏.svg')}`, {
  method: 'POST',
  body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
});
const svgData = await svgUp.json();
const svgGet = await fetch(`${base}${svgData.file.url}`);
check('svg 一律当下载件：不给 image/svg+xml、要求 nosniff 与 attachment',
  svgGet.headers.get('content-type') === 'application/octet-stream'
  && /attachment/.test(svgGet.headers.get('content-disposition') ?? '')
  && svgGet.headers.get('x-content-type-options') === 'nosniff',
  JSON.stringify({ type: svgGet.headers.get('content-type'), cd: svgGet.headers.get('content-disposition') }));

const huge = await fetch(`${base}/api/upload?name=big.bin&size=${40 * 1024 * 1024}`, {
  method: 'POST',
  body: Buffer.from('x'),
});
check('上传有上限：超过 32MB 直接 413，不往内存里吞', huge.status === 413, String(huge.status));

const crossSite = await fetch(`${base}/api/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ text: '外站来的' }),
});
check('外站页面直接打过来：403', crossSite.status === 403, String(crossSite.status));
const sameSite = await fetch(`${base}/api/status`, { headers: { origin: 'http://127.0.0.1:5173' } });
check('本机页面照常放行', sameSite.status === 200, String(sameSite.status));

const ghostTarget = await post('/api/say', { text: '发给一个不存在的人', to: ['查无此人'] });
check('栏里选了屋里没有的人：说一声，不悄悄丢掉',
  ghostTarget.data.woke.some(line => /没叫人/.test(line) && /查无此人/.test(line)),
  JSON.stringify(ghostTarget.data.woke));

prompted.length = 0;
const withFile = await post('/api/say', {
  text: '给你看份东西',
  to: ['甲的会话'],
  files: [upData.file],
});
const fileRow = (await get('/api/messages?since=0')).messages.filter(r => Array.isArray(r.files)).pop();
check('附件跟着话落进账：账上记着名字与网址', Boolean(fileRow) && fileRow.files[0].name === '样例 报告.txt'
  && fileRow.files[0].url === upData.file.url, JSON.stringify(fileRow));
const fileNote = prompted[prompted.length - 1].request.content[0].text;
check('投给会话时给的是磁盘路径（它要用文件工具去开）',
  fileNote.includes(path.join(stateDir, 'files')) && /样例 报告\.txt/.test(fileNote), fileNote);
const onlyFile = await post('/api/say', { to: ['甲的会话'], files: [upData.file] });
check('只发附件、不写字也行', onlyFile.data.row.text === '' && Array.isArray(onlyFile.data.row.files),
  JSON.stringify(onlyFile.data));
const bare = await post('/api/say', { to: [], files: [{ stored: upData.file.stored }] });
check('客户端只报 stored：大小与原名由服务器从盘上补齐',
  bare.data.row.files[0].size > 0 && bare.data.row.files[0].name !== upData.file.stored,
  JSON.stringify(bare.data.row.files));

/* 七·六、salon_read：要不要看群里的话由会话自己决定 */
const readTool = tools.list.find(t => t.name === 'salon_read');
check('给会话挂上 salon_read 这只眼睛', Boolean(readTool), JSON.stringify(tools.list.map(t => t.name)));
if (readTool) {
  const out = await readTool.execute({ limit: 5 });
  check('salon_read 读得到屋里的对话', typeof out.text === 'string' && /给你看份东西/.test(out.text), out.text.slice(0, 120));
  const beyond = await readTool.execute({ since: 999999 });
  check('salon_read 按序号读：读到头会说没人说话', /没有人说话/.test(beyond.text), beyond.text);
}

/* 八、宿主缺服务时要说出来 */
const stateDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'salon2-'));
const port2 = port + 90;
apply({ ...ctx, get: key => (key === 'webServer' ? webServer : key === 'agents' ? agents : undefined) },
  { mode: 'room', port: port2, stateDir: stateDir2, owner: '屋主', workspaces: [WORK, AMO] });
await settle();
const blind = await fetch(`http://127.0.0.1:${port2}/api/config`).then(r => r.json());
check('没有会话列表服务：明说，不装没事', typeof blind.problem === 'string' && /会话列表/.test(blind.problem), JSON.stringify(blind));

/* 九、宿主没有会话服务的 prompt 时：退回 agents.followup，也要真投到 */
const stateDir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'salon3-'));
const port3 = port + 120;
const prompts3 = [];
const delivered3 = [];
const ctx3 = {
  effect: fn => { fn(); },
  get: key => ({
    webServer,
    agents: {
      get: id => ({ agent: { followup: async payload => { delivered3.push({ id, payload }); } } }),
      resume: async () => undefined,
    },
    sessionController: { list: async () => ({ items: sessions }) },
    workspaceRegistry: { archivedSessionIds: [] },
  })[key],
  on: () => () => {},
  webServer,
};
apply(ctx3, { mode: 'room', port: port3, stateDir: stateDir3, owner: '屋主', workspaces: [WORK, AMO] });
await settle();
const p3 = (p2, body) => fetch(`http://127.0.0.1:${port3}${p2}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
await p3('/api/member/add', { sessionId: 'sess-alpha' });
const p3cfg = await fetch(`http://127.0.0.1:${port3}/api/config`).then(r => r.json()).catch(() => null);
const p3name = (p3cfg?.members ?? [])[0]?.name ?? '甲的会话';
const viaAgents = await p3('/api/say', { text: '走老路', to: [p3name] });
check('没有 prompt 时退回 followup，也算送达', delivered3.length === 1 && /投进了开着的会话|先唤醒/.test(JSON.stringify(viaAgents.woke)), JSON.stringify(viaAgents));

/* 昵称与头像字：自己起的名字存进 names.json，空串回到默认 */
const nick = await post('/api/name', { target: 'sess-alpha', name: '小甲', initial: '甲' });
check('改昵称：名字换成自己起的', nick.code === 200
  && nick.data.config.members.some(m => m.name === '小甲'), JSON.stringify(nick.data));
const nickStatus = await get('/api/status');
check('status 里也是新名字，并且带头像字', nickStatus.members.some(m => m.name === '小甲' && m.initial === '甲'), JSON.stringify(nickStatus.members));
const markOne = await post('/api/name', { target: '小甲', name: '小甲', initial: '甲甲' });
check('头像字只收第一个字', markOne.code === 200
  && markOne.data.config?.members.find(m => m.name === '小甲')?.initial === '甲', JSON.stringify(markOne.data));
const toNewName = await post('/api/say', { text: '叫新名字也投得到', to: ['小甲'] });
check('用新名字说话投得到', /投进|先唤醒/.test(JSON.stringify(toNewName.data.woke)), JSON.stringify(toNewName.data.woke));
const ownerRen = await post('/api/name', { target: 'owner', name: '航', initial: '航' });
check('屋主也能改名', ownerRen.code === 200 && ownerRen.data.config.owner === '航' && ownerRen.data.config.ownerInitial === '航', JSON.stringify(ownerRen.data.config));
const ownerStatus = await get('/api/status');
check('status 里屋主名与头像字都变', ownerStatus.owner === '航' && ownerStatus.ownerInitial === '航', JSON.stringify({ o: ownerStatus.owner, i: ownerStatus.ownerInitial }));
const cleared = await post('/api/name', { target: '小甲', name: '', initial: '' });
check('留空＝回到会话自己的命名', cleared.code === 200
  && (cleared.data.config?.members ?? []).some(m => m.name === '甲的会话'), JSON.stringify(cleared.data));
const ghost = await post('/api/name', { target: '不存在的人', name: 'x' });
check('改一个屋里没有的人：说清楚', ghost.code === 404 && /屋里没有/.test(JSON.stringify(ghost.data)), JSON.stringify(ghost.data));
const namesFile = await fs.readFile(path.join(stateDir, 'names.json'), 'utf8').catch(() => '');
check('名字写在 names.json（不是账本里）', /"owner"/.test(namesFile), namesFile);

/* 一条话可以指好几个人；「所有人」发 '*' */
const live0 = await get('/api/status');
const liveNames = Array.isArray(live0.names) ? live0.names : [];
const [nameA, nameB] = liveNames;
check('屋里至少有两个人，才谈得上指两个', liveNames.length >= 2, JSON.stringify(liveNames));
const twoSay = await post('/api/say', { text: '两个人一起看这句', to: [nameA, nameB] });
check('指两个人：两个都记进账里', Array.isArray(twoSay.data.row?.to)
  && twoSay.data.row.to.length === 2
  && twoSay.data.row.to.includes(nameA) && twoSay.data.row.to.includes(nameB), JSON.stringify(twoSay.data.row?.to));
check('指两个人：两个都被叫了', Array.isArray(twoSay.data.woke) && twoSay.data.woke.length === 2, JSON.stringify(twoSay.data.woke));
const everyone = await post('/api/say', { text: '所有人下周五聚餐', to: ['*'] });
check('所有人：账上写着屋里每个人', Array.isArray(everyone.data.row?.to)
  && everyone.data.row.to.length === liveNames.length
  && liveNames.every(n => everyone.data.row.to.includes(n)), JSON.stringify(everyone.data.row?.to));
check('所有人：star 本身不落账', !(everyone.data.row?.to ?? []).includes('*'), JSON.stringify(everyone.data.row?.to));
check('所有人：每个人都收到', Array.isArray(everyone.data.woke) && everyone.data.woke.length === liveNames.length, JSON.stringify(everyone.data.woke));
const aliased = await post('/api/say', { text: '中文写法也认', to: ['所有人'] });
check('写「所有人」三个字也当全体', Array.isArray(aliased.data.row?.to)
  && liveNames.every(n => aliased.data.row.to.includes(n)) && !aliased.data.row.to.includes('所有人'), JSON.stringify(aliased.data.row?.to));
const halfGhost = await post('/api/say', { text: '一个在屋里一个不在', to: [nameA, '没这个人'] });
check('指的人里有一个不在：那个明说没叫人', Array.isArray(halfGhost.data.woke)
  && halfGhost.data.woke.some(line => /没叫人/.test(line) && /没这个人/.test(line)), JSON.stringify(halfGhost.data.woke));
check('指的人里有一个不在：在的那个照常收到', halfGhost.data.row?.to?.length === 1, JSON.stringify(halfGhost.data.row?.to));

/* 房间自己的名字：/api/title */
const title0 = await get('/api/status');
check('没起名的时候叫「群聊」', title0.title === '群聊', String(title0.title));
const titleLong = await post('/api/title', { title: 'x'.repeat(40) });
check('名字太长截到 24 字', titleLong.code === 200
  && String(titleLong.data.config?.title ?? '').length === 24, String(titleLong.data.config?.title ?? '').length);
const titleNamed = await post('/api/title', { title: '鲸的客厅' });
check('改名成功，status 读得到', titleNamed.code === 200
  && titleNamed.data.config?.title === '鲸的客厅'
  && (await get('/api/status')).title === '鲸的客厅', JSON.stringify(titleNamed.data.config?.title));
const titleAdd = await post('/api/member/add', { sessionId: 'sess-gamma' });
check('加人之后名字还在', titleAdd.data.config?.title === '鲸的客厅', JSON.stringify(titleAdd.data.config?.title));
const gammaName = (titleAdd.data.config?.members ?? []).find(m => m.sessionId === 'sess-gamma')?.name ?? '';
const titleRemove = await post('/api/member/remove', { name: gammaName });
check('移人之后名字还在', titleRemove.data.config?.title === '鲸的客厅', JSON.stringify(titleRemove.data.config?.title));
const titleClear = await post('/api/title', { title: '   ' });
check('留空就回「群聊」', titleClear.code === 200
  && titleClear.data.config?.title === '群聊', JSON.stringify(titleClear.data.config?.title));

/* 没送到的人要留在账上：刷新、换台机器、过一夜都还看得见（P0-1） */
const afterFail = await get('/api/messages?since=0');
const failSeq = halfGhost.data.row?.seq;
const persisted = (afterFail.messages ?? []).find(r => r && r.kind === 'system'
  && String(r.text ?? '').startsWith(`#${failSeq}`));
check('没叫醒的人落进账里：刷新后仍在', Boolean(persisted) && /没这个人/.test(String(persisted.text)),
  JSON.stringify(persisted ?? (afterFail.messages ?? []).slice(-2)));

/* 改名字撞上别人要挡：两个同名的人，to / from / @ 全都会认错（P1-4） */
const clash = await post('/api/name', { target: nameB, name: nameA });
check('改名撞上别人：400 挡下来', clash.code === 400 && /已经有人叫了/.test(JSON.stringify(clash.data)),
  JSON.stringify(clash.data));

/* 显式名单（「所有人」上点掉一个人后，客户端会发这个）照常投到每个人 */
const explicit = await post('/api/say', { text: '显式名单也发得对', to: [nameA] });
check('显式名单：只投给名单上的人', Array.isArray(explicit.data.row?.to)
  && explicit.data.row.to.length === 1 && explicit.data.row.to[0] === nameA, JSON.stringify(explicit.data.row?.to));

/* 会话名单吃缓存：10 秒内连着开几次面板，不该把会话列表重新枚举一遍（P2-7） */
const callsBefore = listCalls;
await get('/api/status');
await get('/api/status');
await get('/api/status');
const statusCalls = listCalls - callsBefore;
check('三枚 status 不重新枚举会话（吃缓存）', statusCalls <= 1, `列了 ${statusCalls} 次`);

const cfgBefore = listCalls;
await get('/api/config');
const cfgCalls = listCalls - cfgBefore;
check('config 一定现列一份（挑会话不能吃缓存）', cfgCalls === 1, `列了 ${cfgCalls} 次`);

/* 发话是热路径：连着两句，不该每句都枚举一遍会话（P2-7） */
const sayBefore = listCalls;
await post('/api/say', { text: '缓存一', to: [nameA] });
await post('/api/say', { text: '缓存二', to: [nameA] });
const sayCalls = listCalls - sayBefore;
check('连着两句只枚举一次会话（发话走缓存）', sayCalls <= 1, `列了 ${sayCalls} 次`);

await fs.rm(stateDir3, { recursive: true, force: true });
await fs.rm(stateDir, { recursive: true, force: true });
await fs.rm(stateDir2, { recursive: true, force: true });

console.log(`通 ${ok.length} 项：`);
for (const line of ok) console.log('  ✓ ' + line);
if (bad.length) {
  console.log(`\n不通 ${bad.length} 项：`);
  for (const line of bad) console.log('  ✗ ' + line);
  process.exitCode = 1;
} else {
  console.log('\n全通。');
}
process.exit(process.exitCode ?? 0);
