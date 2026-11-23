/**
 * dsh-salon —— 房间那一半。
 *
 * 屋里坐着的是「已经存在的会话」：谁进来由他在设置里挑，房间自己记着 sessionId。
 * 不碰预设补丁、不生成会话编号；叫醒就是把话投进那间会话的收件箱，
 * 它回话时再由 session/event 捞回来落进底账。
 *
 * 一条纪律：投不进去就说投不进去。只有 followup 真的 resolve 了才算送到。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  appendMessage, ensureDir, ledgerFile, readAll, readRoom, readSince, writeRoom,
} from './src/room.js';

export const name = 'salon-room';
export const inject = ['webServer', 'tools'];

const MAX_UPLOAD = 32 * 1024 * 1024;

function normalize(raw) {
  return {
    mode: raw?.mode ?? 'room',
    port: Number(raw?.port ?? 40765),
    // 默认落在插件自己的 state/ 下：插件搬到哪，账就跟着去哪。
    stateDir: raw?.stateDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'state'),
    owner: raw?.owner ?? '屋主',
    // 只请这些工作区里、没归档的会话。留空＝不按工作区筛（但仍然排除归档与子代理）。
    workspaces: (Array.isArray(raw?.workspaces) ? raw.workspaces : raw?.workspace ? [raw.workspace] : [])
      .map(item => String(item ?? '').trim())
      .filter(Boolean),
  };
}

/** 名字长的先匹配；ASCII 名卡边界，中文名不卡。 */
function mentionedIn(names, text) {
  const found = [];
  for (const member of [...names].sort((a, b) => b.length - a.length)) {
    const ascii = /^[\x20-\x7e]+$/.test(member);
    if (!ascii) {
      if (text.includes(`@${member}`)) found.push(member);
      continue;
    }
    const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`@${escaped}(?![\\w-])`).test(text)) found.push(member);
  }
  return found;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  if (content.some(block => block?.type === 'tool-call')) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim();
}

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig);
  if (config.mode !== 'room') return;

  const room = ledgerFile(config.stateDir);
  const logFile = path.join(config.stateDir, 'salon.log');
  const filesDir = path.join(config.stateDir, 'files');
  const namesFile = path.join(config.stateDir, 'names.json');
  let members = [];
  // 房间自己的名字（不是谁的昵称）。空着就用「群聊」。
  let roomTitle = '';
  const titleText = () => roomTitle || '群聊';
  // 昵称与头像字：自己起的名字放在这里，键是 sessionId；屋主用 'owner'。
  // 没写的就用会话自己的命名 / 名字第一个字——这里只存「改过的」。
  let overrides = {};

  const log = line => {
    const text = `${new Date().toISOString()}  ${line}`;
    console.log(`[salon] ${line}`);
    void appendLine(logFile, text);
  };
  async function appendLine(file, text) {
    try {
      await ensureDir(path.dirname(file));
      const { appendFile } = await import('node:fs/promises');
      await appendFile(file, `${text}\n`, 'utf8');
    } catch {
      // 日志写不进去不该拦住房间
    }
  }

  /* ── 会话：列表与投递 ───────────────────────────────────── */

  /** 归档了的会话：注册表自己记着（archivedSessionIds），恢复之前不许叫醒。 */
  function archivedIds() {
    const registry = ctx.get?.('workspaceRegistry');
    const ids = registry?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  }

  function sameDir(a, b) {
    const norm = p => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
  }

  async function listSessions() {
    const controller = ctx.get?.('sessionController') ?? ctx.get?.('sessions');
    if (!controller || typeof controller.list !== 'function') {
      throw new Error('这个宿主没有会话列表服务（sessionController.list 不可用）');
    }
    const out = await controller.list({});
    const items = Array.isArray(out?.items) ? out.items : Array.isArray(out) ? out : [];
    const archived = archivedIds();
    return items
      .filter(row => row && typeof row.sessionId === 'string' && row.sessionId)
      // 子代理不是一间「可以请他说话」的会话
      .filter(row => row.origin !== 'subagent')
      .filter(row => !archived.has(row.sessionId))
      // 任务工作区：只列这个目录里的
      .filter(row => !config.workspaces.length || config.workspaces.some(w => sameDir(row.cwd, w)))
      .map(row => ({
        sessionId: row.sessionId,
        title: String(row.projections?.values?.title ?? row.title ?? row.sessionId),
        cwd: String(row.cwd ?? ''),
        running: row.running === true,
        origin: String(row.origin ?? ''),
      }));
  }

  /* 会话名单的短缓存。
   * 「谁叫什么」全是从会话列表摊出来的，而 listSessions() 得枚举全部会话——
   * 2026-11-16 实测 94 间、82–195ms 一次；发一句话、开一次面板都要付这一笔。
   * 10 秒内复用同一份：改名走 overrides，不经过这里，所以改完立刻生效；
   * 加人、移人这类真要看准的地方传 fresh，顺手把缓存换成新的。
   */
  const SESSIONS_TTL_MS = 10000;
  let sessionsMemo = { at: 0, list: null };

  async function sessionsCached(options = {}) {
    const now = Date.now();
    const hit = sessionsMemo.list;
    if (!options.fresh && hit && now - sessionsMemo.at < SESSIONS_TTL_MS) return hit;
    try {
      const list = await listSessions();
      sessionsMemo = { at: now, list };
      return list;
    } catch (error) {
      // 列不出来就沿用上一份：宁可名字旧两秒，也不让整间屋子一起卡住。
      if (hit) return hit;
      throw error;
    }
  }

  /* ── 附件 ───────────────────────────────────────────────
   * 文件本体落在 state/files/，账上只记「叫什么、多大、怎么取」。
   * 投给会话时给的是绝对路径——那间会话是用文件工具去读的，不是看网址。
   */

  const TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };

  function safeName(raw) {
    const base = String(raw ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    return (base || '未命名文件').slice(-120);
  }

  function typeOf(name) {
    return TYPES[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream';
  }

  function humanSize(bytes) {
    const n = Number(bytes ?? 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** 收一份文件：名字去危险字符，落盘时加时间戳前缀免得撞名。 */
  async function saveFile(name, buffer) {
    const original = safeName(name);
    const stored = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}-${original}`;
    await ensureDir(filesDir);
    await fs.writeFile(path.join(filesDir, stored), buffer);
    return {
      name: original,
      stored,
      size: buffer.length,
      type: typeOf(original),
      url: `/salon/files/${encodeURIComponent(stored)}`,
    };
  }

  /** 只认 files/ 里的单层文件名；带路径的一律当不存在。 */
  async function openFile(stored) {
    const base = path.basename(String(stored ?? ''));
    if (!base || base !== String(stored ?? '')) return undefined;
    try {
      return await fs.readFile(path.join(filesDir, base));
    } catch {
      return undefined;
    }
  }

  function filePathOf(file) {
    return path.join(filesDir, file.stored);
  }

  /** 投给会话的那几行：给路径，不给网址——它要用文件工具自己打开。 */
  function fileLines(files) {
    if (!Array.isArray(files) || !files.length) return [];
    return [
      '附件：',
      ...files.map(f => `- ${f.name}（${f.type}，${humanSize(f.size)}）：${filePathOf(f)}`),
    ];
  }

  /** 投一句进去。送回的是「怎么送到的」；送不到就抛，别把它说成已送达。 */
  function userPayload(text) {
    const id = `salon-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: id },
    };
  }

  /**
   * 投一句进去。送回的是「怎么送到的」；送不到就抛，别把它说成已送达。
   *
   * 三条路，按「离宿主最近」的顺序试：
   *  ① 那间会话正活着（窗口里开着）→ 直接把话放进它的收件箱（followup）。
   *  ② 会话服务（sessionController.prompt）→ 它自己 resolveAgent，能处理没载入的会话。
   *  ③ agents.resume 再 followup → 老路，最后兜底。
   * 走哪条、哪条失败，全写进 salon.log，不再靠猜。
   */
  async function deliver(member, text, mode = 'queue') {
    const payload = userPayload(text);
    const agents = ctx.get?.('agents');
    const tried = [];

    // ① 会话服务：宿主自己的正规入口，冷的热的它都管（内部 resolveAgent，
    //    再按 mode 走 followup / steer）。第二个参数是 AbortSignal——它进来第一行就是
    //    signal.throwIfAborted()，所以绝不能把消息来源塞在那里（11-14 23:01 那次
    //    「signal.throwIfAborted is not a function」就是这么来的）。来源由它按 requestId 自己拼。
    const controller = ctx.get?.('sessionController');
    if (controller && typeof controller.prompt === 'function') {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('十五秒没应答，算了')), 15000);
      try {
        await controller.prompt(
          {
            sessionId: member.sessionId,
            requestId: payload.id,
            mode: mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          abort.signal,
        );
        return '投进去了（会话服务）';
      } catch (error) {
        tried.push(`会话服务：${why(error)}`);
        log(`投递①（会话服务）没成：${why(error)}｜${stack(error)}`);
      } finally {
        clearTimeout(timer);
      }
    } else {
      tried.push('会话服务：宿主没给 prompt');
    }

    // ② 会话正开着：直接进它的收件箱。
    const live = agents?.get?.(member.sessionId)?.agent;
    if (live && typeof live.followup === 'function') {
      try {
        await live.followup(payload);
        return '投进了开着的会话';
      } catch (error) {
        tried.push(`开着的会话：${why(error)}`);
        log(`投递②（开着的会话）没成：${why(error)}`);
      }
      // 它正跑着时收件箱可能不接；steer 是「插进当前这一步」。
      if (typeof live.steer === 'function') {
        try {
          await live.steer(userPayload(text));
          return '插进去了（那间会话正开着）';
        } catch (error) {
          tried.push(`插话：${why(error)}`);
          log(`投递②b（插话）没成：${why(error)}`);
        }
      }
    }

    // ③ 最后才唤醒：会话正开着时这一步会被宿主拒（active write handle）。
    if (typeof agents?.resume === 'function') {
      try {
        const resumed = await agents.resume({ resumeSessionId: member.sessionId });
        const agent = resumed?.agent ?? resumed;
        if (typeof agent?.followup !== 'function') throw new Error('唤醒回来了，但没有 followup');
        await agent.followup(userPayload(text));
        return '先唤醒，再投进去';
      } catch (error) {
        tried.push(`唤醒再投：${why(error)}`);
        log(`投递③（唤醒再投）没成：${why(error)}`);
      }
    } else {
      tried.push('唤醒再投：宿主没有 agents.resume');
    }

    throw new Error(`「${member.name}」那间会话打不开（${member.sessionId}）—— ${tried.join('；')}`);
  }

  function why(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function stack(error) {
    const lines = error instanceof Error && error.stack ? error.stack.split('\n').slice(1, 5) : [];
    return lines.join(' ← ').replace(/\s+/g, ' ').trim();
  }

  /* ── 房间 ───────────────────────────────────────────────── */

  /** 只收已经在 files/ 里的那几条（客户先上传、再发话），不在这里落盘。 */
  async function cleanFiles(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const item of input) {
      const stored = String(item?.stored ?? '');
      if (!stored || path.basename(stored) !== stored) continue;
      // 客户端漏报大小时，去盘上看一眼；名字漏报时，把落盘时间前缀剥掉当成原名。
      let size = Number(item?.size ?? 0) || 0;
      if (!size) {
        try { size = (await fs.stat(path.join(filesDir, stored))).size; } catch { size = 0; }
      }
      // 落盘名是 `<时间36进制>-<随机4位>-<原名>`，剥掉这两段就是原名。
      const fallback = stored.replace(/^[a-z0-9]+-[0-9a-f]{4}-/i, '');
      out.push({
        name: safeName(item?.name ?? fallback),
        stored,
        size,
        type: String(item?.type ?? typeOf(stored)),
        url: `/salon/files/${encodeURIComponent(stored)}`,
      });
    }
    return out;
  }

  async function say({ from, text, to, files, mode }) {
    await syncNames();
    const clean = String(text ?? '').trim();
    const who = String(from ?? ownerView().name).trim() || ownerView().name;
    const attached = await cleanFiles(files);
    if (!clean && !attached.length) return { row: undefined, woke: [] };

    // 指向靠栏里选（to），不靠正文里的 @；没给 to 时才退回老的 @ 解析。
    // to 里可以是具体名字，也可以是 '*'（＝所有人）——栏里的「所有人」就发这个。
    const picked = Array.isArray(to) ? to.map(String).filter(Boolean) : [];
    const wantsAll = picked.some(name => name === '*' || name === '所有人' || name === '@所有人');
    const named = picked.filter(name => name !== '*' && name !== '所有人' && name !== '@所有人');
    // 名单只在开头抓一次快照：后面每送一个人都从这份里取。中间有人被移出、被改名，
    // 旧写法会在 await 之后重查 members、取不到就 continue——看着叫了，其实没叫。
    const roster = new Map(members.map(m => [m.name, m]));
    const names = who === '系统'
      ? []
      : wantsAll
        ? members.map(m => m.name).filter(name => name !== who)
        : named.length
          ? named.filter(name => roster.has(name) && name !== who)
          : mentionedIn(members.map(m => m.name), clean);
    const row = await appendMessage(room, {
      from: who, text: clean, to: names, files: attached.length ? attached : undefined,
    });
    const woke = [];
    // 没送到的人要落进账里。只回给发送方一行小字，一刷新就没了，而账上那条还写着「→ 某某」，
    // 看着像送到了——这是最坑的一种谎。
    const failed = [];
    const miss = line => { woke.push(line); failed.push(line); };

    // 栏里选的名字要真在屋里；选错了不能悄悄丢掉，得说一声。
    if (picked.length) {
      for (const name of named) {
        if (name === who) continue;
        if (!roster.has(name)) {
          miss(`${name}：没叫人（屋里没有这个名字，先看看「发给」里列着谁）`);
        }
      }
    }

    // 叫醒的话只说「谁说了什么、有没有附件、去哪儿看」。
    // 群里的前后文不往里塞：要不要看由那间会话自己决定（salon_read），
    // 塞进去等于替它把眼睛撑开，而且每句话都拖着十二行旧账。
    // 一起发、不排队：五个人里有一个卡住，串行就要干等五个 15 秒。
    const sent = await Promise.allSettled(names.map(async name => {
      const member = roster.get(name);
      if (!member || member.name === who) return null;
      const note = [
        `【三人间 #${row.seq}】${who}：${clean || '（只发了附件）'}`,
        ...(attached.length ? ['', ...fileLines(attached)] : []),
        '',
        `（要接话就照常回，你的回话会落在屋里。要看屋里前后说了什么，用 salon_read`
        + `（since: ${Math.max(row.seq - 1, 0)}，就是这条之前的部分）；不想看就不看，不接也行。）`,
      ].join('\n');
      if (archivedIds().has(member.sessionId)) {
        return { line: `${name}：没叫醒（这间会话归档了，先在 DSH 里恢复它）`, ok: false };
      }
      try {
        return { line: `${name}：${await deliver(member, note, mode)}`, ok: true };
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        log(`叫醒 ${name} 没成：${why}`);
        return { line: `${name}：没叫醒（${why}）`, ok: false };
      }
    }));
    // 结果按『发给』里的顺序排，不按谁先回来——同一句话看两遍，顺序该是一样的。
    for (const entry of sent) {
      const hit = entry.status === 'fulfilled' ? entry.value : null;
      if (!hit) continue;
      if (hit.ok) woke.push(hit.line); else miss(hit.line);
    }
    // 落一条系统行，指回那条没送到的消息：刷新、换台机器、过一夜都还看得见。
    if (failed.length) {
      try {
        await appendMessage(room, {
          from: '系统',
          text: `#${row.seq} ${failed.join('；')}`,
          kind: 'system',
        });
      } catch (error) {
        log(`叫醒结果没落账：${error?.message ?? error}`);
      }
    }
    return { row, woke };
  }


  /** 名字只有一个来源：会话自己的命名（title）。没命名就用「未命名会话」，
   *  撞名了加尾号——房间里显示的名字永远跟着那间会话走，不另存一份。 */
  /** 头像那个字：按码点取第一个（emoji 也算一个，不会劈成半个）。 */
  function firstChar(text) {
    return Array.from(String(text ?? '').trim())[0] ?? '?';
  }

  /** 屋主在屋里叫什么、头像用什么字。没改过就是补丁里那个名字。 */
  function ownerView() {
    const row = overrides.owner ?? {};
    const name = String(row.name ?? '').trim() || config.owner;
    const initial = String(row.initial ?? '').trim() || firstChar(name);
    return { name, initial };
  }

  function nameFrom(sessions) {
    const byId = new Map(sessions.map(row => [row.sessionId, row]));
    const used = new Map();
    const names = new Map();
    for (const member of members) {
      const title = String(byId.get(member.sessionId)?.title ?? '').trim();
      // 自己起过名字就用自己起的；没起过才用会话自己的命名。
      const custom = String(overrides[member.sessionId]?.name ?? '').trim();
      const base = custom || title || '未命名会话';
      const seen = (used.get(base) ?? 0) + 1;
      used.set(base, seen);
      // 尾号撞上真名也不许重：一路加，直到没人用过。
      // （万一有间会话就叫「夜班·6c50」，两个名字会重合，投递就会投给先找到的那间。）
      let candidate = seen === 1 ? base : `${base}·${member.sessionId.slice(-4)}`;
      let tail = seen;
      const taken = () => Array.from(names.values());
      while (candidate !== base && taken().includes(candidate)) {
        tail += 1;
        candidate = `${base}·${member.sessionId.slice(-4)}·${tail}`;
      }
      names.set(member.sessionId, candidate);
      member.title = title;
      member.nick = custom;
      // 头像那个字：自己定过就用定的，否则取名字第一个字（emoji 也算一个）。
      const initial = String(overrides[member.sessionId]?.initial ?? '').trim();
      member.initial = initial || '';
    }
    members = members.map(member => ({ ...member, name: names.get(member.sessionId) }));
    return members;
  }

  /* ── 昵称与头像字 ─────────────────────────────────────────
   * 只存「改过的」：names.json = { [sessionId|'owner']: { name?, initial? } }。
   * 不写就是跟着会话自己的命名走——房子不替人起名，只记住人自己起的。
   */

  function roomNames() {
    const person = (key, fallbackName) => {
      const row = overrides[key] ?? {};
      const name = String(row.name ?? '').trim() || fallbackName;
      const initial = String(row.initial ?? '').trim() || firstChar(name);
      return { name, initial };
    };
    return { person };
  }

  async function loadOverrides() {
    try {
      const raw = await fs.readFile(namesFile, 'utf8');
      const parsed = JSON.parse(raw);
      overrides = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`名字本读不动，先当没改过：${error.message}`);
      overrides = {};
    }
  }

  async function saveOverrides() {
    await ensureDir(config.stateDir);
    const tmp = `${namesFile}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, namesFile);
  }

  /** 改一个人（或屋主）的昵称与头像字。空字符串表示「改回默认」。 */
  async function rename({ target, name, initial }) {
    await syncNames();
    const asked = String(target ?? '').trim();
    if (!asked) return { code: 400, problems: ['要改谁？给一个 target（会话 id 或 owner）'] };
    // 认人：owner、sessionId、或者屋里现在的名字——都归到同一个键（会话用 sessionId）。
    const hit = asked === 'owner' ? { key: 'owner', who: '屋主' } : members
      .filter(m => m.sessionId === asked || m.name === asked)
      .map(m => ({ key: m.sessionId, who: m.name }))[0];
    if (!hit) return { code: 404, problems: [`屋里没有「${asked}」——先看看「发给」里列着谁`] };
    const { key, who } = hit;
    const cleanName = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 24);
    // 撞名要挡：两个「汐」之后，to、from、@ 全都对不上人——账上分不清谁说的，
    // 发送时按名字找人只会挑到第一个，另一个等于哑了。
    if (cleanName) {
      const taken = new Set();
      if (key !== 'owner') taken.add(ownerView().name);
      for (const m of members) {
        if (m.sessionId !== key && m.name !== who) taken.add(m.name);
      }
      if (taken.has(cleanName)) {
        return { code: 400, problems: [`「${cleanName}」已经有人叫了——换个名字`] };
      }
    }
    const cleanInitial = Array.from(String(initial ?? '').trim())[0] ?? '';
    const prev = overrides[key] ?? {};
    const next = { ...prev };
    if (cleanName) next.name = cleanName; else delete next.name;
    if (cleanInitial) next.initial = cleanInitial; else delete next.initial;
    if (Object.keys(next).length) overrides[key] = next; else delete overrides[key];
    await saveOverrides();
    log(`改名：${who} → ${cleanName || '（跟会话的命名）'}；头像字 ${cleanInitial || '（用名字第一个字）'}`);
    return { code: 200, config: await configView() };
  }

  // 改房间自己的名字（不是谁的昵称）。留空＝回「群聊」。
  async function renameRoom(input) {
    const clean = String(input?.title ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 24);
    roomTitle = clean;
    await writeRoom(config.stateDir, { title: roomTitle, members });
    log('房间改名：' + titleText());
    return { code: 200, config: await configView() };
  }

  /** 把会话的命名摊到成员身上。走缓存：轮询和发话都走这一条。 */
  async function syncNames(options = {}) {
    try {
      nameFrom(await sessionsCached(options));
    } catch {
      /* 列不出来就沿用上一次的名字；config.problem 那边会说话 */
    }
    return members;
  }

  async function configView(options = {}) {
    let sessions = [];
    let problem = '';
    try {
      sessions = options.sessions ?? await sessionsCached(options);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    nameFrom(sessions);
    const held = new Set(members.map(m => m.sessionId));
    const boss = ownerView();
    return {
      title: titleText(),
      owner: boss.name,
      ownerInitial: boss.initial,
      ownerNick: String(overrides.owner?.name ?? ''),
      members: members.map(m => {
        const found = sessions.find(s => s.sessionId === m.sessionId);
        return {
          ...m,
          title: found?.title ?? '',
          alive: Boolean(found),
          running: found?.running === true,
          archived: archivedIds().has(m.sessionId),
        };
      }),
      sessions: sessions.filter(s => !held.has(s.sessionId)),
      problem,
    };
  }

  async function addMember(input) {
    const sessionId = String(input?.sessionId ?? '').trim();
    if (!sessionId) return { code: 400, problems: ['没挑会话'] };
    if (members.some(m => m.sessionId === sessionId)) {
      return { code: 400, problems: ['这间会话已经在屋里了'] };
    }
    let sessions = [];
    try {
      // 刚加完人就要看新名单：这一份一定得是当下刚列的，顺便把缓存换成新的。
      sessions = await sessionsCached({ fresh: true });
    } catch (error) {
      return { code: 500, problems: [error instanceof Error ? error.message : String(error)] };
    }
    const found = sessions.find(s => s.sessionId === sessionId);
    if (!found) {
      const archived = archivedIds().has(sessionId);
      return {
        code: 400,
        problems: [archived
          ? `「${sessionId}」那间会话归档了——先在 DSH 里恢复它，再叫进来`
          : `找不到这间会话：${sessionId}（只列 ${config.workspaces.length ? config.workspaces.join('、') : '任何工作区'} 里、没归档的会话）`],
      };
    }

    // 名字不由人起：进屋的名字就是那间会话自己的命名（title）。
    if (String(found.title ?? '').trim() === config.owner) {
      return { code: 400, problems: ['这间会话命名为屋主了——在 DSH 里改个名再叫进来'] };
    }

    members = [...members, { sessionId }];
    const live = nameFrom(sessions).find(m => m.sessionId === sessionId);
    const label = live?.name ?? '未命名会话';
    await writeRoom(config.stateDir, { title: roomTitle, members: members.map(m => ({ sessionId: m.sessionId })) });
    await appendMessage(room, { from: '系统', text: `${label} 坐进来了（${found.title || '还没命名'}）`, kind: 'join' });
    log(`加人：${label} = ${sessionId}`);
    return { code: 200, config: await configView({ sessions }) };
  }

  async function removeMember(input) {
    const name = String(input?.name ?? '').trim();
    // 移人是真要看准的动作：名字和「在不在」都得是当下这一秒的。
    await syncNames({ fresh: true });
    const member = members.find(m => m.name === name);
    if (!member) return { code: 400, problems: [`屋里没有「${name || '（空）'}」`] };
    members = members.filter(m => m !== member);
    await writeRoom(config.stateDir, { title: roomTitle, members });
    await appendMessage(room, { from: '系统', text: `${member.name} 离开了房间`, kind: 'leave' });
    log(`移出：${member.name}（${member.sessionId}）`);
    return { code: 200, config: await configView() };
  }

  /* ── 把会话的回话捞回屋里 ───────────────────────────────── */

  const seen = new Set();
  function capture(session, event) {
    const id = String(session?.id ?? '');
    const member = members.find(m => m.sessionId === id);
    if (!member) return;
    if (event?.type !== 'assistant/message') return;
    if (event?.surfaceOp === 'prepend') return;
    const message = event?.data?.message;
    const key = String(message?.id ?? '');
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 400) seen.delete(seen.values().next().value);
    }
    const text = textOf(message?.content);
    if (!text) return;
    appendMessage(room, { from: member.name, text, kind: 'say' })
      .catch(error => log(`回话没落账：${error instanceof Error ? error.message : String(error)}`));
  }

  /* ── HTTP ───────────────────────────────────────────────── */

  async function handleApi(method, pathname, query, io) {
    const json = (code, data) => ({ code, type: 'application/json', body: JSON.stringify(data) });

    if (method === 'GET' && pathname === '/api/messages') {
      const since = Number(query.get('since') ?? 0) || 0;
      return json(200, { ok: true, messages: await readSince(room, since) });
    }
    if (method === 'GET' && pathname === '/api/status') {
      const rows = await readAll(room);
      await syncNames();
      const archived = archivedIds();
      const boss = ownerView();
      return json(200, {
        ok: true,
        title: titleText(),
        owner: boss.name,
        ownerInitial: boss.initial,
        // people 给「发给」用（要知道谁在、是不是归档了）；names 只给正文里的 @ 高亮用。
        members: members.map(m => ({
          name: m.name,
          initial: m.initial || firstChar(m.name),
          nick: m.nick ?? '',
          sessionId: m.sessionId,
          archived: archived.has(m.sessionId),
        })),
        names: members.map(m => m.name),
        rows: rows.length,
      });
    }
    if (method === 'GET' && pathname === '/api/config') {
      // 设置窗是「挑会话」的地方：这份名单必须当场列，不能吃缓存。
      return json(200, { ok: true, ...(await configView({ fresh: true })) });
    }
    if (method === 'POST' && pathname === '/api/say') {
      const body = JSON.parse((await io.text()) || '{}');
      const out = await say({
        from: body.from, text: body.text, to: body.to, files: body.files, mode: body.mode,
      });
      return json(200, { ok: true, ...out });
    }
    if (method === 'POST' && pathname === '/api/title') {
      const body = JSON.parse((await io.text()) || '{}');
      const out = await renameRoom({ title: body.title });
      return json(out.code, { ok: out.code === 200, config: out.config });
    }
    if (method === 'POST' && pathname === '/api/name') {
      const body = JSON.parse((await io.text()) || '{}');
      const out = await rename({ target: body.target, name: body.name, initial: body.initial });
      if (out.code !== 200) return json(out.code, { ok: false, problems: out.problems });
      return json(200, { ok: true, config: out.config });
    }
    if (method === 'POST' && pathname === '/api/upload') {
      const name = query.get('name') ?? 'file';
      if (Number(query.get('size') ?? 0) > MAX_UPLOAD) {
        return json(413, { ok: false, problems: [`文件太大：上限 ${humanSize(MAX_UPLOAD)}`] });
      }
      let raw;
      try {
        raw = await io.raw(MAX_UPLOAD);
      } catch (error) {
        if (error?.code === 'E_TOO_LARGE') {
          return json(413, { ok: false, problems: [`文件太大：上限 ${humanSize(MAX_UPLOAD)}`] });
        }
        return json(400, { ok: false, problems: ['收不下这份文件'] });
      }
      if (!raw.length) return json(400, { ok: false, problems: ['空文件不收'] });
      const file = await saveFile(name, raw);
      log(`收了附件：${file.name}（${humanSize(file.size)}）`);
      return json(200, { ok: true, file });
    }
    if (method === 'GET' && pathname.startsWith('/files/')) {
      const stored = decodeURIComponent(pathname.slice('/files/'.length));
      const bytes = await openFile(stored);
      if (!bytes) return { code: 404, type: 'text/plain; charset=utf-8', body: '没有这个附件' };
      const kind = typeOf(stored);
      // svg 能在同源里跑脚本（/salon/files/ 与 GUI 同一个源）：一律当下载件，绝不当页面打开。
      const headers = {
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        ...(kind === 'image/svg+xml'
          ? {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${encodeURIComponent(stored)}"`,
          }
          : {}),
      };
      return { code: 200, type: kind, headers, body: bytes };
    }
    if (method === 'POST' && pathname === '/api/member/add') {
      const body = JSON.parse((await io.text()) || '{}');
      const out = await addMember(body);
      return out.code === 200 ? json(200, { ok: true, ...out }) : json(out.code, { ok: false, problems: out.problems });
    }
    if (method === 'POST' && pathname === '/api/member/remove') {
      const body = JSON.parse((await io.text()) || '{}');
      const out = await removeMember(body);
      return out.code === 200 ? json(200, { ok: true, ...out }) : json(out.code, { ok: false, problems: out.problems });
    }
    return json(404, { ok: false, problems: [`没有这个门：${method} ${pathname}`] });
  }

  /* ── 给会话的那只眼睛：salon_read ─────────────────────────
   * 叫醒时只递一句话，不塞旧账；要不要看前后文，由那间会话自己决定。
   */
  function registerTools() {
    const tools = ctx.tools ?? ctx.get?.('tools');
    if (!tools?.register) {
      log('这个宿主没有 tools 服务：屋里的话只能用眼睛看，会话读不到');
      return;
    }
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
      description: '读三人间（屋里的群聊）最近的对话。叫醒你的那句话不包含前后文；'
        + '要不要看由你决定——不调用就等于没看。返回每条的时间、说话人、正文和附件路径。',
      parameters: schema({
        since: { type: 'integer', description: '只读序号大于它的（上次读到哪儿），默认 0', required: false },
        limit: { type: 'integer', description: '最多读几条，默认 20', required: false },
      }),
      output: {
        schema: schema({ text: { type: 'string', required: true } }),
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args = {}) {
        const since = Number(args.since ?? 0) || 0;
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20;
        const rows = (await readAll(room)).filter(row => row.seq > since);
        if (!rows.length) {
          return { text: since > 0 ? `序号 ${since} 之后屋里没有人说话。` : '屋里还静着，一句话都没有。' };
        }
        const shown = rows.slice(-limit);
        const lines = shown.map(row => {
          const when = String(row.ts ?? '').slice(11, 16);
          const files = Array.isArray(row.files) && row.files.length
            ? `　[${row.files.map(f => `${f.name} → ${filePathOf(f)}`).join('；')}]`
            : '';
          return `#${row.seq} ${when} ${row.from}：${row.text}${files}`;
        });
        const head = since > 0
          ? `序号 ${since} 之后有 ${rows.length} 条，这里给最近 ${shown.length} 条：`
          : `屋里最近 ${shown.length} 条（一共 ${rows.length} 条）：`;
        return { text: `${head}\n${lines.join('\n')}` };
      },
    });
    log('salon_read 挂上了：会话要看屋里前后文，自己调这个');
  }

  ctx.effect(() => {
    const disposeEvents = [];
    try {
      registerTools();
    } catch (error) {
      log(`salon_read 没挂上：${error instanceof Error ? error.message : String(error)}`);
    }

    if (typeof ctx.on === 'function') {
      disposeEvents.push(ctx.on('session/event', (session, event) => capture(session, event), { global: true }));
    } else {
      log('这个宿主没有 ctx.on：会话回的话捞不回来，只能看着它说给自己听');
    }

    const webServer = ctx.webServer ?? ctx.get?.('webServer');
    let disposeRoute = () => {};
    if (webServer?.register) {
      disposeRoute = webServer.register({
        kind: 'prefix',
        path: '/salon',
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const pathname = url.pathname.replace(/^\/salon/, '') || '/';
          if (!originAllowed(req)) return respond(res, blocked());
          void handleApi(req.method ?? 'GET', pathname, url.searchParams, readerOf(req))
            .then(out => respond(res, out))
            .catch(error => {
              log(`请求出错：${error instanceof Error ? error.message : String(error)}`);
              respond(res, {
                code: 500,
                type: 'application/json',
                body: JSON.stringify({ ok: false, problems: [error instanceof Error ? error.message : String(error)] }),
              });
            });
        },
      });
    } else {
      log('没拿到 webServer：侧栏窗口会打不开（HTTP 路由没挂上）');
    }

    const own = httpServer(config.port, handleApi, log);
    void (async () => {
      await loadOverrides();
      const stored = await readRoom(config.stateDir);
      members = stored.members;
      roomTitle = stored.title || '';
      log(`门开了：手里 ${members.length} 位（${members.map(m => m.name).join('、') || '还空着'}）；`
        + `webServer=${webServer ? '有' : '没有'}；agents=${ctx.get?.('agents') ? '有' : '没有'}`);
    })();

    return () => {
      for (const off of disposeEvents) if (typeof off === 'function') off();
      disposeRoute();
      own?.close?.();
    };
  }, 'salon: room');
}

/** 只接本机的页面：浏览器跨站来的请求会带 Origin，别的源一律挡掉。 */
function originAllowed(req) {
  const origin = String(req?.headers?.origin ?? '').trim();
  if (!origin) return true; // 本机工具（curl / node）不带 Origin
  if (origin === 'null') return false; // file:// 或 sandbox 里的页面
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function blocked() {
  return {
    code: 403,
    type: 'application/json',
    body: JSON.stringify({ ok: false, problems: ['这个是本机的东西：不接外来的页面'] }),
  };
}

/** 两处路由共用一种写法：保留 out.headers，默认加 nosniff。 */
function respond(res, out) {
  res.statusCode = out.code;
  res.setHeader('content-type', out.type ?? 'text/plain; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
  res.end(out.body ?? '');
}

/** 一次请求的两种读法：文字（json/表单）与字节（附件）。 */function readerOf(req) {
  return {
    text: () => new Promise(resolve => {
      let data = '';
      req.setEncoding?.('utf8');
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(data));
    }),
    raw: (limit = 0) => new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      const tooLarge = () => {
        const error = new Error(`文件太大：上限 ${Math.round(limit / 1024 / 1024)} MB`);
        error.code = 'E_TOO_LARGE';
        reject(error);
      };
      req.on('data', chunk => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (limit && total > limit) { tooLarge(); req.destroy?.(); return; }
        chunks.push(buf);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', error => (limit && total > limit ? tooLarge() : resolve(Buffer.concat(chunks))));
    }),
  };
}

/* ── 独立端口：宿主路由之外还留一条 ───────────────────────── */

function httpServer(port, handleApi, log) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/^\/salon/, '') || '/';
    if (!originAllowed(req)) return respond(res, blocked());
    void handleApi(req.method ?? 'GET', pathname, url.searchParams, readerOf(req))
      .then(out => respond(res, out))
      .catch(() => respond(res, { code: 500, type: 'application/json', body: JSON.stringify({ ok: false }) }));
  });
  server.on('error', error => log(`独立端口 ${port} 没开成：${error.message}`));
  server.listen(port, '127.0.0.1');
  return server;
}
