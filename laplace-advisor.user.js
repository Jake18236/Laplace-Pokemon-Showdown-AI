// ==UserScript==
// @name         Laplace Advisor
// @namespace    https://github.com/Jake18236/Laplace-Pokemon-Showdown-AI
// @version      1.1.2
// @description  Live move suggestions from a local Laplace search server
// @match        https://play.pokemonshowdown.com/*
// @match        https://*.psim.us/*
// @match        http://localhost:8000/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DEFAULT_SERVER = 'http://127.0.0.1:8765';
  let SERVER = DEFAULT_SERVER;
  const POLL_MS = 700;
  const S = {
    online: false, hooked: false, format: null, thinking: false,
    advice: null, note: null,
    collapsed: false,
    pos: null,
    auto: false, adviceRoom: null,
  };
  const queue = [];
  let sending = false;
  let bridgeState = null;
  let bridgeStarted = false;
  let hookedApp = null, hookedReceive = null;
  const recovered = new Set();
  const bridgeID = 'laplace-' + Math.random().toString(36).slice(2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getValue(key, fallback) {
    if (typeof GM_getValue === 'function') {
      const value = GM_getValue(key, fallback);
      return value === undefined ? fallback : value;
    }
    if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
      const value = await GM.getValue(key, fallback);
      return value === undefined ? fallback : value;
    }
    try {
      const value = localStorage.getItem('laplace:' + key);
      return value === null ? fallback : JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        const result = GM_setValue(key, value);
        if (result && typeof result.catch === 'function') result.catch(console.warn);
        return;
      }
      if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        GM.setValue(key, value).catch(console.warn);
        return;
      }
      localStorage.setItem('laplace:' + key, JSON.stringify(value));
    } catch (e) {
      console.warn('[laplace] Could not save preference:', e);
    }
  }

  // --- transport ---------------------------------------------------------------------
  // GM_xmlhttpRequest, not fetch: the page is https and the server is http://127.0.0.1,
  // and the page's CSP would block a plain fetch anyway.
  function http(method, path, body) {
    return new Promise((resolve, reject) => {
      const request = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
          ? GM.xmlHttpRequest.bind(GM) : null);
      if (!request) {
        reject(new Error('This userscript manager does not provide GM.xmlHttpRequest.'));
        return;
      }
      request({
        method, url: SERVER + path, timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'X-Laplace': '1' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => { try {
          const value = JSON.parse(r.responseText);
          if (r.status >= 400 || value.ok === false) throw new Error(value.error || 'Advisor request failed');
          resolve(value);
        } catch (e) { reject(e); } },
        onerror: reject, ontimeout: reject,
      });
    });
  }

  const username = () => {
    if (bridgeState) return bridgeState.user;
    try { return W.app.user.get('name') || ''; } catch (e) { return ''; }
  };
  const curRoom = () => {
    if (bridgeState) return bridgeState.room;
    try {
      const app = W.app;
      if (!app) return null;
      // Showdown can display a battle in either panel. In a split layout,
      // curRoom may be the home screen while curSideRoom holds the battle.
      return [app.curRoom, app.curSideRoom].find(
        (r) => r && typeof r.id === 'string' && r.id.startsWith('battle-')
      ) || null;
    }
    catch (e) { return null; }
  };

  // In-order delivery: payloads must reach the server in the order the client got them.
  function enqueue(room, data, path = '/feed') { queue.push({ room, data, path }); flush(); }
  async function flush() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const item = queue[0];
      try {
        await http('POST', item.path, { user: username(), room: item.room, data: item.data });
        if (queue[0] === item) queue.shift();     // resync may have emptied the queue meanwhile
      } catch (e) {
        if (queue.length > 400) queue.splice(0, queue.length - 400);
        await sleep(1500);
      }
    }
    sending = false;
  }

  // --- capture -----------------------------------------------------------------------
  // The client hands every server message to app.receive(); room traffic starts ">room\n".
  function capture(data) {
    if (typeof data !== 'string' || data.charAt(0) !== '>') return;
    const nl = data.indexOf('\n');
    if (nl < 0) return;
    const room = data.slice(1, nl);
    if (room.startsWith('battle-')) enqueue(room, data);
  }

  function hook() {
    if (bridgeStarted) return S.hooked;
    try {
      const app = W.app;
      if (!app || typeof app.receive !== 'function') return false;
      if (app === hookedApp && app.receive === hookedReceive) return true;
      const orig = app.receive;
      app.receive = function (data) {
        try { capture(data); } catch (e) { console.warn('[laplace]', e); }
        return orig.apply(this, arguments);
      };
      hookedApp = app; hookedReceive = app.receive;
      return true;
    } catch (e) { return false; }
  }

  // Managers such as Safari Userscripts provide GM APIs only in an isolated
  // content world, without unsafeWindow. Run just the Showdown adapter in the
  // page world; send JSON over DOM events and keep HTTP/storage in this script.
  // This function must be self-contained: its source is injected into the page.
  function pageBridge(channel) {
    let hookedApp = null;
    let hookedReceive = null;
    let previousState = '';
    const emit = (value) => document.dispatchEvent(new CustomEvent(channel, {
      detail: JSON.stringify(value),
    }));
    const room = () => {
      const app = window.app;
      return app && [app.curRoom, app.curSideRoom].find(
        (r) => r && typeof r.id === 'string' && r.id.startsWith('battle-')
      ) || null;
    };
    const user = () => {
      try { return window.app.user.get('name') || ''; } catch (e) { return ''; }
    };
    function update() {
      const app = window.app;
      if (!app || typeof app.receive !== 'function') return;
      if (hookedApp !== app || hookedReceive !== app.receive) {
        const original = app.receive;
        app.receive = function (data) {
          try {
            if (typeof data === 'string' && data.startsWith('>battle-')) {
              emit({ type: 'feed', user: user(), data });
            }
          } catch (e) { console.warn('[laplace bridge]', e); }
          return original.apply(this, arguments);
        };
        hookedApp = app;
        hookedReceive = app.receive;
      }
      const r = room();
      const state = { type: 'state', user: user(), room: r ? {
        id: r.id, battle: r.battle ? { turn: r.battle.turn, ended: r.battle.ended,
          gameType: r.battle.gameType } : null,
        request: r.request, choice: r.choice ? { waiting: r.choice.waiting,
          choices: r.choice.choices, done: r.choice.done } : null,
      } : null };
      const serialized = JSON.stringify(state);
      if (serialized !== previousState) {
        previousState = serialized;
        emit(state);
      }
    }
    document.addEventListener(channel + '-resync', () => {
      const r = room();
      if (!r || !r.battle) return;
      emit({ type: 'resync', user: user(), room: {
        id: r.id, battle: { stepQueue: r.battle.stepQueue || [] }, request: r.request,
      } });
    });
    document.addEventListener(channel + '-refresh', update);
    update();
    setInterval(update, 250);
  }

  function startBridge() {
    if (bridgeStarted || !document.documentElement) return;
    bridgeStarted = true;
    document.addEventListener(bridgeID, (event) => {
      try {
        const value = JSON.parse(event.detail);
        if (!value || typeof value.user !== 'string') return;
        if (value.type === 'state') {
          if (value.room && (typeof value.room.id !== 'string' || !value.room.id.startsWith('battle-'))) return;
          bridgeState = { user: value.user, room: value.room };
          S.hooked = true;
        } else if (value.type === 'feed') {
          if (bridgeState) bridgeState.user = value.user;
          capture(value.data);
        } else if (value.type === 'resync' && bridgeState && value.room &&
                   typeof value.room.id === 'string' && value.room.id.startsWith('battle-') &&
                   Array.isArray(value.room.battle && value.room.battle.stepQueue)) {
          bridgeState.user = value.user;
          replayRoom(value.room);
        }
      } catch (e) { console.warn('[laplace bridge]', e); }
    });
    const script = document.createElement('script');
    script.textContent = '(' + pageBridge.toString() + ')(' + JSON.stringify(bridgeID) + ');';
    document.documentElement.append(script);
    script.remove();
  }

  let hookAttempts = 0;
  const hooker = setInterval(() => {
    if (hook()) { S.hooked = true; }
    else if (++hookAttempts >= 10) startBridge();
  }, 100);

  // Mid-battle start (page reload, script installed late): rebuild the payload from the
  // client's own log. poke-env 0.15 chooses on |request|, so the current request
  // must follow ALL history, including the latest turn and team-preview marker.
  async function resync() {
    if (bridgeState) {
      document.dispatchEvent(new CustomEvent(bridgeID + '-resync'));
      return;
    }
    const room = curRoom();
    await replayRoom(room);
  }

  async function replayRoom(room) {
    if (!room || !room.battle) return;
    const history = (room.battle.stepQueue || []).filter((line) =>
      !line.startsWith('|request|') && !line.startsWith('|init|'));
    const lines = ['|init|battle', ...history];
    if (room.request && !history.some((line) => /^\|(win|tie)\|/.test(line))) {
      lines.push('|request|' + JSON.stringify(room.request));
    }
    cancelAuto();
    S.advice = null; S.note = null;
    // Replace only this room's pending history. Keep the current HTTP operation
    // in order; reset + snapshot travel as one queued operation before live feeds.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].room === room.id) queue.splice(i, 1);
    }
    enqueue(room.id, '>' + room.id + '\n' + lines.join('\n'), '/reset');
  }

  // --- polling -----------------------------------------------------------------------
  async function poll() {
    for (;;) {
      try {
        const room = curRoom();
        const r = room
          ? await http('GET', '/advice?room=' + encodeURIComponent(room.id))
          : await http('GET', '/ping');
        S.online = true; S.format = r.format;
        S.thinking = !!r.thinking; S.advice = room ? r.advice : null; S.note = room ? r.status : null;
        S.adviceRoom = room ? room.id : null;
        recoverRoom(room, r);
      } catch (e) { S.online = false; }
      // An unexpected UI error must not permanently terminate the polling loop.
      try { render(); hint(); scheduleAuto(); }
      catch (e) { cancelAuto(); console.warn('[laplace UI]', e); }
      await sleep(POLL_MS);
    }
  }

  function recoverRoom(room, response) {
    if (!room || !room.request || !response.needs_sync || response.thinking ||
        (response.status && response.status.ignored)) return;
    const key = response.instance + ':' + room.id + ':' + room.request.rqid;
    if (recovered.has(key)) return;
    recovered.add(key);
    // Once per request/server instance: recover missed init or a server restart,
    // without endlessly resending malformed state on every poll.
    resync();
  }

  // --- UI ----------------------------------------------------------------------------
  const CSS = `
  #lp-panel{position:fixed;z-index:99999;top:70px;right:12px;width:330px;font:13px/1.35 system-ui,sans-serif;
    color:#e8eaf0;background:rgba(18,20,28,.94);border:1px solid #384056;border-radius:10px;
    box-shadow:0 6px 24px rgba(0,0,0,.45);user-select:none}
  #lp-panel.collapsed .lp-body{display:none}
  .lp-head{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:move;border-bottom:1px solid #2a3144}
  #lp-panel.collapsed .lp-head{border-bottom:0}
  .lp-head button{background:#262d42;color:#cfd6ea;border:1px solid #384056;border-radius:5px;
    padding:0 7px;cursor:pointer;font-size:13px}
  .lp-head button:hover{background:#323b57}
  .lp-spacer{flex:1}
  .lp-fmt{font-size:11px;color:#8d97b3}
  .lp-dot{width:9px;height:9px;border-radius:50%;background:#666}
  .lp-dot.ok{background:#4cd964}.lp-dot.busy{background:#ffcc00}.lp-dot.off{background:#ff453a}
  .lp-body{padding:9px 11px 11px}
  .lp-best{font-size:19px;margin-bottom:2px}.lp-best.stale{opacity:.45}
  .lp-sub{color:#8d97b3;font-size:12px;margin:2px 0}
  .lp-chip{display:inline-block;margin-left:6px;padding:0 6px;border-radius:9px;font-size:11px;
    background:#3b2f6b;color:#d9ccff}.lp-chip.bad{background:#5a2330;color:#ffb3c0}
  .lp-win{position:relative;height:16px;margin:7px 0;border-radius:4px;background:#2a3144;overflow:hidden}
  .lp-win i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#c0392b,#e6b422,#2ecc71)}
  .lp-win span{position:relative;display:block;text-align:center;font-size:11px;line-height:16px;text-shadow:0 0 3px #000}
  .lp-row{display:grid;grid-template-columns:1fr 54px 34px 28px 34px;gap:5px;align-items:center;padding:2px 0}
  .lp-row.best .lp-name{font-weight:700}.lp-row.head{color:#8d97b3;font-size:11px}
  .lp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lp-bar{height:7px;background:#2a3144;border-radius:4px;overflow:hidden}
  .lp-bar i{display:block;height:100%;background:#5b8def}
  .lp-num{text-align:right;font-variant-numeric:tabular-nums}.dim{color:#8d97b3}
  .lp-msg.bad{color:#ff9aa8}.lp-msg.warn{color:#ffd479}.lp-msg.dim{color:#8d97b3}
  details{margin-top:6px;color:#aab3cc;font-size:12px}summary{cursor:pointer;user-select:none}
  .lp-hint{outline:3px solid #7cfc8a!important;box-shadow:0 0 12px #7cfc8a!important}`;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const msg = (text, cls) => h('div', { class: 'lp-msg ' + (cls || '') }, text);

  let panel, body, dot, fmtEl, pickButton, autoButton;

  function build() {
    if (panel) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
    dot = h('span', { class: 'lp-dot' });
    fmtEl = h('span', { class: 'lp-fmt' });
    body = h('div', { class: 'lp-body' });
    pickButton = h('button', { onclick: pickBest }, 'Pick best move');
    autoButton = h('button', { role: 'switch', 'aria-checked': 'false', onclick: () => {
      S.auto = !S.auto;
      cancelAuto(); render(); scheduleAuto();
    } }, 'Auto: off');
    const actions = h('div', { class: 'lp-head' }, pickButton, autoButton);
    const head = h('div', { class: 'lp-head' }, dot, h('b', {}, 'Laplace'), fmtEl,
      h('span', { class: 'lp-spacer' }),
      h('button', { title: 'Re-send this battle to the advisor', onclick: resync }, '⟳'),
      h('button', { title: 'Collapse (Alt+L)', onclick: toggle }, '–'));
    panel = h('div', { id: 'lp-panel' }, head, actions, body);
    document.documentElement.append(panel);
    if (S.pos) { panel.style.left = S.pos.x + 'px'; panel.style.top = S.pos.y + 'px'; panel.style.right = 'auto'; }
    drag(head);
    render();
  }

  function toggle() { S.collapsed = !S.collapsed; setValue('collapsed', S.collapsed); render(); }

  function drag(handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        panel.style.left = Math.max(0, ev.clientX - dx) + 'px';
        panel.style.top = Math.max(0, ev.clientY - dy) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        const b = panel.getBoundingClientRect(); S.pos = { x: b.left, y: b.top }; setValue('pos', S.pos);
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  const winbar = (e) => h('div', { class: 'lp-win' }, h('i', { style: `width:${Math.round(e * 100)}%` }),
    h('span', {}, `engine win estimate ${Math.round(e * 100)}%`));

  function content() {
    if (!S.online) return [msg('Advisor server not reachable.', 'bad'), msg('Start it with start-advisor.bat', 'dim')];
    if (!S.hooked) return [msg('Waiting for access to the Showdown client…', 'warn'),
      msg('If this persists, reload Showdown and check that your userscript manager allows page access.', 'dim')];
    const room = curRoom();
    if (!room) return [msg('Open a battle to get suggestions.', 'dim')];
    const out = [];
    if (S.note && S.note.error) out.push(msg(S.note.error, 'bad'));
    if (S.note && S.note.ignored) out.push(msg('Not analysing this room: ' + S.note.ignored, 'warn'));
    const a = S.advice;
    if (!a) {
      out.push(msg(S.thinking ? 'Searching…' : 'Waiting for your turn…', 'dim'));
      return out;
    }
    if (S.adviceRoom !== room.id || (room.request && a.rqid != null && a.rqid !== room.request.rqid) ||
        (a.kind !== 'lead' && room.battle && a.turn !== room.battle.turn)) {
      out.push(msg(S.thinking ? 'Searching…' : 'Waiting for current advice…', 'dim'));
      return out;
    }
    if (a.kind === 'error') { out.push(msg(a.message, 'bad')); return out; }
    if (a.rqid == null) out.push(msg('Restart the advisor server to enable move picking.', 'warn'));
    if (a.kind === 'lead') {
      out.push(h('div', { class: 'lp-best' }, 'Lead: ', h('b', {}, a.lead || '?')));
      out.push(h('div', { class: 'lp-sub' }, 'Order: ' + (a.order || []).join(' › ')));
      return out;
    }
    const bt = room.battle && room.battle.turn;
    const stale = bt != null && a.turn !== bt;
    out.push(h('div', { class: 'lp-best' + (stale ? ' stale' : '') }, h('b', {}, a.label.replace(' +TERA', '')),
      a.tera && h('span', { class: 'lp-chip' }, 'TERA')));
    out.push(h('div', { class: 'lp-sub' },
      `T${a.turn} · ${(a.ms / 1000).toFixed(1)}s · ${a.worlds} worlds` + (stale ? ' · previous turn' : '')
      + (S.thinking ? ' · searching…' : '')));
    if (a.eval != null) out.push(winbar(a.eval));
    out.push(h('div', { class: 'lp-row head' }, h('span', {}, 'candidate'), h('span', {}),
      h('span', { class: 'lp-num' }, 'share'), h('span', { class: 'lp-num' }, 'wld'), h('span', { class: 'lp-num' }, 'eval')));
    for (const c of a.candidates) {
      out.push(h('div', { class: 'lp-row' + (c.best ? ' best' : '') },
        h('span', { class: 'lp-name', title: c.label }, (c.best ? '▶ ' : '') + c.label,
          c.veto && h('span', { class: 'lp-chip bad' }, 'vetoed:' + c.veto)),
        h('span', { class: 'lp-bar' }, h('i', { style: `width:${Math.round(Math.min(c.share * 2, 1) * 100)}%` })),
        h('span', { class: 'lp-num' }, c.share.toFixed(2)),
        h('span', { class: 'lp-num dim' }, c.worlds + '/' + a.worlds_total),
        h('span', { class: 'lp-num dim' }, c.eval == null ? '–' : c.eval.toFixed(2))));
    }
    if (a.expects) out.push(h('div', { class: 'lp-sub' }, 'expects ', h('b', {}, a.expects.label),
      ` ${Math.round(a.expects.share * 100)}%`));
    if (a.stages && a.stages.length) {
      out.push(h('div', { class: 'lp-sub' }, a.stages.map((s) => `${s.name}: ${s.was} → ${s.now}`).join(' · ')));
    }
    const fmt = (xs) => (xs || []).map(([k, n]) => `${k} ×${n}`).join(', ') || '–';
    if (a.guesses) {
      out.push(h('details', {}, h('summary', {}, 'What the worlds guessed about their active'),
        h('div', {}, 'item: ' + fmt(a.guesses.item)), h('div', {}, 'ability: ' + fmt(a.guesses.ability)),
        a.guesses.tera && h('div', {}, 'tera: ' + fmt(a.guesses.tera))));
    }
    return out;
  }

  function render() {
    if (!panel) return;
    dot.className = 'lp-dot ' + (S.online ? (S.thinking ? 'busy' : 'ok') : 'off');
    fmtEl.textContent = S.format ? S.format.replace('gen9', '') : (S.hooked ? '' : 'hooking…');
    panel.classList.toggle('collapsed', S.collapsed);
    pickButton.disabled = !currentPick();
    autoButton.textContent = S.auto ? 'Auto: on' : 'Auto: off';
    autoButton.setAttribute('aria-checked', String(S.auto));
    if (!S.collapsed) body.replaceChildren(...content());
  }

  // Both manual and automatic picks use the game's own controls, scoped to this
  // room. The request id distinguishes forced switches within the same turn.
  const submitted = new Set();
  let autoTimer = null, autoKey = null;
  function currentPick() {
    // Refresh synchronously before acting: a request can change between polls.
    if (bridgeState) document.dispatchEvent(new CustomEvent(bridgeID + '-refresh'));
    const room = curRoom(), a = S.advice;
    if (!S.online || S.thinking || !room || room.id !== S.adviceRoom || !a ||
        !room.battle || room.battle.ended || room.battle.gameType !== 'singles' ||
        !room.request || room.request.wait || !room.choice || room.choice.waiting ||
        (room.choice.choices || []).length || room.choice.done > 0 ||
        a.rqid == null || a.rqid !== room.request.rqid ||
        (a.kind !== 'lead' && a.turn !== room.battle.turn) ||
        (S.note && (S.note.error || S.note.ignored))) return null;
    const key = room.id + ':' + a.rqid;
    if (submitted.has(key)) return null;
    const root = document.getElementById('room-' + room.id);
    if (!root) return null;
    if (a.kind === 'lead') {
      if (!room.request.teamPreview || !Array.isArray(a.team_order) || !a.team_order.length ||
          a.team_order.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > 6) ||
          new Set(a.team_order).size !== a.team_order.length ||
          !root.querySelector('button[name="chooseTeamPreview"]')) return null;
      return { room, a, key, root };
    }
    const action = a.action;
    if (!action || !Number.isInteger(action.slot) || action.slot < 1) return null;
    const force = (room.request.forceSwitch || []).some(Boolean);
    if (force !== !!a.force_switch || (force && action.type !== 'switch')) return null;
    if (action.type !== 'move' && action.type !== 'switch') return null;
    if (action.tera && (room.id.startsWith('battle-gen9almostanyability-') ||
        !room.request.active?.[0]?.canTerastallize)) return null;
    const name = action.type === 'move' ? 'chooseMove' : 'chooseSwitch';
    const slot = action.type === 'move' ? action.slot : action.slot - 1;
    const button = root.querySelector(`button[name="${name}"][value="${slot}"]`);
    if (!button || button.disabled) return null;
    return { room, a, key, root, button };
  }

  function pickBest() {
    cancelAuto();
    const pick = currentPick();
    if (!pick) return false;
    const { a, key, root, button } = pick;
    if (a.kind === 'lead') {
      // Preview buttons are rebuilt after each pick; their value is the current
      // position, while data-tooltip identifies the original team slot.
      for (const slot of a.team_order) {
        const next = Array.from(root.querySelectorAll('button[name="chooseTeamPreview"]'))
          .find((b) => b.getAttribute('data-tooltip') === 'switchpokemon|' + (slot - 1));
        if (!next || next.disabled) break;
        submitted.add(key);
        next.click();
      }
    } else {
      const tera = root.querySelector('input[name="terastallize"]');
      if (a.action.tera && (!tera || tera.disabled)) return false;
      if (tera && tera.checked !== !!a.action.tera) tera.click();
      submitted.add(key);
      button.click();
    }
    render();
    return submitted.has(key);
  }

  function cancelAuto() {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null; autoKey = null;
  }

  function scheduleAuto() {
    const pick = S.auto ? currentPick() : null;
    const key = pick ? pick.key + ':' + pick.a.seq : null;
    if (key === autoKey) return;
    cancelAuto();
    if (!pick) return;
    autoKey = key;
    autoTimer = setTimeout(() => {
      autoTimer = null; autoKey = null;
      const fresh = S.auto ? currentPick() : null;
      if (fresh && fresh.key + ':' + fresh.a.seq === key) pickBest();
    }, Math.random() * 3000);
  }

  // Outline the suggested button in the game's own controls.
  function hint() {
    document.querySelectorAll('.lp-hint').forEach((e) => e.classList.remove('lp-hint'));
    const pick = currentPick();
    if (!S.collapsed && pick && pick.button) pick.button.classList.add('lp-hint');
  }

  document.addEventListener('keydown', (e) => { if (e.altKey && e.key.toLowerCase() === 'l') toggle(); });
  async function start() {
    SERVER = await getValue('server', DEFAULT_SERVER);
    S.collapsed = await getValue('collapsed', false);
    S.pos = await getValue('pos', null);
    build();
    poll();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
