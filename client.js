/**
 * dsh-salon —— 窗口那一半：侧栏一行图标，点开是一间屋。
 *
 * 样子照 DSH 自己的会话窗：同色、同字、同一套圆角。
 * 只做五件事：读账、说话、带附件、挑会话进来、把人移出去。
 * 数据只走同源前缀 /salon/api。
 */
window.__ModuleLoader__.load({
  id: 'dsh-salon',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef, useMemo } = React;

    // DSH 自己的 Markdown 渲染器：表格、脚注、代码块工具栏都在里面。
    // 拿不到就退回本地那套最简渲染（Md）；渲染中途抛错也由 MdGuard 接住，不白屏。
    let DSH_MARKDOWN = null;
    try { DSH_MARKDOWN = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText || null; } catch {}
    const MD_LABELS = {
      code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' } },
      footnotes: '脚注',
    };
    const MD_IMAGES = { resolve(value) {
      const s = String(value ?? '').trim();
      if (s === '') return undefined;
      if (/^https?:\/\//i.test(s)) return s;
      if (s.startsWith('/salon/files/')) return s;
      if (s.startsWith('/files/')) return '/salon' + s;
      return undefined;
    } };
    class MdGuard extends React.Component {
      constructor(props) { super(props); this.state = { bad: false }; }
      static getDerivedStateFromError() { return { bad: true }; }
      render() { return this.state.bad ? h(Md, { text: this.props.text, known: this.props.known }) : this.props.children; }
    }
    function Rich({ text, known }) {
      if (!DSH_MARKDOWN) return h(Md, { text, known });
      return h(MdGuard, { text, known },
        h(DSH_MARKDOWN, { text: String(text ?? ''), streaming: false, labels: MD_LABELS, pathImages: MD_IMAGES }));
    }

    const PANEL_ID = 'salon';
    const API = '/salon/api';
    const POLL_MS = 1500;
    // 面板里最多留多少行。底账不动，这只是不把几千个 DOM 节点挂在屏幕上。
    const MAX_ROWS = 400;
    // 拉宽拉窄照 DSH 自己那套来（dsh-client-ui-conversation 的 WidthHandle）：
    // 拖的是「内容列宽度」，不是内边距；宽度由 CSS 变量 --salon-content-width 说了算，
    // 常量与公式跟 DSH 一模一样：最小 640，边距预算 176，默认 clamp(680, 列宽*0.64, 920)，
    // 指针每动 1px 内容列宽变 2px（左右各吃一半），松手才落盘。
    const WIDTH_KEY = 'salon.contentWidth';
    const CONTENT_MIN = 640;
    const CONTENT_EDGE_BUDGET = 176;
    const CONTENT_FALLBACK_MAX = 920;
    function readWidthPref() {
      try {
        const raw = localStorage.getItem(WIDTH_KEY);
        const v = Number(raw);
        return raw !== null && Number.isFinite(v) && v > 0 ? v : null;
      } catch { return null; }
    }
    function resolveContentWidth(column, pref) {
      const max = Math.max(CONTENT_MIN, column - CONTENT_EDGE_BUDGET);
      if (pref !== null) return Math.min(Math.max(pref, CONTENT_MIN), max);
      return Math.max(680, Math.min(column * 0.64, CONTENT_FALLBACK_MAX));
    }

    // 房间自己的名字：从 /status 拿，侧栏那行与面板标题都用它。
    let ROOM_TITLE = '';

    const TEXT = {
      nav: '群聊',
      title: '群聊',
      sub: '点名才叫醒',
      empty: '屋里还静着。右上角齿轮里可以把一间会话叫进来。',
      ph: '说一句…… 上面选发给谁；选「不叫人」就只是留句话。',
      to: '发给',
      toNone: '不叫人（只留话）',
      toAll: '所有人',
      noPeople: '屋里还没有别人——右上角齿轮里叫一位进来。',
      modeTo: '叫醒方式',
      queue: '排队（它跑完这轮再看）',
      steer: '打断（插进它当前这步）',
      send: '发送',
      sending: '…',
      attach: '附件',
      attachHint: '点回形针、粘贴、或把文件拖进来',
      nickLabel: '昵称',
      initialLabel: '头像字',
      nickHint: '改完按回车或点别处就存下；留空＝跟着默认走',
      nickSaved: '名字存下了',
      padHint: '拖一下：调内容列宽（双击回默认）',
      uploading: '正在收附件…',
      uploadFailed: '附件没收成',
      settings: '房间设置',
      close: '关',
      failed: '没发出去',
      waitUpload: '还有附件在传，等它落地再发',
      addTitle: '叫一间会话进来',
      addHint: '挑一间已经开过的会话；进来之后，选它的名字说话，它回的话会落在屋里。',
      name: '在屋里的名字',
      nameFrom: '跟着会话走',
      add: '叫进来',
      noSessions: '没有可叫的会话——先在 DSH 里开一间。',
      remove: '移出',
      removeAsk: '确定移出？',
      gone: '会话不在了',
      archived: '已归档',
      running: '正在跑',
      here: '在屋里',
      empty2: '屋里还没有别人。',
      titleLabel: '群聊名称',
      titleHint: '留空就叫「群聊」；最多 24 字。按回车或点别处就存下。',
      titleSaved: '名字存下了',
    };

    async function api(path, init) {
      const res = await fetch(`${API}${path}`, { cache: 'no-store', ...init });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const why = Array.isArray(data.problems) ? data.problems.join('；') : (data.error || TEXT.failed);
        throw new Error(why);
      }
      return data;
    }

    function clockOf(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const pad = n => String(n).padStart(2, '0');
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      // 不是今天，就把日子带上——跨天的消息光看时分分不清先后。
      const now = new Date();
      const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    }

    function humanSize(bytes) {
      const n = Number(bytes ?? 0);
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }

    function hueOf(name) {
      let sum = 0;
      for (const ch of String(name)) sum = (sum * 31 + ch.codePointAt(0)) % 360;
      return sum;
    }

    function Avatar({ name, initial, size }) {
      const s = size || 24;
      // 头像那个字可以自己定；没定就取名字第一个字（按码点，emoji 不会劈成半个）。
      const mark = Array.from(String(initial || '').trim())[0] || Array.from(String(name ?? '?'))[0] || '?';
      return h('span', {
        className: 'salon-avatar',
        style: { width: s, height: s, background: `hsl(${hueOf(name)} 42% 46%)`, fontSize: Math.round(s * 0.46) },
        'aria-hidden': 'true',
      }, mark);
    }

    /** 一行「昵称 + 头像字」。失焦或回车存，走 /api/name。 */
    function NameRow({ target, label, current, nick, initial, onSaved }) {
      const [name, setName] = useState(nick || '');
      const [mark, setMark] = useState(initial || '');
      const [busy, setBusy] = useState(false);
      useEffect(() => { setName(nick || ''); setMark(initial || ''); }, [nick, initial]);
      const commit = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const out = await api('/name', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target, name, initial: mark }),
          });
          if (out.config) onSaved?.(out.config);
        } finally {
          setBusy(false);
        }
      };
      const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } };
      return h('div', { className: 'salon-invite-line' },
        h('input', {
          className: 'salon-input',
          style: { maxWidth: 150 },
          value: name,
          placeholder: `${label}：${current}`,
          onChange: e => setName(e.target.value),
          onBlur: () => void commit(),
          onKeyDown: onKey,
        }),
        h('input', {
          className: 'salon-input',
          style: { maxWidth: 58, textAlign: 'center' },
          value: mark,
          placeholder: TEXT.initialLabel,
          onChange: e => setMark(Array.from(e.target.value)[0] || ''),
          onBlur: () => void commit(),
          onKeyDown: onKey,
        }));
    }

    /** 图片地址：只认 http(s) 和本屋的文件路由；别的（比如 C:\\…\\x.png）不当图，
     *  当一段文字显示出来——宁可看见路径，也不要一个碎图标。 */
    function imageSrc(raw) {
      const url = String(raw ?? '').trim();
      if (!url) return '';
      if (/^https?:\/\//i.test(url) || url.startsWith('/salon/files/')) return url;
      if (url.startsWith('/files/')) return `/salon${url}`;
      return '';
    }

    /** 行内标记：**粗体**、`代码`、[字](链接)、![图](地址)、@名字。
     *  一律用 React 元素拼，不拼 HTML 字符串——屋里的话不可信，不能让它变成标签。 */
    function Inline({ text, known }) {
      const src = String(text ?? '');
      const names = (known || []).filter(Boolean).slice().sort((a, b) => b.length - a.length);
      const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const heads = [
        /(!\[[^\]]*\]\([^)\s]+\))/,
        /(\[[^\]]+\]\([^)\s]+\))/,
        /(\*\*[^*\n]+\*\*)/,
        /(`[^`\n]+`)/,
      ].map(r => r.source);
      const all = new RegExp(heads.join('|') + (names.length ? `|(@(?:${names.map(esc).join('|')}))` : ''), 'g');
      const out = [];
      let last = 0;
      let hit;
      let n = 0;
      while ((hit = all.exec(src))) {
        if (hit.index > last) out.push(h('span', { key: `t${n++}` }, src.slice(last, hit.index)));
        const token = hit[0];
        last = hit.index + token.length;
        if (token.startsWith('![')) {
          const mm = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
          const srcUrl = mm ? imageSrc(mm[2]) : '';
          out.push(srcUrl
            ? h('a', { key: `i${n++}`, className: 'salon-md-shot', href: srcUrl, target: '_blank', rel: 'noreferrer' },
              h('img', { src: srcUrl, alt: mm[1] || '' }))
            : h('span', { key: `i${n++}`, className: 'salon-md-raw' }, token));
        } else if (token.startsWith('[')) {
          const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
          const href = mm && /^https?:\/\//i.test(mm[2]) ? mm[2] : '';
          out.push(href
            ? h('a', { key: `l${n++}`, href, target: '_blank', rel: 'noreferrer', className: 'salon-md-link' }, mm[1])
            : h('span', { key: `l${n++}` }, mm ? `${mm[1]}（${mm[2]}）` : token));
        } else if (token.startsWith('**')) {
          out.push(h('strong', { key: `b${n++}` }, token.slice(2, -2)));
        } else if (token.startsWith('`')) {
          out.push(h('code', { key: `k${n++}`, className: 'salon-code' }, token.slice(1, -1)));
        } else {
          out.push(h('b', { key: `a${n++}`, className: 'salon-at' }, token));
        }
      }
      if (last < src.length) out.push(h('span', { key: `t${n++}` }, src.slice(last)));
      return out;
    }

    /** 最小可用的 Markdown：围栏代码块、标题、引用、列表、段落 + 行内标记。
     *  不做表格、不做 HTML 直通（那是不敢开的门）。 */
    function Md({ text, known }) {
      const src = String(text ?? '');
      const blocks = [];
      const fence = /```([\w+-]*)\n([\s\S]*?)(?:```|$)/g;
      let last = 0;
      let hit;
      while ((hit = fence.exec(src))) {
        if (hit.index > last) blocks.push({ code: false, body: src.slice(last, hit.index) });
        blocks.push({ code: true, lang: hit[1], body: hit[2].replace(/\n$/, '') });
        last = fence.lastIndex;
      }
      if (last < src.length) blocks.push({ code: false, body: src.slice(last) });

      const nodes = [];
      blocks.forEach((block, bi) => {
        if (block.code) {
          nodes.push(h('pre', { key: `c${bi}`, className: 'salon-pre' },
            block.lang ? h('span', { className: 'salon-lang' }, block.lang) : null,
            h('code', null, block.body)));
          return;
        }
        // 逐行：空的收段，列表成组，标题/引用单独成行。
        let bullets = [];
        let ordered = [];
        const flush = () => {
          if (bullets.length) {
            nodes.push(h('ul', { key: `u${bi}${nodes.length}`, className: 'salon-ul' },
              bullets.map((line, i) => h('li', { key: i }, h(Inline, { text: line, known })))));
            bullets = [];
          }
          if (ordered.length) {
            nodes.push(h('ol', { key: `o${bi}${nodes.length}`, className: 'salon-ol' },
              ordered.map((line, i) => h('li', { key: i }, h(Inline, { text: line, known })))));
            ordered = [];
          }
        };
        block.body.split(/\n/).forEach((raw, li) => {
          const line = raw.replace(/\s+$/, '');
          if (!line.trim()) { flush(); return; }
          const head = /^(#{1,6})\s+(.*)$/.exec(line);
          if (head) {
            flush();
            nodes.push(h('div', { key: `h${bi}${li}`, className: 'salon-h' }, h(Inline, { text: head[2], known })));
            return;
          }
          const quote = /^>\s?(.*)$/.exec(line);
          if (quote) {
            flush();
            nodes.push(h('blockquote', { key: `q${bi}${li}`, className: 'salon-quote' },
              h(Inline, { text: quote[1], known })));
            return;
          }
          const b = /^\s*[-*+]\s+(.*)$/.exec(line);
          if (b) { ordered.length && flush(); bullets.push(b[1]); return; }
          const o = /^\s*\d+[.)]\s+(.*)$/.exec(line);
          if (o) { bullets.length && flush(); ordered.push(o[1]); return; }
          flush();
          nodes.push(h('div', { key: `p${bi}${li}`, className: 'salon-para' }, h(Inline, { text: line, known })));
        });
        flush();
      });
      return nodes;
    }

    function FileChip({ file, dense }) {
      const isImage = String(file.type || '').startsWith('image/');
      if (isImage) {
        return h('a', {
          className: 'salon-shot', href: file.url, target: '_blank', rel: 'noreferrer',
          title: `${file.name}｜${humanSize(file.size)}`,
        }, h('img', { src: file.url, alt: file.name }));
      }
      return h('a', {
        className: dense ? 'salon-file dense' : 'salon-file',
        href: file.url, target: '_blank', rel: 'noreferrer', title: file.name,
      },
      h(Paperclip, { size: 13 }),
      h('span', { className: 'salon-file-name' }, String(file.name ?? '文件')),
      h('span', { className: 'salon-file-size' }, humanSize(file.size)));
    }

    function Files({ files, mine }) {
      if (!Array.isArray(files) || !files.length) return null;
      const shots = files.filter(f => String(f.type || '').startsWith('image/'));
      const rest = files.filter(f => !String(f.type || '').startsWith('image/'));
      return h('div', { className: mine ? 'salon-files mine' : 'salon-files' },
        shots.length ? h('div', { className: 'salon-shots' }, shots.map(f => h(FileChip, { key: f.stored || f.name, file: f }))) : null,
        rest.length ? h('div', { className: 'salon-filers' }, rest.map(f => h(FileChip, { key: f.stored || f.name, file: f, dense: true }))) : null);
    }

    function Row({ row, owner, known, marks }) {
      if (row.from === '系统' || row.kind === 'join' || row.kind === 'leave') {
        return h('div', { className: 'salon-system' }, String(row.text ?? ''));
      }
      const mine = row.from === owner;
      const hasText = String(row.text ?? '').trim() !== '';
      return h('div', { className: mine ? 'salon-row mine' : 'salon-row' },
        mine ? null : h(Avatar, { name: row.from, initial: (marks || {})[row.from] }),
        h('div', { className: 'salon-body' },
          mine ? null : h('div', { className: 'salon-who' },
            h('span', { className: 'salon-name' }, String(row.from ?? '?')),
            h('span', { className: 'salon-time' }, clockOf(row.ts))),
          hasText ? h('div', { className: mine ? 'salon-bubble' : 'salon-text' },
            h(Rich, { text: row.text, known })) : null,
          h(Files, { files: row.files, mine }),
          Array.isArray(row.to) && row.to.length
            ? h('div', { className: 'salon-tos' }, `→ ${row.to.join('、')}`)
            : null));
    }

    function Settings({ onClose, onChanged }) {
      const [cfg, setCfg] = useState(null);
      const [picked, setPicked] = useState('');
      const [pending, setPending] = useState('');
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');

      const absorb = data => {
        setCfg(data);
        setPending('');
        const first = (data.sessions || [])[0];
        setPicked(prev => (prev && data.sessions.some(s => s.sessionId === prev) ? prev : first ? first.sessionId : ''));
      };

      useEffect(() => {
        api('/config').then(absorb).catch(e => setNote(String((e && e.message) || e)));
      }, []);

      // Esc 关窗：只在 window 上听一次，卸载时摘掉。输入框里的 Esc 也归这里管——
      // 设置窗没有别的「取消上一层」的语义，Esc 就该是关窗。
      useEffect(() => {
        const onKey = e => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onClose?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      // 房间自己的名字：改的是这间屋，不是谁的昵称。
      const saveTitle = async raw => {
        const want = String(raw ?? '').trim();
        const now = (cfg && cfg.title) || TEXT.title;
        if (want === now || (want === '' && now === TEXT.title)) return;
        try {
          const out = await api('/title', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: want }),
          });
          if (out.config) {
            absorb(out.config);
            ROOM_TITLE = out.config.title || '';
          }
          setNote(TEXT.titleSaved);
          onChanged?.();
        } catch (e) {
          setNote(String((e && e.message) || e));
        }
      };

      const add = async () => {
        if (busy || !picked) return;
        setBusy(true);
        setNote('');
        try {
          const out = await api('/member/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: picked }),
          });
          if (out.config) absorb(out.config);
          setNote('叫进来了');
          onChanged?.();
        } catch (e) {
          setNote(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const remove = async who => {
        if (pending !== who) {
          setPending(who);
          setNote(`${who}：再点一次就移出去`);
          return;
        }
        setPending('');
        setBusy(true);
        try {
          const out = await api('/member/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: who }),
          });
          if (out.config) absorb(out.config);
          setNote(`${who} 移出去了`);
          onChanged?.();
        } catch (e) {
          setNote(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const sessions = cfg?.sessions ?? [];
      const members = cfg?.members ?? [];

      return h('div', { className: 'salon-mask', onClick: onClose },
        h('div', { className: 'salon-sheet', onClick: e => e.stopPropagation() },
          h('div', { className: 'salon-sheet-head' }, TEXT.settings),
          h('div', { className: 'salon-sheet-sub' }, cfg ? cfg.owner : '正在读房间'),

          cfg && cfg.problem ? h('div', { className: 'salon-hintline warn' }, cfg.problem) : null,

          h('div', { className: 'salon-field' },
            h('div', { className: 'salon-field-name' }, TEXT.titleLabel),
            h('div', { className: 'salon-hintline' }, TEXT.titleHint),
            h('input', {
              className: 'salon-input-line',
              type: 'text',
              maxLength: 24,
              defaultValue: (cfg && cfg.title) || '',
              placeholder: TEXT.titleLabel,
              onKeyDown: e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveTitle(e.currentTarget.value);
                }
              },
              onBlur: e => void saveTitle(e.currentTarget.value),
            })),



          h('div', { className: 'salon-field salon-invite' },
            h('div', { className: 'salon-field-name' }, TEXT.addTitle),
            h('div', { className: 'salon-hintline' }, TEXT.addHint),
            sessions.length
              ? h('select', {
                className: 'salon-input-line',
                value: picked,
                onChange: e => setPicked(e.target.value),
              }, sessions.map(s => h('option', { key: s.sessionId, value: s.sessionId },
                `${s.title}${s.running ? `（${TEXT.running}）` : ''} · ${String(s.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-1)[0] || s.sessionId.slice(0, 8)}`)))
              : h('div', { className: 'salon-hintline warn' }, TEXT.noSessions),
            h('div', { className: 'salon-hintline' },
              `${TEXT.name}: ${(sessions.find(s2 => s2.sessionId === picked)?.title || '未命名会话')} —— ${TEXT.nameFrom}`),
            h('div', { className: 'salon-invite-line' },
              h('button', {
                className: 'salon-btn primary',
                type: 'button',
                disabled: busy || !picked,
                onClick: () => void add(),
              }, TEXT.add))),

          h('div', { className: 'salon-sheet-sub' }, `${TEXT.nickLabel} / ${TEXT.initialLabel}`),
          h('div', { className: 'salon-field' },
            h('div', { className: 'salon-field-head' },
              h(Avatar, { name: cfg?.owner || '', initial: cfg?.ownerInitial, size: 18 }),
              h('span', { className: 'salon-field-name' }, cfg?.owner || '屋主'),
              h('span', { className: 'salon-grow' }),
              h('span', { className: 'salon-tag on' }, '屋主')),
            h(NameRow, {
              target: 'owner',
              label: TEXT.nickLabel,
              current: cfg?.owner || '',
              nick: (cfg?.owner || '') === 'owner' ? '' : (cfg?.ownerNick || ''),
              initial: cfg?.ownerInitial || '',
              onSaved: data => { absorb(data); onChanged?.(); },
            })),
          h('div', { className: 'salon-hintline' }, TEXT.nickHint),

          members.length
            ? members.map(m => h('div', { className: 'salon-field', key: m.name },
              h('div', { className: 'salon-field-head' },
                h(Avatar, { name: m.name, initial: m.initial, size: 18 }),
                h('span', { className: 'salon-field-name' }, m.name),
                h('span', {
                  className: m.archived ? 'salon-tag warn' : m.alive ? 'salon-tag on' : 'salon-tag',
                }, m.archived ? TEXT.archived : m.alive ? (m.running ? TEXT.running : TEXT.here) : TEXT.gone),
                h('span', { className: 'salon-grow' }),
                h('button', {
                  className: pending === m.name ? 'salon-mini danger' : 'salon-mini',
                  type: 'button',
                  onClick: () => void remove(m.name),
                }, pending === m.name ? TEXT.removeAsk : TEXT.remove)),
              h(NameRow, {
                target: m.sessionId,
                label: TEXT.nickLabel,
                current: m.name,
                nick: m.nick || '',
                initial: m.initial || '',
                onSaved: data => { absorb(data); onChanged?.(); },
              }),
              h('div', { className: 'salon-hintline' }, `${m.title || '（没有标题）'} · ${m.sessionId}`)))
            : h('div', { className: 'salon-sheet-sub' }, TEXT.empty2),

          h('div', { className: 'salon-sheet-foot' },
            h('button', { className: 'salon-btn', type: 'button', onClick: onClose }, TEXT.close))));
    }

    function Panel() {
      const [rows, setRows] = useState([]);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');
      const [settings, setSettings] = useState(false);
      const [targets, setTargets] = useState([]);
      const [mode, setMode] = useState('queue');
      const [files, setFiles] = useState([]);
      const [uploading, setUploading] = useState(0);
      const [drop, setDrop] = useState(false);
      const listRef = useRef(null);
      const stickRef = useRef(true);
      // 内容列宽：null = 跟着窗口算（DSH 的默认公式）；拖过就是一个定数，记在浏览器里。
      const [width, setWidth] = useState(() => readWidthPref());
      const [column, setColumn] = useState(0);
      const [dragging, setDragging] = useState(false);
      const panelRef = useRef(null);
      const dragRef = useRef(null);
      const inputRef = useRef(null);
      const textRef = useRef(null);

      useEffect(() => {
        let live = true;
        let timer;
        let since = 0;
        const tick = async () => {
          try {
            const data = await api(`/messages?since=${since}`);
            if (!live) return;
            const list = Array.isArray(data.messages) ? data.messages : [];
            if (list.length) {
              since = list[list.length - 1].seq;
              // 只留最近一屏多一点：一天不关窗，几千个节点会把滚动和 React 都拖慢。
              setRows(prev => {
                const next = prev.concat(list);
                return next.length > MAX_ROWS ? next.slice(-MAX_ROWS) : next;
              });
            }
            setError('');
          } catch (e) {
            if (live) setError(String((e && e.message) || e));
          }
          if (live) timer = setTimeout(tick, POLL_MS);
        };
        api('/status').then(d => {
          if (!live) return;
          if (d && typeof d.title === 'string') ROOM_TITLE = d.title;
          setStatus(d);
        }).catch(() => {});
        tick();
        return () => { live = false; clearTimeout(timer); };
      }, []);

      // 量一次列宽（DSH 也是拿 container.offsetWidth 当分母），窗口一变就重算。
      useEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const publish = () => setColumn(el.clientWidth || 0);
        publish();
        if (typeof ResizeObserver !== 'function') return;
        const ro = new ResizeObserver(publish);
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      const contentWidth = resolveContentWidth(column || 748, width);
      const roomTitle = (status && typeof status.title === 'string' && status.title) || ROOM_TITLE || TEXT.title;

      useEffect(() => {
        const el = listRef.current;
        // 只有在贴着底的时候才自动滚：往回翻历史，不该被新行拽回去。
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
      }, [rows.length, files.length]);

      /** 收到文件就立刻upload：附件的账先落地，发话时只带那张清单。 */
      const take = async list => {
        const picked = Array.from(list || []).filter(f => f && f.size >= 0);
        if (!picked.length) return;
        setUploading(n => n + picked.length);
        for (const f of picked) {
          try {
            const res = await fetch(`${API}/upload?name=${encodeURIComponent(f.name || 'file')}`, {
              method: 'POST',
              body: f,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok || !data.file) throw new Error(data.problems?.join('；') || TEXT.uploadFailed);
            setFiles(prev => prev.concat(data.file));
          } catch (e) {
            setNote(`${f.name}：${String((e && e.message) || TEXT.uploadFailed)}`);
          } finally {
            setUploading(n => Math.max(0, n - 1));
          }
        }
      };

      const submit = async () => {
        const text = draft.trim();
        if ((!text && !files.length) || busy) return;
        // 附件还在传：这会儿发出去，那条消息就少了附件，而且没有任何提示。
        if (uploading > 0) { setNote(TEXT.waitUpload); return; }
        setBusy(true);
        setNote('');
        try {
          const out = await api('/say', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              to: targets,
              files,
              mode,
            }),
          });
          setDraft('');
          if (textRef.current) textRef.current.style.height = '';
          setFiles([]);
          setTargets([]);
          setNote(Array.isArray(out.woke) && out.woke.length ? out.woke.join(' · ') : '');
        } catch (e) {
          setNote(String((e && e.message) || TEXT.failed));
        } finally {
          setBusy(false);
        }
      };

      // 把手：照 DSH 的 WidthHandle 写——指针捕获、rAF 合并、松手才落盘、双击回默认。
      const handleProps = side => ({
        onPointerDown: e => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dragRef.current = { side, origin: e.clientX, latest: e.clientX, base: contentWidth, frame: null };
          setDragging(true);
          e.currentTarget.toggleAttribute('data-dragging', true);
        },
        onPointerMove: e => {
          const drag = dragRef.current;
          if (!drag) return;
          if (e.currentTarget.hasPointerCapture && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const box = e.currentTarget.getBoundingClientRect();
          e.currentTarget.style.setProperty('--salon-handle-pointer-y', ((e.clientY - box.top) | 0) + 'px');
          drag.latest = e.clientX;
          if (drag.frame !== null) return;
          drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            const outward = side === 'right' ? drag.latest - drag.origin : drag.origin - drag.latest;
            setWidth(Math.round(Math.max(CONTENT_MIN, drag.base + outward * 2)));
          });
        },
        onPointerUp: e => {
          const drag = dragRef.current;
          if (!drag) return;
          if (drag.frame !== null) { cancelAnimationFrame(drag.frame); drag.frame = null; }
          const moved = drag.latest !== drag.origin;
          dragRef.current = null;
          setDragging(false);
          e.currentTarget.toggleAttribute('data-dragging', false);
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          if (moved) {
            const outward = side === 'right' ? drag.latest - drag.origin : drag.origin - drag.latest;
            const final = resolveContentWidth(column || 748, Math.max(CONTENT_MIN, drag.base + outward * 2));
            setWidth(Math.round(final));
            try { localStorage.setItem(WIDTH_KEY, String(Math.round(final))); } catch { /* 存不下就算了 */ }
          }
        },
        onPointerCancel: e => {
          const drag = dragRef.current;
          if (!drag) return;
          if (drag.frame !== null) { cancelAnimationFrame(drag.frame); drag.frame = null; }
          dragRef.current = null;
          setDragging(false);
          e.currentTarget.toggleAttribute('data-dragging', false);
        },
        onDoubleClick: () => {
          setWidth(null);
          try { localStorage.removeItem(WIDTH_KEY); } catch { /* 删不掉就算了 */ }
        },
      });

      const owner = (status && status.owner) || '';
      const people = useMemo(() => (status && Array.isArray(status.members) ? status.members : []), [status]);
      const known = useMemo(() => (status && Array.isArray(status.names) ? status.names : people.map(m => m.name)), [status]);
      // 头像字：按名字查（消息行只知道谁说的，不知道 sessionId）。
      const marks = useMemo(() => {
        const out = {};
        for (const m of people) out[m.name] = m.initial || '';
        if (status && status.owner) out[status.owner] = status.ownerInitial || '';
        return out;
      }, [people, status]);
      const canSend = (draft.trim() !== '' || files.length > 0) && uploading === 0;

      return h('div', {
        ref: panelRef,
        className: 'salon-panel' + (drop ? ' dropping' : '') + (dragging ? ' dragging' : ''),
        style: { '--salon-content-width': contentWidth + 'px' },
        onDragOver: e => { e.preventDefault(); if (!drop) setDrop(true); },
        onDragLeave: e => { if (e.currentTarget === e.target) setDrop(false); },
        onDrop: e => {
          e.preventDefault();
          setDrop(false);
          void take(e.dataTransfer?.files);
        },
      },
      h('div', {
        className: 'salon-head',
      },
        h(Avatar, { name: roomTitle, size: 20 }),
        h('div', { className: 'salon-head-text' },
          h('div', { className: 'salon-title' }, roomTitle),
          h('div', { className: 'salon-meta' },
            known.length ? `${known.join('、')} · ${TEXT.sub}` : TEXT.empty)),
        h('span', { className: 'salon-grow' }),
        h('button', { className: 'salon-icon-btn', type: 'button', title: TEXT.settings, onClick: () => setSettings(true) }, h(Gear))),

      h('div', {
        className: 'salon-list',
        ref: listRef,
        onScroll: e => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        },
      },
        // 内容走一列、居中——照 DSH 的 .column（max-width + margin:0 auto）。
        h('div', { className: 'salon-flow' },
          rows.length
            ? rows.map(row => h(Row, { key: row.seq, row, owner, known, marks }))
            : h('div', { className: 'salon-empty' }, error ? `读不到房间：${error}` : TEXT.empty))),

      h('div', {
        className: 'salon-foot',
      },
        h('div', { className: 'salon-to' },
          h('span', { className: 'salon-to-label' }, TEXT.to),
          // 可以点多个人；「所有人」另算一个按钮。再点一次取消。
          people.length
            ? h('div', { className: 'salon-chips' },
              h('button', {
                className: targets.includes('*') ? 'salon-chip on' : 'salon-chip',
                type: 'button',
                onClick: () => setTargets(prev => (prev.includes('*') ? prev.filter(n => n !== '*') : ['*'])),
              }, TEXT.toAll),
              people.map(m => h('button', {
                key: m.sessionId ?? m.name,
                className: targets.includes(m.name) ? 'salon-chip on' : 'salon-chip',
                type: 'button',
                disabled: Boolean(m.archived),
                title: m.archived ? TEXT.archived : m.name,
                // 在「所有人」上点掉一个：换成其余人的显式名单，把 '*' 抹掉。
                // 留着 '*' 服务端（index.js 的 wantsAll）就还发全体，点了等于没点。
                onClick: () => setTargets(prev => (prev.includes('*')
                  ? people.filter(p => !p.archived && p.name !== m.name).map(p => p.name)
                  : (prev.includes(m.name) ? prev.filter(n => n !== m.name) : prev.concat(m.name)))),
              }, m.archived ? `${m.name}（${TEXT.archived}）` : m.name)))
            : h('span', { className: 'salon-hintline' }, TEXT.noPeople),
          h('span', { className: 'salon-to-label' }, TEXT.modeTo),
          h('select', {
            className: 'salon-to-select',
            value: mode,
            onChange: e => setMode(e.target.value),
          },
          h('option', { value: 'queue' }, TEXT.queue),
          h('option', { value: 'steer' }, TEXT.steer))),

        files.length || uploading
          ? h('div', { className: 'salon-attaches' },
            files.map(f => h('div', { key: f.stored || f.name, className: 'salon-attach' },
              h(FileChip, { file: Object.assign({}, f, { url: f.url }), dense: true }),
              h('button', {
                className: 'salon-x',
                type: 'button',
                title: '去掉',
                onClick: () => setFiles(prev => prev.filter(item => item !== f)),
              }, '×'))),
            uploading ? h('div', { className: 'salon-attach muted' }, `${TEXT.uploading}${uploading}`) : null)
          : null,

        h('div', { className: 'salon-composer' },
          h('textarea', {
            className: 'salon-input',
            ref: textRef,
            value: draft,
            rows: 1,
            placeholder: TEXT.ph,
            onChange: e => {
              setDraft(e.target.value);
              // 草稿长了就跟着长高（封顶在 CSS 的 max-height），发出去再缩回来。
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            },
            onPaste: e => {
              const items = e.clipboardData?.files;
              if (items && items.length) {
                e.preventDefault();
                void take(items);
              }
            },
            onKeyDown: e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            },
          }),
          h('div', { className: 'salon-composer-foot' },
            h('button', {
              className: 'salon-icon-btn',
              type: 'button',
              title: TEXT.attachHint,
              onClick: () => inputRef.current?.click(),
            }, h(Paperclip, { size: 15 })),
            h('input', {
              ref: inputRef,
              type: 'file',
              multiple: true,
              style: { display: 'none' },
              onChange: e => {
                void take(e.target.files);
                e.target.value = '';
              },
            }),
            h('span', { className: 'salon-note' }, note || (error ? `连不上屋：${error}` : '')),
            h('button', {
              className: 'salon-send',
              type: 'button',
              disabled: busy || !canSend,
              onClick: () => void submit(),
            }, busy ? TEXT.sending : TEXT.send)))),

        settings ? h(Settings, {
          onClose: () => setSettings(false),
          onChanged: () => setNote(''),
        }) : null,

        h('div', Object.assign({ className: 'salon-gutter salon-gutter-l', title: TEXT.padHint }, handleProps('left'))),
        h('div', Object.assign({ className: 'salon-gutter salon-gutter-r', title: TEXT.padHint }, handleProps('right'))));
    }

    function Paperclip({ size }) {
      return h('svg', {
        width: size || 15, height: size || 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M20 11.5 12.2 19.3a4.2 4.2 0 0 1-6-6l8-8a2.8 2.8 0 0 1 4 4l-8 8a1.4 1.4 0 0 1-2-2l7.3-7.3' }));
    }

    function Gear() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
        h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1z' }));
    }

    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8.6l-4.2 3.2v-3.2H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z' }),
        h('circle', { cx: 9, cy: 11, r: 1 }),
        h('circle', { cx: 13, cy: 11, r: 1 }),
        h('circle', { cx: 17, cy: 11, r: 1 }));
    }

    /* 颜色与字号都走 DSH 自己的 token（dsw-*），换主题时跟着变。 */
    const CSS = `
.salon-panel{
  --salon-line:var(--dsw-alias-border-l1,rgba(128,128,128,.22));
  --salon-line-2:var(--dsw-alias-border-l2,rgba(128,128,128,.3));
  --salon-soft:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));
  --salon-acc:var(--dsw-alias-brand-primary,#4ea1ff);
  --salon-text:var(--dsw-alias-label-primary,inherit);
  --salon-muted:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));
  display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--dsw-alias-bg-base,transparent);color:var(--salon-text);
  font-family:var(--dsw-font-family,inherit);font-size:var(--dsh-content-font-size,14px);position:relative}
.salon-panel.dropping:after{content:'';position:absolute;inset:6px;border:1.5px dashed var(--salon-acc);
  border-radius:12px;pointer-events:none;background:color-mix(in srgb,var(--salon-acc) 6%,transparent)}
.salon-panel{--salon-content-width:clamp(680px,calc(100% * .64),920px)}
.salon-gutter{position:absolute;top:44px;bottom:58px;z-index:3;cursor:col-resize;
  width:min(10px,calc((100% - var(--salon-content-width)) / 2 - 24px - 24px))}
.salon-gutter-l{right:calc(50% + var(--salon-content-width) / 2 + 24px)}
.salon-gutter-r{left:calc(50% + var(--salon-content-width) / 2 + 24px)}
.salon-gutter:after{content:'';position:absolute;top:0;bottom:0;width:2px;border-radius:2px;
  pointer-events:none;opacity:0;transition:opacity .12s;
  background:linear-gradient(to bottom,
    transparent calc(var(--salon-handle-pointer-y,50%) - 36px),
    var(--dsw-alias-scrollbar-bg-l1,rgba(127,127,127,.55)) calc(var(--salon-handle-pointer-y,50%) - 8px),
    var(--dsw-alias-scrollbar-bg-l1,rgba(127,127,127,.55)) calc(var(--salon-handle-pointer-y,50%) + 8px),
    transparent calc(var(--salon-handle-pointer-y,50%) + 36px))}
.salon-gutter-l:after{right:4px}
.salon-gutter-r:after{left:4px}
.salon-gutter[data-dragging]:after{opacity:1}
.salon-gutter:hover:after{opacity:1}
.salon-panel.dragging{user-select:none;-webkit-user-select:none}
.salon-panel.dragging,.salon-panel.dragging *{cursor:col-resize!important}
.salon-head{display:flex;align-items:center;gap:8px;padding:9px 8px 7px;border-bottom:1px solid var(--salon-line)}
.salon-head-text{min-width:0}
.salon-title{font-weight:600;font-size:var(--dsh-content-font-size,14px);line-height:20px}
.salon-meta{color:var(--salon-muted);font-size:12px;line-height:16px;margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.salon-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.salon-chip{font:inherit;font-size:11.5px;line-height:18px;padding:1px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--salon-line);background:transparent;color:var(--salon-muted);max-width:12em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.salon-chip:hover{border-color:var(--salon-line-2);color:var(--salon-text)}
.salon-chip.on{border-color:color-mix(in srgb,var(--salon-acc) 55%,transparent);color:var(--salon-acc);
  background:color-mix(in srgb,var(--salon-acc) 12%,transparent)}
.salon-chip:disabled{opacity:.4;cursor:default}
.salon-tos{font-size:11px;color:var(--salon-muted);margin-top:3px}
.salon-grow{flex:1}
.salon-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;
  color:var(--salon-muted);cursor:pointer}
.salon-icon-btn:hover{color:var(--salon-text);background:var(--dsw-alias-interactive-bg-hover,var(--salon-soft))}
.salon-list{flex:1;min-height:0;overflow-y:auto;padding:16px 8px 10px}
.salon-flow{width:100%;max-width:var(--salon-content-width,748px);margin:0 auto;display:flex;
  flex-direction:column;gap:var(--dsh-chat-flow-gap,12px)}
.salon-row{display:flex;gap:8px;align-items:flex-start;max-width:100%}
.salon-row.mine{justify-content:flex-end}
.salon-avatar{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;
  color:#fff;font-weight:600;user-select:none;margin-top:1px}
.salon-body{min-width:0;max-width:min(calc(var(--salon-content-width,748px) * .702),86%)}
.salon-row.mine .salon-body{display:flex;flex-direction:column;align-items:flex-end;max-width:82%}
.salon-who{display:flex;align-items:baseline;gap:6px;margin-bottom:4px}
.salon-name{font-size:var(--dsh-content-font-size-secondary,13px);font-weight:600;color:var(--salon-text)}
.salon-time{font-size:12px;color:var(--salon-muted);font-variant-numeric:tabular-nums}
.salon-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}
.salon-bubble{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 16px;border-radius:var(--dsw-radius-xl,20px);
  background:var(--dsw-specific-bubble,var(--salon-soft));border:0;color:var(--dsw-alias-label-primary,inherit);
  font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}
.salon-at{color:var(--salon-acc);font-weight:600}
.salon-para{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.salon-para + .salon-para{margin-top:6px}
.salon-h{margin:6px 0 2px;font-weight:600;font-size:var(--dsh-content-font-size,14px);line-height:22px}
.salon-quote{margin:4px 0;padding-left:10px;border-left:2px solid var(--salon-line-2);color:var(--salon-muted)}
.salon-ul,.salon-ol{margin:4px 0;padding-left:20px}
.salon-ul li,.salon-ol li{margin:2px 0}
.salon-code{font-family:var(--dsw-font-markdown-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:.92em;padding:1px 5px;border-radius:6px;background:var(--salon-soft);border:1px solid var(--salon-line)}
.salon-pre{position:relative;margin:6px 0;padding:12px 14px;overflow:auto;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-bg-layer-2,var(--salon-soft));border:0.5px solid var(--dsw-alias-border-l2,var(--salon-line-2))}
.salon-pre code{font-family:var(--dsw-font-markdown-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12.5px;line-height:1.6;white-space:pre;background:none;border:0;padding:0}
.salon-lang{position:absolute;top:4px;right:8px;font-size:11px;color:var(--salon-muted);text-transform:lowercase}
.salon-md-link{color:var(--dsw-alias-brand-primary,var(--salon-acc));text-decoration:none}
.salon-md-link:hover{text-decoration:underline}
.salon-md-shot{display:block;margin:6px 0;border-radius:var(--dsw-radius-md,12px);overflow:hidden;line-height:0;
  border:0.5px solid var(--dsw-alias-border-l2,var(--salon-line-2));max-width:100%}
.salon-md-shot img{max-width:100%;max-height:320px;object-fit:contain;display:block}
.salon-md-raw{color:var(--salon-muted);font-size:.92em;word-break:break-all}
.salon-text strong,.salon-bubble strong{font-weight:600}
.salon-at-off{color:var(--salon-muted);font-weight:500}
.salon-files{display:flex;flex-direction:column;gap:6px;margin-top:6px;max-width:100%}
.salon-files.mine{align-items:flex-end}
.salon-shots{display:flex;flex-wrap:wrap;gap:6px}
.salon-shot{display:block;border-radius:10px;overflow:hidden;border:1px solid var(--salon-line-2);line-height:0}
.salon-shot img{max-width:200px;max-height:200px;object-fit:cover;display:block}
.salon-filers{display:flex;flex-wrap:wrap;gap:6px}
.salon-file{display:inline-flex;align-items:center;gap:10px;max-width:240px;min-height:64px;box-sizing:border-box;
  padding:8px 12px;border-radius:var(--dsw-radius-lg,16px);border:0.5px solid var(--dsw-alias-border-l2,var(--salon-line));
  background:var(--dsw-specific-input-major,transparent);color:inherit;text-decoration:none;font-size:14px}
.salon-file:hover{border-color:var(--salon-line-2)}
.salon-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:22px}
.salon-file-size{color:var(--salon-muted);font-size:12px;line-height:15px;flex:0 0 auto}
.salon-empty{color:var(--salon-muted);text-align:center;padding:28px 10px;line-height:calc(20px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size-secondary,13px)}
.salon-system{align-self:center;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--salon-muted);text-align:center;padding:2px 0;max-width:90%}
.salon-foot{padding:7px 8px 10px;border-top:1px solid var(--salon-line)}
.salon-foot>*{width:100%;max-width:calc(var(--salon-content-width,748px) + 32px);margin-left:auto;margin-right:auto;box-sizing:border-box}
.salon-to{display:flex;align-items:center;gap:8px;padding:2px 0 6px;flex-wrap:wrap}
.salon-to-label{font-size:11px;color:var(--salon-muted)}
.salon-to-select{font:inherit;font-size:11.5px;padding:2px 6px;border-radius:7px;border:1px solid var(--salon-line);
  background:transparent;color:inherit;outline:none;max-width:15em}
.salon-to-select:focus{border-color:var(--salon-acc)}
.salon-attaches{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 7px}
.salon-attach{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 0;border-radius:8px;
  background:var(--salon-soft);border:1px solid var(--salon-line)}
.salon-attach.muted{color:var(--salon-muted);font-size:11px;padding:3px 8px}
.salon-x{border:0;background:transparent;color:var(--salon-muted);cursor:pointer;font-size:13px;line-height:1;padding:0 5px 0 1px}
.salon-x:hover{color:var(--salon-text)}
.salon-composer{border:0.5px solid var(--dsw-alias-border-l2,var(--salon-line-2));border-radius:var(--dsw-radius-panel,28px);box-sizing:border-box;
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,var(--salon-soft)));
  box-shadow:var(--dsw-elevation-soft,none);padding:8px 12px 6px}
.salon-composer:focus-within{border-color:var(--dsw-alias-border-l3,var(--salon-acc))}
.salon-input{width:100%;box-sizing:border-box;resize:none;border:0;background:transparent;color:inherit;
  font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));
  outline:none;padding:4px 6px 0 2px;max-height:150px;overflow-y:auto}
.salon-input::placeholder{color:var(--salon-muted)}
.salon-composer-foot{display:flex;align-items:center;gap:6px;min-height:26px;margin-top:2px}
.salon-note{flex:1;min-width:0;font-size:11px;color:var(--salon-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.salon-send{border:0;border-radius:999px;background:var(--dsw-alias-button-primary-fill,var(--salon-acc));
  color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:13px;line-height:20px;
  padding:6px 16px;cursor:pointer}
.salon-send:disabled{opacity:.32;cursor:default}
.salon-mask{position:fixed;inset:0;background:rgba(0,0,0,.34);display:flex;align-items:center;justify-content:center;z-index:60}
.salon-sheet{width:min(440px,92vw);max-height:84vh;overflow-y:auto;border-radius:14px;padding:16px;
  background:var(--dsw-alias-bg-base,Canvas);color:var(--salon-text);border:1px solid var(--salon-line-2);
  box-shadow:0 18px 48px rgba(0,0,0,.34);font-family:var(--dsw-font-family,inherit)}
.salon-sheet-head{font-size:14px;font-weight:600}
.salon-sheet-sub{font-size:11px;color:var(--salon-muted);margin:3px 0 12px;line-height:1.6;word-break:break-all}
.salon-field{border:1px solid var(--salon-line);border-radius:10px;padding:9px 10px;margin-bottom:10px}
.salon-invite{border-color:color-mix(in srgb,var(--salon-acc) 42%,transparent);
  background:color-mix(in srgb,var(--salon-acc) 5%,transparent)}
.salon-invite-line{display:flex;gap:8px;align-items:center}
.salon-invite-line .salon-input-line{flex:1}
.salon-field-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.salon-field-name{font-weight:600;font-size:12.5px}
.salon-tag{font-size:10px;padding:1px 6px;border-radius:20px;border:1px solid var(--salon-line);color:var(--salon-muted)}
.salon-tag.on{border-color:color-mix(in srgb,var(--salon-acc) 50%,transparent);color:var(--salon-acc)}
.salon-tag.warn{border-color:var(--dsw-alias-state-warn-primary,#e8b45a);color:var(--dsw-alias-state-warn-primary,#e8b45a)}
.salon-mini{font:inherit;font-size:10.5px;border:1px solid var(--salon-line);background:transparent;color:var(--salon-muted);
  border-radius:6px;padding:1px 7px;cursor:pointer}
.salon-mini:hover{color:var(--salon-text);border-color:var(--salon-line-2)}
.salon-mini.danger{border-color:var(--dsw-alias-state-error-primary,#e26e50);color:var(--dsw-alias-state-error-primary,#e26e50);opacity:1}
.salon-input-line{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:inherit;background:var(--salon-soft);
  border:1px solid var(--salon-line);border-radius:7px;padding:5px 8px;outline:none}
.salon-input-line:focus{border-color:var(--salon-acc)}
.salon-hintline{font-size:10.5px;color:var(--salon-muted);line-height:1.6;margin:2px 0 8px;word-break:break-all}
.salon-hintline.warn{color:var(--dsw-alias-state-warn-primary,#e8b45a)}
.salon-sheet-foot{display:flex;justify-content:flex-end;gap:8px}
.salon-btn{font:inherit;font-size:12px;padding:5px 14px;border-radius:8px;border:1px solid var(--salon-line);
  background:transparent;color:inherit;cursor:pointer}
.salon-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--salon-acc));border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.salon-btn:disabled{opacity:.45;cursor:default}
`;

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-salon');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-salon: styles');

      // 'main' 是往里注册的槽，不是能 inject 的槽；所以等 sidebar.panellist 到手时一起挂。
      // 照 dsh-im-connect 的写法（lib/client.js:6360、6511）。
      ctx.slots.inject('sidebar.panellist', () => {
        const panel = ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel));
        const row = ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 4,
          label: () => ROOM_TITLE || TEXT.nav,
        }, () => h(Icon));
        return () => {
          if (typeof row === 'function') row();
          if (typeof panel === 'function') panel();
        };
      });
    }

    exports.name = 'dsh-salon';
    // TEXT 全是写死的中文，用不上 locale——注入它只是名义上的。
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
