/**
 * 底账与名单。
 * 底账 append-only；名单只记「哪个会话在屋里」，不记预设、不记代数。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

let chain = Promise.resolve();

/** 底账的解析缓存：file → { key: '大小:修改时间', rows }。 */
const cache = new Map();

function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readAll(file) {
  let raw = '';
  // 底账只增不改：文件没动就别再读一遍、再 JSON.parse 一遍。
  // 键用「大小:修改时间」——我们自己 append 之后这两样都会变，不会吃到旧账。
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      cache.delete(file);
      return [];
    }
    throw error;
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.rows;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      cache.delete(file);
      return [];
    }
    throw error;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (Number.isInteger(row?.seq)) rows.push(row);
    } catch {
      // 半行、坏行跳过
    }
  }
  cache.set(file, { key, rows });
  return rows;
}

export function appendMessage(file, partial) {
  return serial(async () => {
    const rows = await readAll(file);
    const row = {
      seq: rows.length ? rows[rows.length - 1].seq + 1 : 1,
      ts: new Date().toISOString(),
      from: partial.from,
      text: partial.text,
      to: partial.to ?? [],
    };
    if (partial.kind) row.kind = partial.kind;
    // 附件只记「叫什么、多大、取件网址」——文件本体在 files/ 里，账上不放字节。
    if (Array.isArray(partial.files) && partial.files.length) row.files = partial.files;
    await ensureDir(path.dirname(file));
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  });
}

export async function readSince(file, since = 0) {
  const rows = await readAll(file);
  return rows.filter(row => row.seq > since);
}

export function cursorFile(stateDir, key) {
  return path.join(stateDir, `cursor.${key}.json`);
}

/* ── 底账与名单各一个文件：room.jsonl / room.json ─────────── */

export function ledgerFile(stateDir) {
  return path.join(stateDir, 'room.jsonl');
}

export function roomFile(stateDir) {
  return path.join(stateDir, 'room.json');
}

export async function readRoom(stateDir) {
  try {
    const data = JSON.parse(await fs.readFile(roomFile(stateDir), 'utf8'));
    const members = Array.isArray(data?.members) ? data.members : [];
    return {
      title: typeof data?.title === 'string' ? data.title : '',
      members: members
        .filter(m => m && typeof m.sessionId === 'string' && m.sessionId !== '')
        .map(m => ({ name: String(m.name ?? m.sessionId), sessionId: String(m.sessionId) })),
    };
  } catch {
    return { title: '', members: [] };
  }
}

export async function writeRoom(stateDir, room) {
  await ensureDir(stateDir);
  const file = roomFile(stateDir);
  const tmp = `${file}.tmp`;
  const body = { title: String(room.title ?? ''), members: room.members };
  await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}
