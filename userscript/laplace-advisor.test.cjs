const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'laplace-advisor.user.js'), 'utf8');

function client(app, { isolated = false, root = null, manualHTTP = false } = {}) {
  const requests = [];
  const timers = [];
  const pageTimers = [];
  const listeners = new Map();
  const timeouts = new Map();
  let nextTimeout = 0;
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return root && id === 'room-' + app.curRoom.id ? root : null; },
    createElement() {
      return { nodeType: 1, children: [], setAttribute() {}, remove() {},
        append(child) { this.children.push(child); } };
    },
    createTextNode(text) { return { nodeType: 3, text }; },
    documentElement: { append(script) { vm.runInContext(script.textContent, page); } },
  };
  const page = vm.createContext({
    window: { app }, document, CustomEvent, console,
    setInterval(fn) { pageTimers.push(fn); },
  });
  const context = vm.createContext({
    ...(isolated ? { window: {} } : { unsafeWindow: { app } }), console,
    setInterval(fn) { timers.push(fn); return fn; },
    clearInterval(fn) { const at = timers.indexOf(fn); if (at >= 0) timers.splice(at, 1); },
    setTimeout(fn, ms) { timeouts.set(++nextTimeout, { fn, ms }); return nextTimeout; },
    clearTimeout(id) { timeouts.delete(id); }, document, CustomEvent,
    GM_xmlhttpRequest(options) {
      requests.push(options);
      if (!manualHTTP) options.onload({ responseText: JSON.stringify({ ok: true }) });
    },
  });
  // Expose the real implementation without starting the UI and infinite poll loop.
  const startup = source.indexOf("  document.addEventListener('keydown'");
  vm.runInContext(source.slice(0, startup) +
    'globalThis.api = { curRoom, hook, poll, resync, content, S, currentPick, pickBest, scheduleAuto, cancelAuto, enqueue, recoverRoom }; })();', context);
  return { api: context.api, requests, page, timeouts,
    tick() { for (const fn of [...timers, ...pageTimers]) fn(); } };
}

const battle = (id = 'battle-gen9randombattle-123') => ({
  id, battle: { stepQueue: ['|player|p1|Tester', '|turn|1'] },
  request: { active: [], rqid: 1 },
});

test('detects battles in either visible panel without selecting hidden rooms', () => {
  const left = battle();
  const right = battle('battle-gen9randombattle-456');
  const app = { curRoom: left, curSideRoom: right };
  const { api } = client(app);
  assert.equal(api.curRoom(), left);
  app.curRoom = { id: '' };
  assert.equal(api.curRoom(), right);
  app.curSideRoom = { id: 'lobby' };
  app.rooms = { [left.id]: left };
  assert.equal(api.curRoom(), null);
  assert.equal(client(undefined).api.curRoom(), null);
});

test('polls advice for a side-panel battle instead of pinging', async () => {
  const room = battle();
  const app = { curRoom: { id: '' }, curSideRoom: room };
  const { api, requests } = client(app);
  api.poll();
  await Promise.resolve();
  assert.equal(requests[0].url, 'http://127.0.0.1:8765/advice?room=' + room.id);
  app.curSideRoom = null;
  api.poll();
  await Promise.resolve();
  assert.equal(requests[1].url, 'http://127.0.0.1:8765/ping');
});

test('receive hook forwards protocol payload and username and preserves the client call', async () => {
  const calls = [];
  const app = { user: { get: () => 'Tester' }, receive(...args) {
    calls.push({ receiver: this, args });
    return 'received';
  } };
  const { api, requests } = client(app);
  assert.equal(api.hook(), true);
  assert.equal(api.hook(), true);
  const data = '>battle-gen9randombattle-123\n|init|battle\n|turn|1';
  assert.equal(app.receive(data, 'extra'), 'received');
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].data), {
    user: 'Tester', room: 'battle-gen9randombattle-123', data,
  });
  assert.equal(calls[0].receiver, app);
  assert.deepEqual(calls[0].args, [data, 'extra']);
  app.receive('>lobby\n|c|Tester|Hello');
  assert.equal(requests.length, 1);
});

test('resync sends the side-panel log and private request in order', async () => {
  const room = battle();
  const { api, requests } = client({
    curRoom: { id: '' }, curSideRoom: room, user: { get: () => 'Tester' },
  });
  await api.resync();
  assert.deepEqual(requests.map((r) => r.url.split('/').pop()), ['reset']);
  const payload = JSON.parse(requests[0].data);
  assert.equal(payload.room, room.id);
  assert.equal(payload.data, '>' + room.id + '\n|init|battle\n|player|p1|Tester\n|turn|1\n' +
    '|request|' + JSON.stringify(room.request));
});

test('unavailable page access is distinguished from an unopened battle', () => {
  const { api } = client(undefined);
  api.S.online = true;
  assert.match(api.content()[0].children[0].text, /access to the Showdown client/);
  api.S.hooked = true;
  assert.match(api.content()[0].children[0].text, /Open a battle/);
});

test('both installable copies stay identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'laplace-advisor.user.js'), 'utf8'), source);
});

test('isolated manager bridges page state, advice polling and protocol without exposing GM', async () => {
  const room = battle();
  const calls = [];
  const app = { curRoom: { id: '' }, curSideRoom: room, user: { get: () => 'Tester' },
    receive(...args) { calls.push({ receiver: this, args }); return 'received'; } };
  const { api, requests, tick, page } = client(app, { isolated: true });
  assert.equal(api.curRoom(), null);
  for (let i = 0; i < 12; i++) tick();
  assert.equal(api.S.hooked, true);
  assert.equal(api.curRoom().id, room.id);
  assert.equal(vm.runInContext('typeof GM_xmlhttpRequest', page), 'undefined');
  api.poll();
  await Promise.resolve();
  assert.equal(requests[0].url, 'http://127.0.0.1:8765/advice?room=' + room.id);
  const data = '>' + room.id + '\n|request|{}\n|turn|2';
  assert.equal(app.receive(data, 'extra'), 'received');
  await Promise.resolve();
  assert.deepEqual(JSON.parse(requests[1].data), { user: 'Tester', room: room.id, data });
  assert.equal(calls[0].receiver, app);
  assert.deepEqual(calls[0].args, [data, 'extra']);
  app.curSideRoom = null;
  tick();
  assert.equal(api.curRoom(), null);
});

test('isolated manager resync reads full log and private request only on demand', async () => {
  const room = battle();
  const { api, requests, tick } = client({
    curRoom: room, user: { get: () => 'Tester' }, receive() {},
  }, { isolated: true });
  for (let i = 0; i < 12; i++) tick();
  assert.equal(api.curRoom().request.rqid, room.request.rqid);
  assert.equal(api.curRoom().battle.stepQueue, undefined);
  await api.resync();
  await Promise.resolve();
  assert.deepEqual(requests.map((r) => r.url.split('/').pop()), ['reset']);
  assert.equal(JSON.parse(requests[0].data).data,
    '>' + room.id + '\n|init|battle\n|player|p1|Tester\n|turn|1\n|request|' +
    JSON.stringify(room.request));
});

test('page bridge waits for a late client and does not duplicate receive hooks', async () => {
  const { api, requests, tick, page } = client(undefined, { isolated: true });
  for (let i = 0; i < 20; i++) tick();
  assert.equal(api.S.hooked, false);
  page.window.app = { curRoom: battle(), user: { get: () => 'Tester' }, receive() {} };
  for (let i = 0; i < 20; i++) tick();
  assert.equal(api.S.hooked, true);
  page.window.app.receive('>battle-gen9randombattle-123\n|turn|2');
  await Promise.resolve();
  assert.equal(requests.length, 1);
});

function playable({ isolated = false, aaa = false } = {}) {
  const room = battle(aaa ? 'battle-gen9almostanyability-123' : undefined);
  Object.assign(room.battle, { turn: 1, gameType: 'singles' });
  room.choice = { waiting: false, choices: [] };
  room.request.active = [{ canTerastallize: aaa ? undefined : 'Electric' }];
  const clicked = [];
  const move = { click() { clicked.push('move'); }, disabled: false };
  const swap = { click() { clicked.push('switch'); }, disabled: false };
  const tera = { checked: false, click() { this.checked = !this.checked; } };
  const root = { querySelector(selector) {
    if (selector === 'button[name="chooseMove"][value="1"]') return move;
    if (selector === 'button[name="chooseSwitch"][value="1"]') return swap;
    if (selector === 'input[name="terastallize"]') return tera;
    return null;
  } };
  const app = { curRoom: room, user: { get: () => 'Tester' }, receive() {} };
  const c = client(app, { isolated, root });
  if (isolated) for (let i = 0; i < 12; i++) c.tick();
  Object.assign(c.api.S, { online: true, adviceRoom: room.id, advice: {
    kind: 'move', turn: 1, rqid: 1, seq: 10, force_switch: false,
    action: { type: 'move', slot: 1, tera: false },
  } });
  return { ...c, room, clicked, move, swap, tera, root };
}

for (const isolated of [false, true]) {
  test(`pick submits only once per request (isolated=${isolated})`, () => {
    const { api, clicked } = playable({ isolated });
    assert.equal(api.pickBest(), true);
    assert.equal(api.pickBest(), false);
    assert.deepEqual(clicked, ['move']);
  });
  test(`a changed request blocks old advice before the next poll (isolated=${isolated})`, () => {
    const { api, room, clicked } = playable({ isolated });
    room.request.rqid = 2;
    assert.equal(api.pickBest(), false);
    assert.deepEqual(clicked, []);
  });
}

test('Auto delays once, rechecks state, and cancels when disabled', () => {
  const { api, timeouts, clicked } = playable();
  assert.equal(api.S.auto, false);
  api.S.auto = true;
  api.scheduleAuto();
  api.scheduleAuto();
  assert.equal(timeouts.size, 1);
  const timer = [...timeouts.values()][0];
  assert.ok(timer.ms >= 0 && timer.ms < 3000);
  api.S.auto = false;
  api.scheduleAuto();
  assert.equal(timeouts.size, 0);
  timer.fn(); // Even an already-queued callback must not submit after Auto is off.
  assert.deepEqual(clicked, []);
  api.S.auto = true;
  api.scheduleAuto();
  [...timeouts.values()][0].fn();
  assert.deepEqual(clicked, ['move']);
});

test('Auto rejects a stale timer after room, request, advice or connection changes', () => {
  for (const change of [
    (c) => { c.room.request.rqid++; },
    (c) => { c.api.S.advice.seq++; },
    (c) => { c.api.S.adviceRoom = 'another-room'; },
    (c) => { c.api.S.online = false; },
    (c) => { c.room.choice.waiting = true; },
  ]) {
    const c = playable({ isolated: true });
    c.api.S.auto = true;
    c.api.scheduleAuto();
    const timer = [...c.timeouts.values()][0];
    change(c);
    timer.fn();
    assert.deepEqual(c.clicked, []);
  }
});

test('forced switch uses the new request and zero-based switch button', () => {
  const { api, room, clicked } = playable();
  api.pickBest();
  room.request.rqid = 2;
  room.request.forceSwitch = [true];
  Object.assign(api.S.advice, { kind: 'switch', rqid: 2, force_switch: true,
    action: { type: 'switch', slot: 2 } });
  assert.equal(api.pickBest(), true);
  assert.deepEqual(clicked, ['move', 'switch']);
});

test('picks obey Tera selection and reject Tera in AAA', () => {
  const c = playable();
  c.api.S.advice.action.tera = true;
  assert.equal(c.api.pickBest(), true);
  assert.equal(c.tera.checked, true);
  const plain = playable();
  plain.tera.checked = true;
  plain.api.pickBest();
  assert.equal(plain.tera.checked, false);
  const aaa = playable({ aaa: true });
  aaa.api.S.advice.action.tera = true;
  assert.equal(aaa.api.pickBest(), false);
  assert.deepEqual(aaa.clicked, []);
});

test('stale, waiting, disabled, spectator and doubles states cannot submit', () => {
  for (const change of [
    (c) => { c.api.S.advice.turn = 0; },
    (c) => { c.room.request.wait = true; },
    (c) => { c.room.choice = null; },
    (c) => { c.room.battle.ended = true; },
    (c) => { c.room.battle.gameType = 'doubles'; },
    (c) => { c.move.disabled = true; },
    (c) => { c.api.S.thinking = true; },
    (c) => { delete c.api.S.advice.rqid; },
  ]) {
    const c = playable();
    change(c);
    assert.equal(c.api.pickBest(), false);
    assert.deepEqual(c.clicked, []);
  }
});

test('team preview selects the advised slots in order as controls are rebuilt', () => {
  const c = playable();
  c.room.request.teamPreview = true;
  Object.assign(c.api.S.advice, { kind: 'lead', team_order: [3, 1, 2] });
  const selected = [];
  c.root.querySelector = () => ({});
  c.root.querySelectorAll = () => [1, 2, 3].filter((i) => !selected.includes(i)).map((i) => ({
    getAttribute: () => 'switchpokemon|' + (i - 1), click() { selected.push(i); },
  }));
  assert.equal(c.api.pickBest(), true);
  assert.deepEqual(selected, [3, 1, 2]);
});

test('reset is serialized after an in-flight feed and before new live data', async () => {
  const room = battle();
  const { api, requests } = client({ curRoom: room, user: { get: () => 'Tester' } }, { manualHTTP: true });
  api.enqueue(room.id, 'in flight');
  api.enqueue('battle-gen9randombattle-456', 'other room');
  api.enqueue(room.id, 'superseded');
  await api.resync();
  api.enqueue(room.id, 'new live data');
  assert.equal(requests.length, 1);
  for (let i = 0; i < 4; i++) {
    requests[i].onload({ responseText: '{"ok":true}' });
    await Promise.resolve();
  }
  assert.deepEqual(requests.map((r) => r.url.split('/').pop()), ['feed', 'feed', 'reset', 'feed']);
  assert.equal(JSON.parse(requests[1].data).data, 'other room');
  assert.match(JSON.parse(requests[2].data).data, /\|init\|battle/);
  assert.equal(JSON.parse(requests[3].data).data, 'new live data');
});

test('snapshot sends only the current request after all history, and none after a win', async () => {
  const room = battle();
  room.battle.stepQueue.push('|request|{"rqid":0}', '|turn|2', '|message|tail');
  const { api, requests } = client({ curRoom: room, user: { get: () => 'Tester' } });
  await api.resync();
  const payload = JSON.parse(requests[0].data).data;
  assert.equal(payload.match(/\|request\|/g).length, 1);
  assert.ok(payload.endsWith('|request|' + JSON.stringify(room.request)));
  room.battle.stepQueue.push('|win|Tester');
  await api.resync();
  assert.ok(!JSON.parse(requests[1].data).data.includes('|request|'));
});

test('lost server state recovers once per request and again after server restart', async () => {
  const room = battle();
  const { api, requests } = client({ curRoom: room, user: { get: () => 'Tester' } });
  const response = { needs_sync: true, instance: 'first' };
  api.recoverRoom(room, response);
  await Promise.resolve();
  api.recoverRoom(room, response);
  assert.equal(requests.length, 1);
  api.recoverRoom(room, { ...response, instance: 'restarted' });
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.url.endsWith('/reset')));
});

for (const isolated of [false, true]) {
  test(`capture recovers when Showdown replaces its receiver (isolated=${isolated})`, async () => {
    const app = { curRoom: battle(), user: { get: () => 'Tester' }, receive() {} };
    const { tick, requests } = client(app, { isolated });
    for (let i = 0; i < 12; i++) tick();
    app.receive = () => 'replacement';
    tick();
    const result = app.receive('>battle-gen9randombattle-123\n|turn|2');
    await Promise.resolve();
    assert.equal(result, 'replacement');
    assert.equal(requests.length, 1);
  });
}
