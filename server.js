/* =====================================================================
   ЭНВЕЛЛ — игровой сервер
   Node.js + WebSocket. Вся игра считается здесь, клиенты только рисуют.
   Запуск:  npm install && npm start
   ===================================================================== */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT  = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

/* ---------- раздача страницы ---------- */
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p !== '/' && p !== '/index.html') { res.writeHead(404); return res.end('not found'); }
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html рядом с server.js не найден'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

/* =====================================================================
   Константы игры
   ===================================================================== */
const W = 600, H = 400;

const CLASSES = {
  art : {name:'Арт',  role:'воин',    color:'#ff7a5c', hp:140, spd:2.05, range:46,  atk:24, cd:32, kind:'melee', ab:'Рывок',   abcd:330},
  kira: {name:'Кира', role:'лучница', color:'#4fc3ff', hp:90,  spd:2.25, range:210, atk:15, cd:26, kind:'shot',  ab:'Залп',    abcd:390},
  vik : {name:'Вик',  role:'страж',   color:'#c08bff', hp:195, spd:1.70, range:56,  atk:17, cd:42, kind:'aoe',   ab:'Щит',     abcd:450},
  fil : {name:'Фил',  role:'маг',     color:'#6ef0a8', hp:80,  spd:1.90, range:180, atk:21, cd:38, kind:'magic', ab:'Взрыв',   abcd:400},
  lars: {name:'Ларс', role:'бард',    color:'#ffd166', hp:110, spd:2.00, range:160, atk:10, cd:30, kind:'shot',  ab:'Лечение', abcd:380}
};
const ORDER = ['art','kira','vik','fil','lars'];

const FOE = {
  bug  : {hp:20,  spd:1.55, dmg:6,  r:10, col:'#ff5d73', kind:'melee'},
  drone: {hp:30,  spd:0.95, dmg:8,  r:11, col:'#ffa33d', kind:'shot' },
  golem: {hp:70,  spd:0.80, dmg:15, r:15, col:'#8f6bff', kind:'melee'},
  guard: {hp:320, spd:1.00, dmg:18, r:22, col:'#ff3d6e', kind:'both' }
};

const BOT_LINES = [
  'Прикрываю.', 'Слева двое.', 'Держим строй.', 'Ещё немного!',
  'У кого мало хп — ко мне.', 'Я почти его добил.', 'Не лезь один.'
];

/* =====================================================================
   Комнаты
   ===================================================================== */
const rooms = new Map();
let uid = 1;

function makeRoom(code) {
  const r = {
    code,
    players: new Map(),     // id -> {id,name,ws,cls,in:{dx,dy,ab}}
    phase: 'lobby',         // lobby | play | clear | dead | won
    level: 1,
    diff: 1,
    timer: 0,
    tick: 0,
    heroes: [], foes: [], shots: [], fx: [], boss: null,
    spawnLeft: 0,
    seq: 1
  };
  rooms.set(code, r);
  return r;
}
function roomOf(code) { return rooms.get(code) || makeRoom(code); }

function freeClasses(room) {
  const taken = new Set();
  room.players.forEach(p => { if (p.cls) taken.add(p.cls); });
  return ORDER.filter(k => !taken.has(k));
}

/* =====================================================================
   Построение уровня
   ===================================================================== */
function hpScale(r)  { return (1 + (r.level - 1) * 0.06)  * r.diff; }
function dmgScale(r) { return (1 + (r.level - 1) * 0.035) * r.diff; }

function mkHero(room, key) {
  const c = CLASSES[key];
  return { key, c, owner:null,
    x: W/2 + (Math.random()*80 - 40), y: H/2 + (Math.random()*80 - 40),
    hp: c.hp, max: c.hp, cd: 0, ab: 0, down: false, rt: 0, shield: 0, dash: 0 };
}
function mkFoe(room, type) {
  const b = FOE[type], a = Math.random() * Math.PI * 2, rad = 250;
  const hp = b.hp * hpScale(room);
  return { id: room.seq++, type,
    x: W/2 + Math.cos(a)*rad, y: H/2 + Math.sin(a)*rad,
    hp, max: hp, spd: b.spd, dmg: b.dmg * dmgScale(room),
    r: b.r, col: b.col, kind: b.kind, cd: Math.floor(Math.random()*60) };
}
function pickType(room) {
  const r = Math.random(), L = room.level;
  if (L < 6)  return r < 0.85 ? 'bug' : 'drone';
  if (L < 20) return r < 0.55 ? 'bug' : (r < 0.85 ? 'drone' : 'golem');
  return r < 0.40 ? 'bug' : (r < 0.72 ? 'drone' : 'golem');
}

function buildLevel(room) {
  const owners = new Map();
  room.heroes.forEach(h => { if (h.owner) owners.set(h.key, h.owner); });
  room.heroes = ORDER.map(k => {
    const h = mkHero(room, k);
    h.owner = owners.get(k) || null;
    return h;
  });
  // владельцы по игрокам (на случай первого входа)
  room.players.forEach(p => {
    if (p.cls) { const h = room.heroes.find(x => x.key === p.cls); if (h) h.owner = p.id; }
  });

  room.foes = []; room.shots = []; room.fx = []; room.boss = null; room.tick = 0;

  if (room.level >= 100) {
    const hp = 4200 * room.diff;
    room.boss = { x: W/2, y: 90, r: 34, hp, max: hp, phase: 1, cd: 80, charge: 0, cx: 0, cy: 0 };
    room.spawnLeft = 0;
    say(room, 'Моргарт', 'Наконец-то. Игроки.');
  } else {
    let need = Math.min(18, 5 + Math.floor(room.level / 5));
    room.spawnLeft = need;
    if (room.level % 10 === 0) { room.foes.push(mkFoe(room, 'guard')); room.spawnLeft--; }
    const first = Math.min(5, room.spawnLeft);
    for (let i = 0; i < first; i++) { room.foes.push(mkFoe(room, pickType(room))); room.spawnLeft--; }
  }
}

/* =====================================================================
   Симуляция (60 тиков в секунду)
   ===================================================================== */
function nearestFoe(room, x, y) {
  let best = null, bd = Infinity;
  for (const f of room.foes) { const d = Math.hypot(f.x-x, f.y-y); if (d < bd) { bd = d; best = f; } }
  if (room.boss) { const d = Math.hypot(room.boss.x-x, room.boss.y-y); if (d < bd) best = room.boss; }
  return best;
}
function nearestHero(room, x, y) {
  let best = null, bd = Infinity;
  for (const h of room.heroes) { if (h.down) continue; const d = Math.hypot(h.x-x, h.y-y); if (d < bd) { bd = d; best = h; } }
  return best;
}
function boom(room, x, y, max, col) { room.fx.push({ x: Math.round(x), y: Math.round(y), m: Math.round(max), c: col }); }

function hitArea(room, x, y, rad, dmg) {
  for (const f of room.foes) if (Math.hypot(f.x-x, f.y-y) < rad + f.r) f.hp -= dmg;
  if (room.boss && Math.hypot(room.boss.x-x, room.boss.y-y) < rad + room.boss.r) room.boss.hp -= dmg;
}
function hurt(room, h, d) {
  if (h.shield > 0) d *= 0.25;
  h.hp -= d;
  if (h.hp <= 0) { h.hp = 0; h.down = true; h.rt = 260; say(room, h.c.name, 'Меня выбили, жду респаун.'); }
}

function castAbility(room, h) {
  h.ab = h.c.abcd;
  if (h.key === 'art') {
    h.dash = 16; boom(room, h.x, h.y, 60, h.c.color);
    hitArea(room, h.x, h.y, 70, h.c.atk * 2.2 * dmgScale(room));
  } else if (h.key === 'kira') {
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      room.shots.push({ id: room.seq++, x: h.x, y: h.y, vx: Math.cos(a)*5.5, vy: Math.sin(a)*5.5,
        dmg: h.c.atk * 1.1 * dmgScale(room), mine: true, life: 110, col: h.c.color, r: 4 });
    }
  } else if (h.key === 'vik') {
    room.heroes.forEach(o => { if (!o.down) o.shield = 200; });
    boom(room, h.x, h.y, 120, h.c.color);
  } else if (h.key === 'fil') {
    boom(room, h.x, h.y, 110, h.c.color);
    hitArea(room, h.x, h.y, 110, h.c.atk * 2.6 * dmgScale(room));
  } else if (h.key === 'lars') {
    room.heroes.forEach(o => { if (!o.down) o.hp = Math.min(o.max, o.hp + o.max * 0.42); });
    boom(room, h.x, h.y, 130, h.c.color);
  }
}

function stepHeroes(room) {
  for (const h of room.heroes) {
    if (h.down) {
      h.rt--;
      if (h.rt <= 0) { h.down = false; h.hp = h.max * 0.7; h.x = W/2; h.y = H/2; }
      continue;
    }
    if (h.ab > 0) h.ab--;
    if (h.shield > 0) h.shield--;

    let mx = 0, my = 0;
    const owner = h.owner ? room.players.get(h.owner) : null;

    if (owner) {
      mx = owner.in.dx; my = owner.in.dy;
      const m = Math.hypot(mx, my); if (m > 1) { mx /= m; my /= m; }
      if (owner.in.ab && h.ab <= 0) castAbility(room, h);
      owner.in.ab = false;
    } else {
      const tg = nearestFoe(room, h.x, h.y);
      if (tg) {
        const d = Math.hypot(tg.x - h.x, tg.y - h.y) || 1;
        const want = (h.c.kind === 'melee' || h.c.kind === 'aoe') ? h.c.range * 0.6 : h.c.range * 0.75;
        if (Math.abs(d - want) > 14) { const s = d > want ? 1 : -1; mx = (tg.x-h.x)/d*s; my = (tg.y-h.y)/d*s; }
        else { mx = Math.cos(room.tick/40 + h.x) * 0.4; my = Math.sin(room.tick/37 + h.y) * 0.4; }
        if (h.ab <= 0 && Math.random() < 0.02) castAbility(room, h);
      }
    }

    const sp = h.c.spd * (h.dash > 0 ? 3.2 : 1);
    if (h.dash > 0) h.dash--;
    h.x = Math.max(16, Math.min(W-16, h.x + mx * sp));
    h.y = Math.max(16, Math.min(H-16, h.y + my * sp));

    /* автоатака */
    if (h.cd > 0) { h.cd--; continue; }
    const t = nearestFoe(room, h.x, h.y);
    if (t) {
      const d = Math.hypot(t.x - h.x, t.y - h.y);
      if (d < h.c.range + (t.r || 12)) {
        h.cd = h.c.cd;
        const dmg = h.c.atk * dmgScale(room);
        if (h.c.kind === 'melee') { t.hp -= dmg; boom(room, (h.x+t.x)/2, (h.y+t.y)/2, 26, h.c.color); }
        else if (h.c.kind === 'aoe') { hitArea(room, h.x, h.y, h.c.range, dmg); boom(room, h.x, h.y, h.c.range, h.c.color); }
        else {
          const a = Math.atan2(t.y - h.y, t.x - h.x), v = h.c.kind === 'magic' ? 4.4 : 6.4;
          room.shots.push({ id: room.seq++, x: h.x, y: h.y, vx: Math.cos(a)*v, vy: Math.sin(a)*v,
            dmg, mine: true, life: 120, col: h.c.color, r: h.c.kind === 'magic' ? 7 : 4, blast: h.c.kind === 'magic' });
        }
        continue;
      }
    }
    if (h.key === 'lars') {
      let low = null;
      for (const o of room.heroes) if (!o.down && o.hp < o.max*0.55 && (!low || o.hp/o.max < low.hp/low.max)) low = o;
      if (low) { low.hp = Math.min(low.max, low.hp + 14); h.cd = h.c.cd; }
    }
  }
}

function stepFoes(room) {
  if (!room.boss && room.spawnLeft > 0 && room.foes.length < 7 && room.tick % 45 === 0) {
    room.foes.push(mkFoe(room, pickType(room))); room.spawnLeft--;
  }
  for (const f of room.foes) {
    const t = nearestHero(room, f.x, f.y);
    if (!t) continue;
    const d = Math.hypot(t.x - f.x, t.y - f.y) || 1;
    const close = f.kind === 'shot' ? 150 : 20;
    if (d > close) { f.x += (t.x - f.x)/d * f.spd; f.y += (t.y - f.y)/d * f.spd; }
    if (f.cd > 0) { f.cd--; continue; }
    if (f.kind === 'melee' && d < f.r + 16) { hurt(room, t, f.dmg); f.cd = 50; }
    else if ((f.kind === 'shot' || f.kind === 'both') && d < 260) {
      const a = Math.atan2(t.y - f.y, t.x - f.x);
      room.shots.push({ id: room.seq++, x: f.x, y: f.y, vx: Math.cos(a)*3.4, vy: Math.sin(a)*3.4,
        dmg: f.dmg, mine: false, life: 140, col: f.col, r: 5 });
      f.cd = f.kind === 'both' ? 42 : 74;
    } else if (f.kind === 'both' && d < f.r + 18) { hurt(room, t, f.dmg); f.cd = 42; }
  }
}

function stepBoss(room) {
  const b = room.boss;
  b.phase = b.hp/b.max > 0.66 ? 1 : (b.hp/b.max > 0.33 ? 2 : 3);
  const t = nearestHero(room, b.x, b.y);
  if (!t) return;
  const d = Math.hypot(t.x - b.x, t.y - b.y) || 1;

  if (b.charge > 0) {
    b.charge--;
    b.x = Math.max(40, Math.min(W-40, b.x + b.cx * 4.2));
    b.y = Math.max(40, Math.min(H-40, b.y + b.cy * 4.2));
    for (const h of room.heroes) if (!h.down && Math.hypot(h.x-b.x, h.y-b.y) < b.r + 14) hurt(room, h, 3 * room.diff);
  } else {
    b.x += (t.x - b.x)/d * 0.55; b.y += (t.y - b.y)/d * 0.55;
  }

  if (--b.cd > 0) return;
  const pick = Math.random();
  if (b.phase >= 3 && pick < 0.45) {
    for (let i = 0; i < 16; i++) {
      const a = i/16 * Math.PI*2 + room.tick*0.01;
      room.shots.push({ id: room.seq++, x: b.x, y: b.y, vx: Math.cos(a)*3.1, vy: Math.sin(a)*3.1,
        dmg: 16*room.diff, mine: false, life: 190, col: '#ff3d6e', r: 6 });
    }
    b.cd = 110;
  } else if (b.phase >= 2 && pick < 0.70) {
    for (let m = 0; m < 3; m++) {
      const f = mkFoe(room, m === 0 ? 'golem' : 'bug');
      f.x = b.x + (Math.random()*80 - 40); f.y = b.y + (Math.random()*60 - 30);
      room.foes.push(f);
    }
    say(room, 'Моргарт', 'Вас слишком мало.');
    b.cd = 150;
  } else if (pick < 0.85) {
    const a = Math.atan2(t.y - b.y, t.x - b.x);
    b.cx = Math.cos(a); b.cy = Math.sin(a); b.charge = 34; b.cd = 130;
  } else {
    const a0 = Math.atan2(t.y - b.y, t.x - b.x);
    for (let s = -1; s <= 1; s++) {
      room.shots.push({ id: room.seq++, x: b.x, y: b.y, vx: Math.cos(a0 + s*0.22)*4, vy: Math.sin(a0 + s*0.22)*4,
        dmg: 14*room.diff, mine: false, life: 180, col: '#ff7a3d', r: 6 });
    }
    b.cd = 70;
  }
}

function stepShots(room) {
  for (let i = room.shots.length - 1; i >= 0; i--) {
    const s = room.shots[i];
    s.x += s.vx; s.y += s.vy; s.life--;
    let gone = s.life <= 0 || s.x < -20 || s.x > W+20 || s.y < -20 || s.y > H+20;
    if (!gone && s.mine) {
      for (const f of room.foes) {
        if (Math.hypot(f.x - s.x, f.y - s.y) < f.r + s.r) {
          if (s.blast) { hitArea(room, s.x, s.y, 52, s.dmg); boom(room, s.x, s.y, 52, s.col); }
          else f.hp -= s.dmg;
          gone = true; break;
        }
      }
      if (!gone && room.boss && Math.hypot(room.boss.x - s.x, room.boss.y - s.y) < room.boss.r + s.r) {
        if (s.blast) hitArea(room, s.x, s.y, 52, s.dmg); else room.boss.hp -= s.dmg;
        gone = true;
      }
    } else if (!gone) {
      for (const h of room.heroes) {
        if (!h.down && Math.hypot(h.x - s.x, h.y - s.y) < 14 + s.r) { hurt(room, h, s.dmg); gone = true; break; }
      }
    }
    if (gone) room.shots.splice(i, 1);
  }
}

function tickRoom(room) {
  if (room.players.size === 0) return;

  if (room.phase === 'clear' || room.phase === 'dead') {
    if (--room.timer <= 0) {
      if (room.phase === 'clear') room.level++;
      if (room.level > 100) { room.phase = 'won'; return; }
      room.phase = 'play';
      buildLevel(room);
    }
    return;
  }
  if (room.phase !== 'play') return;

  room.tick++;
  stepHeroes(room);
  stepFoes(room);
  if (room.boss) stepBoss(room);
  stepShots(room);

  for (let i = room.foes.length - 1; i >= 0; i--) {
    if (room.foes[i].hp <= 0) { boom(room, room.foes[i].x, room.foes[i].y, 34, room.foes[i].col); room.foes.splice(i, 1); }
  }
  if (room.boss && room.boss.hp <= 0) {
    boom(room, room.boss.x, room.boss.y, 200, '#ffd166');
    room.boss = null; room.phase = 'won';
    say(room, 'Сервер', 'Моргарт повержен. Игра пройдена!');
    return;
  }
  if (!room.boss && room.foes.length === 0 && room.spawnLeft === 0) {
    room.phase = 'clear'; room.timer = 180;
    say(room, 'Сервер', 'Уровень ' + room.level + ' пройден.');
    return;
  }
  if (room.heroes.every(h => h.down)) {
    room.phase = 'dead'; room.timer = 240;
    say(room, 'Сервер', 'Отряд повержен. Повтор уровня.');
  }
  if (room.tick % 900 === 0) {
    const bots = room.heroes.filter(h => !h.owner && !h.down);
    if (bots.length) {
      const b = bots[Math.floor(Math.random()*bots.length)];
      say(room, b.c.name, BOT_LINES[Math.floor(Math.random()*BOT_LINES.length)]);
    }
  }
}

/* =====================================================================
   Сеть
   ===================================================================== */
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { const s = JSON.stringify(obj); room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(s); }); }
function say(room, who, text) { broadcast(room, { t:'chat', who, text }); }

function lobbyState(room) {
  return { t:'lobby', code: room.code, phase: room.phase, level: room.level, diff: room.diff,
    slots: ORDER.map(k => {
      const h = room.heroes.find(x => x.key === k);
      const ownerId = h ? h.owner : null;
      const p = ownerId ? room.players.get(ownerId) : null;
      return { key:k, name:CLASSES[k].name, role:CLASSES[k].role, color:CLASSES[k].color,
               ab:CLASSES[k].ab, taken: !!p, by: p ? p.name : 'бот' };
    }),
    players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, cls:p.cls }))
  };
}

function snapshot(room) {
  const snap = {
    t:'s', ph: room.phase, lv: room.level, tm: Math.ceil(room.timer/60),
    en: room.boss ? -1 : room.foes.length + room.spawnLeft,
    h: room.heroes.map(h => ({ k:h.key, x:Math.round(h.x), y:Math.round(h.y),
        hp:Math.round(h.hp), mx:Math.round(h.max), dn:h.down?1:0, rt:Math.ceil(h.rt/60),
        sh:h.shield>0?1:0, ab:h.ab, o:h.owner || 0 })),
    f: room.foes.map(f => ({ i:f.id, t:f.type, x:Math.round(f.x), y:Math.round(f.y), r:f.r,
        hp:Math.round(f.hp), mx:Math.round(f.max), c:f.col })),
    p: room.shots.map(s => ({ i:s.id, x:Math.round(s.x), y:Math.round(s.y), r:s.r, c:s.col })),
    x: room.fx
  };
  if (room.boss) snap.b = { x:Math.round(room.boss.x), y:Math.round(room.boss.y), r:room.boss.r,
                            hp:Math.round(room.boss.hp), mx:Math.round(room.boss.max), ph:room.boss.phase };
  room.fx = [];
  return snap;
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('room') || 'ENVELL').toUpperCase().slice(0, 12);
  const name = (url.searchParams.get('name') || 'Игрок').slice(0, 14);
  const room = roomOf(code);

  if (room.players.size >= 5) { send(ws, { t:'full' }); ws.close(); return; }
  if (room.heroes.length === 0) buildLevel(room);

  const player = { id: uid++, name, ws, cls: null, in: { dx:0, dy:0, ab:false } };
  room.players.set(player.id, player);

  send(ws, { t:'hello', id: player.id, code, classes: CLASSES, order: ORDER, W, H });
  broadcast(room, lobbyState(room));
  say(room, 'Сервер', name + ' подключился (' + room.players.size + '/5)');

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'pick') {
      if (!ORDER.includes(m.cls)) return;
      const h = room.heroes.find(x => x.key === m.cls);
      if (!h || (h.owner && h.owner !== player.id)) return;
      const old = room.heroes.find(x => x.owner === player.id);
      if (old) old.owner = null;
      h.owner = player.id; player.cls = m.cls;
      broadcast(room, lobbyState(room));
    }
    else if (m.t === 'start') {
      if (room.phase === 'lobby' || room.phase === 'won') {
        room.level = Math.max(1, Math.min(100, parseInt(m.level, 10) || 1));
        room.diff  = [0.75, 1, 1.4].includes(m.diff) ? m.diff : 1;
        room.phase = 'play';
        buildLevel(room);
        broadcast(room, lobbyState(room));
        say(room, 'Сервер', 'Старт. Уровень ' + room.level + '.');
      }
    }
    else if (m.t === 'in') {
      player.in.dx = Math.max(-1, Math.min(1, +m.dx || 0));
      player.in.dy = Math.max(-1, Math.min(1, +m.dy || 0));
      if (m.ab) player.in.ab = true;
    }
    else if (m.t === 'chat' && typeof m.text === 'string') {
      say(room, player.name, m.text.slice(0, 80));
    }
    else if (m.t === 'menu') {
      room.phase = 'lobby';
      broadcast(room, lobbyState(room));
    }
  });

  ws.on('close', () => {
    const h = room.heroes.find(x => x.owner === player.id);
    if (h) h.owner = null;
    room.players.delete(player.id);
    if (room.players.size === 0) { rooms.delete(code); return; }
    broadcast(room, lobbyState(room));
    say(room, 'Сервер', name + ' вышел. Героя взял бот.');
  });
});

/* главный цикл: симуляция 60 Гц, рассылка 20 Гц */
let netTick = 0;
setInterval(() => {
  netTick++;
  rooms.forEach(room => {
    tickRoom(room);
    if (netTick % 3 === 0 && room.players.size) broadcast(room, snapshot(room));
  });
}, 1000 / 60);

server.listen(PORT, () => {
  console.log('Энвелл-сервер работает: http://localhost:' + PORT);
  console.log('Дай друзьям публичную ссылку — они откроют её и попадут в комнату.');
});
