/* =====================================================================
   ЭНВЕЛЛ — игровой сервер
   Платформер, вид сбоку. Прокачка героев, 100 способностей, квесты.
   Запуск: npm install && npm start
   ===================================================================== */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT  = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p !== '/' && p !== '/index.html') { res.writeHead(404); return res.end('not found'); }
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html рядом с server.js не найден'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

/* ===================== мир ===================== */
const W = 320, H = 180, FLOOR = 168, G = 0.42;

const CLASSES = {
  art : {name:'Арт',  role:'воин',    hp:145, spd:1.15, jump:5.5, range:20,  atk:25, cd:30, kind:'melee'},
  kira: {name:'Кира', role:'лучница', hp:95,  spd:1.28, jump:5.8, range:115, atk:15, cd:24, kind:'shot' },
  vik : {name:'Вик',  role:'страж',   hp:200, spd:0.95, jump:5.0, range:24,  atk:18, cd:40, kind:'melee'},
  fil : {name:'Фил',  role:'маг',     hp:85,  spd:1.10, jump:5.4, range:100, atk:22, cd:36, kind:'magic'},
  lars: {name:'Ларс', role:'бард',    hp:115, spd:1.22, jump:5.6, range:95,  atk:11, cd:28, kind:'shot' }
};
const ORDER = ['art','kira','vik','fil','lars'];

/* ---------- 100 способностей ---------- */
const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
const KIND = [
  {k:'dash',   n:'Рывок',        cd:300, d:'Рывок вперёд, сбивает всех на пути'},
  {k:'volley', n:'Залп',         cd:340, d:'Веер снарядов во все стороны'},
  {k:'shield', n:'Щит',          cd:420, d:'Отряд получает вчетверо меньше урона'},
  {k:'blast',  n:'Взрыв',        cd:360, d:'Взрыв вокруг героя'},
  {k:'heal',   n:'Лечение',      cd:400, d:'Лечит всю команду'},
  {k:'spikes', n:'Шипы',         cd:330, d:'Бьёт всех, кто стоит на земле'},
  {k:'chain',  n:'Цепь молний',  cd:380, d:'Бьёт трёх ближайших врагов'},
  {k:'freeze', n:'Заморозка',    cd:430, d:'Враги замирают на время'},
  {k:'leech',  n:'Вампиризм',    cd:370, d:'Урон ближнему, часть уходит в здоровье'},
  {k:'storm',  n:'Буря',         cd:450, d:'Дождь снарядов с неба'}
];
const ABIL = [];
for (let i = 0; i < 100; i++) {
  const b = KIND[i % 10], tier = Math.floor(i / 10);
  ABIL.push({ i, k:b.k, name:b.n + ' ' + ROMAN[tier], lvl:i + 1,
              cd:Math.max(90, b.cd - tier * 22), p:1 + tier * 0.6, d:b.d });
}

const xpNeed = l => Math.round(12 * Math.pow(l, 1.25));
function levelOf(xp) {
  let l = 1, acc = 0;
  while (l < 100 && xp >= acc + xpNeed(l)) { acc += xpNeed(l); l++; }
  return l;
}

const FOE = {
  bug  : {w:9,  h:7,  hp:22,  spd:0.72, dmg:6,  fly:false, shoot:false, xp:4,   cells:1},
  flyer: {w:11, h:8,  hp:28,  spd:0.55, dmg:7,  fly:true,  shoot:true,  xp:6,   cells:1},
  golem: {w:12, h:12, hp:75,  spd:0.34, dmg:15, fly:false, shoot:false, xp:14,  cells:3},
  guard: {w:19, h:19, hp:340, spd:0.48, dmg:19, fly:false, shoot:true,  xp:90,  cells:20},
  salam: {w:14, h:9,  hp:900, spd:0.95, dmg:22, fly:true,  shoot:true,  xp:260, cells:40}
};

const MAPS = [
  [{x:36,y:128,w:58},{x:226,y:128,w:58},{x:128,y:96,w:64}],
  [{x:18,y:136,w:52},{x:96,y:112,w:52},{x:176,y:90,w:52},{x:250,y:122,w:52}],
  [{x:28,y:122,w:44},{x:248,y:122,w:44},{x:110,y:98,w:100}],
  [{x:60,y:140,w:40},{x:220,y:140,w:40},{x:140,y:116,w:40},{x:60,y:92,w:40},{x:220,y:92,w:40}]
];
const BOSS_MAP = [{x:20,y:124,w:56},{x:244,y:124,w:56}];
const BOT_LINES = ['Прикрываю.','Слева!','Держим строй.','Ещё немного.','У кого мало хп — ко мне.'];

/* ===================== комнаты ===================== */
const rooms = new Map();
let uid = 1;

function makeRoom(code) {
  const r = { code, players:new Map(), phase:'lobby', level:1, diff:1, timer:0, tick:0,
              heroes:[], foes:[], shots:[], fx:[], boss:null, plats:MAPS[0], spawnLeft:0, seq:1,
              cells:0, up:{hp:0, dmg:0}, xp:{}, quests:[], qseq:1, hitless:true, best:1 };
  ORDER.forEach(k => r.xp[k] = 0);
  rooms.set(code, r);
  return r;
}
const roomOf = c => rooms.get(c) || makeRoom(c);

const hpScale  = r => (1 + (r.level - 1) * 0.06)  * r.diff;
const dmgScale = r => (1 + (r.level - 1) * 0.035) * r.diff;
const upHp  = r => 1 + r.up.hp  * 0.12;
const upDmg = r => 1 + r.up.dmg * 0.12;

function mkHero(key, room) {
  const c = CLASSES[key], lv = levelOf(room.xp[key]);
  const max = Math.round(c.hp * upHp(room) * (1 + (lv - 1) * 0.02));
  return { key, c, owner:null, w:12, h:16, lv,
    x:W/2, y:100, vx:0, vy:0, face:1, onGround:false,
    hp:max, max, cd:0, down:false, rt:0, shield:0, dash:0, frozenHit:0,
    roll:0, rollCd:0, combo:0, comboT:0, inv:0, swing:0,
    slots:[null,null,null,null,null], cds:[0,0,0,0,0] };
}
function mkFoe(room, type, px, py) {
  const b = FOE[type], hp = b.hp * hpScale(room);
  const side = Math.random() < 0.5 ? -12 : W + 12;
  return { id:room.seq++, type, w:b.w, h:b.h, fly:b.fly, shoot:b.shoot,
    x: px !== undefined ? px : side, y: py !== undefined ? py : (b.fly ? 40 + Math.random()*50 : 20),
    vx:0, vy:0, onGround:false, face:1, frz:0,
    hp, max:hp, spd:b.spd, dmg:b.dmg * dmgScale(room), cd:Math.floor(Math.random()*70) };
}
function pickType(room) {
  const r = Math.random(), L = room.level;
  if (L < 6)  return r < 0.8 ? 'bug' : 'flyer';
  if (L < 20) return r < 0.5 ? 'bug' : (r < 0.82 ? 'flyer' : 'golem');
  return r < 0.36 ? 'bug' : (r < 0.7 ? 'flyer' : 'golem');
}

function buildLevel(room) {
  const owners = new Map(), slots = new Map();
  room.heroes.forEach(h => { if (h.owner) owners.set(h.key, h.owner); slots.set(h.key, h.slots); });
  room.heroes = ORDER.map(k => {
    const h = mkHero(k, room);
    h.owner = owners.get(k) || null;
    if (slots.get(k)) h.slots = slots.get(k);
    return h;
  });
  room.players.forEach(p => {
    if (p.cls) { const h = room.heroes.find(x => x.key === p.cls); if (h) { h.owner = p.id; h.slots = p.slots; } }
  });
  room.heroes.forEach(h => {
    if (h.owner) return;
    const open = [];
    for (let i = 0; i < 100 && open.length < 5; i++) if (ABIL[i].lvl <= h.lv) open.push(i);
    while (open.length < 5) open.push(null);
    h.slots = open.slice(0, 5);
  });
  room.heroes.forEach((h, i) => { h.x = 90 + i * 34; h.y = 120; });

  room.foes = []; room.shots = []; room.fx = []; room.boss = null; room.tick = 0; room.hitless = true;
  if (room.level > room.best) room.best = room.level;

  if (room.level >= 100) {
    room.plats = BOSS_MAP;
    const hp = 4400 * room.diff;
    room.boss = { x:W/2 - 17, y:60, w:35, h:40, vx:0, vy:0, onGround:false, face:1,
                  hp, max:hp, phase:1, cd:90, slam:0 };
    room.spawnLeft = 0;
    say(room, 'Моргарт', 'Наконец-то. Игроки.');
  } else {
    room.plats = MAPS[(room.level - 1) % MAPS.length];
    room.spawnLeft = Math.min(20, 5 + Math.floor(room.level / 4));
    if (room.level % 25 === 0) {
      room.foes.push(mkFoe(room, 'salam')); room.spawnLeft--;
      say(room, 'Саламандра', 'Меня вы даже не увидите.');
    } else if (room.level % 10 === 0) {
      room.foes.push(mkFoe(room, 'guard')); room.spawnLeft--;
      say(room, 'Сервер', 'Страж уровня вышел на арену.');
    }
    for (let i = 0; i < Math.min(4, room.spawnLeft); i++) { room.foes.push(mkFoe(room, pickType(room))); room.spawnLeft--; }
  }
}

/* ===================== квесты ===================== */
const QT = [
  r => ({ k:'kill',  t:10 + r.level * 2, txt:'Уничтожить ' + (10 + r.level * 2) + ' врагов', c:15, x:60 }),
  r => ({ k:'clear', t:3,                txt:'Пройти 3 уровня подряд',                      c:25, x:120 }),
  r => ({ k:'nohit', t:1,                txt:'Пройти уровень, не получив урона',            c:40, x:200 }),
  r => ({ k:'golem', t:5,                txt:'Разбить 5 големов',                           c:20, x:90 }),
  r => ({ k:'boss',  t:1,                txt:'Победить Стража или Саламандру',              c:60, x:260 })
];
function addQuest(room) {
  if (room.quests.filter(q => !q.done).length >= 4) return;
  const q = QT[Math.floor(Math.random() * QT.length)](room);
  room.quests.push({ id:room.qseq++, k:q.k, txt:q.txt, t:q.t, p:0, c:q.c, x:q.x, done:false, lvl:room.level });
  say(room, 'Карта', 'Новое задание: ' + q.txt);
}
function questTick(room, kind, n) {
  for (const q of room.quests) {
    if (q.done || q.k !== kind) continue;
    q.p += n;
    if (q.p >= q.t) {
      q.done = true; q.p = q.t;
      room.cells += q.c;
      ORDER.forEach(k => room.xp[k] += q.x);
      say(room, 'Карта', 'Задание выполнено: ' + q.txt + ' (+' + q.c + ' клеток)');
    }
  }
}
function giveXp(room, n) { ORDER.forEach(k => room.xp[k] += n); }

/* ===================== физика ===================== */
function gravity(e, plats) {
  e.vy += G;
  const prevBottom = e.y + e.h;
  e.y += e.vy;
  e.onGround = false;
  if (e.y + e.h >= FLOOR) { e.y = FLOOR - e.h; e.vy = 0; e.onGround = true; return; }
  if (e.vy > 0) for (const p of plats)
    if (prevBottom <= p.y + 1 && e.y + e.h >= p.y && e.x + e.w > p.x && e.x < p.x + p.w) {
      e.y = p.y - e.h; e.vy = 0; e.onGround = true; return;
    }
}
const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const cx = e => e.x + e.w / 2;
const cy = e => e.y + e.h / 2;

function nearestFoe(room, x, y) {
  let best = null, bd = Infinity;
  for (const f of room.foes) { const d = Math.hypot(cx(f)-x, cy(f)-y); if (d < bd) { bd = d; best = f; } }
  if (room.boss) { const d = Math.hypot(cx(room.boss)-x, cy(room.boss)-y); if (d < bd) best = room.boss; }
  return best;
}
function nearestHero(room, x, y) {
  let best = null, bd = Infinity;
  for (const h of room.heroes) { if (h.down) continue; const d = Math.hypot(cx(h)-x, cy(h)-y); if (d < bd) { bd = d; best = h; } }
  return best;
}
const boom = (room, x, y, m, c) => room.fx.push({ x:Math.round(x), y:Math.round(y), m, c });
const num  = (room, x, y, v, c) => room.fx.push({ x:Math.round(x), y:Math.round(y), n:Math.round(v), c });

function damage(room, f, d) {
  f.hp -= d;
  num(room, cx(f), f.y - 2, d, '#ffe487');
}
function area(room, x, y, rad, dmg, show) {
  for (const f of room.foes) if (Math.hypot(cx(f)-x, cy(f)-y) < rad) { f.hp -= dmg; if (show) num(room, cx(f), f.y-2, dmg, '#ffe487'); }
  if (room.boss && Math.hypot(cx(room.boss)-x, cy(room.boss)-y) < rad + 10) {
    room.boss.hp -= dmg; if (show) num(room, cx(room.boss), room.boss.y-2, dmg, '#ffe487');
  }
}
function hurt(room, h, d) {
  if (h.inv > 0) return;
  if (h.shield > 0) d *= 0.25;
  h.hp -= d; room.hitless = false;
  num(room, cx(h), h.y - 4, d, '#ff5d73');
  if (h.hp <= 0) { h.hp = 0; h.down = true; h.rt = 260; say(room, h.c.name, 'Меня выбили!'); }
}

/* ===================== способности ===================== */
function cast(room, h, a) {
  const P = a.p, D = dmgScale(room) * upDmg(room), base = h.c.atk;
  switch (a.k) {
    case 'dash':
      h.dash = 14; h.vx = h.face * 3.4;
      boom(room, cx(h), cy(h), 30, '#ff7a3d');
      area(room, cx(h), cy(h), 26 + P*4, base * 1.8 * P * D, true); break;
    case 'volley':
      for (let i = 0; i < 6 + Math.round(P*2); i++) {
        const an = i / (6 + Math.round(P*2)) * Math.PI * 2;
        room.shots.push({ id:room.seq++, x:cx(h), y:cy(h), vx:Math.cos(an)*3.2, vy:Math.sin(an)*3.2,
          dmg:base * P * D, mine:true, life:90, c:'#7fe0ff', r:2 });
      } break;
    case 'shield':
      room.heroes.forEach(o => { if (!o.down) o.shield = Math.round(140 + P*70); });
      boom(room, cx(h), cy(h), 44, '#9fd4ff'); break;
    case 'blast':
      boom(room, cx(h), cy(h), 40 + P*12, '#8dffc0');
      area(room, cx(h), cy(h), 34 + P*10, base * 2.2 * P * D, true); break;
    case 'heal':
      room.heroes.forEach(o => { if (!o.down) o.hp = Math.min(o.max, o.hp + o.max * (0.2 + P*0.12)); });
      boom(room, cx(h), cy(h), 54, '#ffe08a'); break;
    case 'spikes':
      for (const f of room.foes) if (f.onGround) damage(room, f, base * 2 * P * D);
      boom(room, cx(h), FLOOR - 4, 120, '#ffd166'); break;
    case 'chain': {
      const list = room.foes.slice().sort((a1,b1) =>
        Math.hypot(cx(a1)-cx(h), cy(a1)-cy(h)) - Math.hypot(cx(b1)-cx(h), cy(b1)-cy(h))).slice(0, 3);
      list.forEach(f => { damage(room, f, base * 1.9 * P * D); boom(room, cx(f), cy(f), 20, '#9fd4ff'); });
      if (room.boss) { room.boss.hp -= base * 1.9 * P * D; num(room, cx(room.boss), room.boss.y-2, base*1.9*P*D, '#ffe487'); }
      break; }
    case 'freeze':
      room.foes.forEach(f => f.frz = Math.round(70 + P*40));
      boom(room, cx(h), cy(h), 110, '#9fd4ff'); break;
    case 'leech': {
      const t = nearestFoe(room, cx(h), cy(h));
      if (t) { const d = base * 2.4 * P * D; t.hp -= d; num(room, cx(t), t.y-2, d, '#ffe487');
        h.hp = Math.min(h.max, h.hp + d * 0.5); boom(room, cx(h), cy(h), 26, '#ff6a9a'); }
      break; }
    case 'storm':
      for (let i = 0; i < 6 + Math.round(P*3); i++)
        room.shots.push({ id:room.seq++, x:20 + Math.random()*280, y:-6,
          vx:(Math.random()-0.5)*0.6, vy:2.2 + Math.random(),
          dmg:base * 1.1 * P * D, mine:true, life:140, c:'#c9a6ff', r:3 });
      boom(room, 160, 20, 100, '#c9a6ff'); break;
  }
}
function useSlot(room, h, s) {
  const id = h.slots[s];
  if (id === null || id === undefined) return;
  const a = ABIL[id];
  if (!a || a.lvl > h.lv || h.cds[s] > 0) return;
  h.cds[s] = a.cd;
  cast(room, h, a);
}

/* ===================== бой героя ===================== */
function swing(room, h) {
  h.combo = (h.comboT > 0) ? Math.min(2, h.combo + 1) : 0;
  h.comboT = 46;
  h.cd = [16, 16, 26][h.combo];
  h.swing = 10;
  const D = h.c.atk * dmgScale(room) * upDmg(room) * [1, 1.15, 1.6][h.combo] * (1 + (h.lv-1)*0.012);
  if (h.c.kind === 'melee') {
    const reach = h.c.range + h.combo * 4;
    const box = { x: h.face > 0 ? h.x + 6 : h.x + 6 - reach, y: h.y - 2, w: reach, h: h.h + 4 };
    let got = false;
    for (const f of room.foes) if (hit(box, f)) { damage(room, f, D); got = true; f.x += h.face * (1 + h.combo); }
    if (room.boss && hit(box, room.boss)) { room.boss.hp -= D; got = true; num(room, cx(room.boss), room.boss.y-2, D, '#ffe487'); }
    boom(room, cx(h) + h.face * 10, cy(h), got ? 22 : 12, got ? '#ffffff' : '#7f9bc4');
    if (got) room.fx.push({ hs:1 });
  } else {
    const v = h.c.kind === 'magic' ? 2.8 : 4.0;
    for (let i = 0; i <= h.combo; i++)
      room.shots.push({ id:room.seq++, x:cx(h), y:cy(h) - 1 + i*2, vx:h.face*v, vy:i*0.35 - h.combo*0.17,
        dmg:D, mine:true, life:100, c:h.c.kind === 'magic' ? '#8dffc0' : '#7fe0ff',
        r:h.c.kind === 'magic' ? 3 : 2, blast:h.c.kind === 'magic' });
    boom(room, cx(h) + h.face * 8, cy(h), 10, '#cfe0ff');
  }
}
function autoAttack(room, h) {
  const t = nearestFoe(room, cx(h), cy(h));
  if (!t) return false;
  const dx = cx(t) - cx(h), dy = cy(t) - cy(h), d = Math.hypot(dx, dy);
  if (d > h.c.range) return false;
  h.face = dx >= 0 ? 1 : -1; h.cd = h.c.cd; h.swing = 8;
  const D = h.c.atk * dmgScale(room) * upDmg(room);
  if (h.c.kind === 'melee') { damage(room, t, D); boom(room, cx(h) + h.face*10, cy(h), 16, '#ffffff'); }
  else {
    const v = h.c.kind === 'magic' ? 2.6 : 3.6, k = d || 1;
    room.shots.push({ id:room.seq++, x:cx(h), y:cy(h), vx:dx/k*v, vy:dy/k*v, dmg:D, mine:true, life:110,
      c:h.c.kind === 'magic' ? '#8dffc0' : '#7fe0ff', r:h.c.kind === 'magic' ? 3 : 2, blast:h.c.kind === 'magic' });
  }
  return true;
}

function stepHeroes(room) {
  for (const h of room.heroes) {
    if (h.down) { if (--h.rt <= 0) { h.down = false; h.hp = h.max*0.7; h.x = W/2; h.y = 60; h.vy = 0; } continue; }
    if (h.shield > 0) h.shield--;
    if (h.inv > 0) h.inv--;
    if (h.rollCd > 0) h.rollCd--;
    if (h.comboT > 0) h.comboT--; else h.combo = 0;
    if (h.swing > 0) h.swing--;
    for (let s = 0; s < 5; s++) if (h.cds[s] > 0) h.cds[s]--;

    const owner = h.owner ? room.players.get(h.owner) : null;
    let mx = 0, wantJump = false, manual = false;

    if (owner) {
      manual = true;
      mx = owner.in.dx; wantJump = owner.in.jump;
      if (owner.in.roll && h.rollCd <= 0 && h.roll <= 0) {
        h.roll = 20; h.rollCd = 48; h.inv = 15; h.vx = h.face * 2.8;
        boom(room, cx(h), cy(h) + 6, 14, '#cfe0ff');
      }
      if (owner.in.use >= 0) { useSlot(room, h, owner.in.use); owner.in.use = -1; }
      if (owner.in.atk && h.cd <= 0 && h.roll <= 0) swing(room, h);
      owner.in.jump = false; owner.in.roll = false; owner.in.atk = false;
    } else {
      const t = nearestFoe(room, cx(h), cy(h));
      if (t) {
        const dx = cx(t) - cx(h), dy = cy(t) - cy(h);
        const want = h.c.kind === 'melee' ? 12 : 70;
        if (Math.abs(dx) > want + 6) mx = dx > 0 ? 1 : -1;
        else if (Math.abs(dx) < want - 10) mx = dx > 0 ? -1 : 1;
        if (dy < -16 && h.onGround && Math.random() < 0.05) wantJump = true;
        if (Math.random() < 0.012) useSlot(room, h, Math.floor(Math.random()*5));
      }
    }

    if (h.roll > 0) h.roll--;
    else if (h.dash > 0) h.dash--;
    else { h.vx = mx * h.c.spd; if (mx) h.face = mx > 0 ? 1 : -1; }
    if (wantJump && h.onGround && h.roll <= 0) { h.vy = -h.c.jump; h.onGround = false; }

    h.x = Math.max(0, Math.min(W - h.w, h.x + h.vx));
    gravity(h, room.plats);
    if (h.dash > 0) area(room, cx(h), cy(h), 14, h.c.atk * 0.3 * dmgScale(room));

    if (h.cd > 0) h.cd--;
    else if (!manual && !autoAttack(room, h) && h.key === 'lars') {
      let low = null;
      for (const o of room.heroes) if (!o.down && o.hp < o.max*0.55 && (!low || o.hp/o.max < low.hp/low.max)) low = o;
      if (low) { low.hp = Math.min(low.max, low.hp + 12); h.cd = h.c.cd; }
    }
  }
}

function stepFoes(room) {
  if (!room.boss && room.spawnLeft > 0 && room.foes.length < 6 && room.tick % 55 === 0) {
    room.foes.push(mkFoe(room, pickType(room))); room.spawnLeft--;
  }
  for (const f of room.foes) {
    if (f.frz > 0) { f.frz--; continue; }
    if (f.type === 'salam') f.inv = (room.tick % 260) > 170;
    const t = nearestHero(room, cx(f), cy(f));
    if (!t) continue;
    const dx = cx(t) - cx(f), dy = cy(t) - cy(f);
    f.face = dx >= 0 ? 1 : -1;

    if (f.fly) {
      const d = Math.hypot(dx, dy) || 1;
      if (d > 26) { f.x += dx/d * f.spd; f.y += dy/d * f.spd; } else f.y += Math.sin(room.tick/18) * 0.3;
      f.y = Math.max(8, Math.min(FLOOR - f.h - 4, f.y));
    } else {
      if (Math.abs(dx) > 4) f.x += Math.sign(dx) * f.spd;
      gravity(f, room.plats);
    }
    f.x = Math.max(-14, Math.min(W + 14 - f.w, f.x));

    if (f.cd > 0) { f.cd--; continue; }
    if (hit(f, t)) { hurt(room, t, f.dmg); f.cd = 48; continue; }
    if (f.shoot && Math.abs(dx) < 130) {
      const d = Math.hypot(dx, dy) || 1;
      room.shots.push({ id:room.seq++, x:cx(f), y:cy(f), vx:dx/d*1.9, vy:dy/d*1.9,
        dmg:f.dmg, mine:false, life:150, c:'#ff5d73', r:2 });
      f.cd = f.type === 'guard' ? 45 : 90;
    }
  }
}

function stepBoss(room) {
  const b = room.boss;
  b.phase = b.hp/b.max > 0.66 ? 1 : (b.hp/b.max > 0.33 ? 2 : 3);
  const t = nearestHero(room, cx(b), cy(b));
  if (!t) return;
  const dx = cx(t) - cx(b);
  b.face = dx >= 0 ? 1 : -1;
  b.x = Math.max(0, Math.min(W - b.w, b.x + Math.sign(dx) * (0.3 + b.phase*0.1)));
  gravity(b, room.plats);

  if (b.slam > 0) {
    b.slam--;
    if (b.slam === 0 && b.onGround) {
      boom(room, cx(b), b.y + b.h, 80, '#ff2e5e');
      for (const h of room.heroes) if (!h.down && h.onGround && Math.abs(cx(h) - cx(b)) < 70) hurt(room, h, 20 * room.diff);
    }
  }
  if (--b.cd > 0) return;
  const r = Math.random();
  if (b.phase >= 3 && r < 0.4) {
    for (let i = 0; i < 14; i++) { const a = i/14 * Math.PI*2;
      room.shots.push({ id:room.seq++, x:cx(b), y:cy(b), vx:Math.cos(a)*1.7, vy:Math.sin(a)*1.7,
        dmg:15*room.diff, mine:false, life:170, c:'#ff2e5e', r:3 }); }
    b.cd = 120;
  } else if (b.phase >= 2 && r < 0.62) {
    for (let m = 0; m < 3; m++) room.foes.push(mkFoe(room, m === 0 ? 'golem' : 'bug', cx(b) + (Math.random()*50 - 25), b.y));
    say(room, 'Моргарт', 'Вас слишком мало.');
    b.cd = 170;
  } else if (r < 0.8 && b.onGround) { b.vy = -6.4; b.slam = 40; b.cd = 150; }
  else {
    for (let s = -1; s <= 1; s++)
      room.shots.push({ id:room.seq++, x:cx(b), y:cy(b), vx:b.face*2.4, vy:s*0.9,
        dmg:13*room.diff, mine:false, life:160, c:'#ff7a3d', r:3 });
    b.cd = 80;
  }
}

function stepShots(room) {
  for (let i = room.shots.length - 1; i >= 0; i--) {
    const s = room.shots[i];
    s.x += s.vx; s.y += s.vy; s.life--;
    let gone = s.life <= 0 || s.x < -10 || s.x > W+10 || s.y < -10 || s.y > H+10;
    const box = { x:s.x - s.r, y:s.y - s.r, w:s.r*2, h:s.r*2 };
    if (!gone && s.mine) {
      for (const f of room.foes) if (hit(box, f)) {
        if (s.blast) { area(room, s.x, s.y, 22, s.dmg, true); boom(room, s.x, s.y, 26, s.c); }
        else damage(room, f, s.dmg);
        gone = true; break;
      }
      if (!gone && room.boss && hit(box, room.boss)) {
        if (s.blast) area(room, s.x, s.y, 22, s.dmg, true);
        else { room.boss.hp -= s.dmg; num(room, cx(room.boss), room.boss.y-2, s.dmg, '#ffe487'); }
        gone = true;
      }
    } else if (!gone) {
      for (const h of room.heroes) if (!h.down && hit(box, h)) { hurt(room, h, s.dmg); gone = true; break; }
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
      room.phase = 'play'; buildLevel(room);
    }
    return;
  }
  if (room.phase !== 'play') return;

  room.tick++;
  stepHeroes(room); stepFoes(room);
  if (room.boss) stepBoss(room);
  stepShots(room);

  for (let i = room.foes.length - 1; i >= 0; i--) if (room.foes[i].hp <= 0) {
    const f = room.foes[i], b = FOE[f.type];
    room.cells += b.cells; giveXp(room, b.xp);
    questTick(room, 'kill', 1);
    if (f.type === 'golem') questTick(room, 'golem', 1);
    if (f.type === 'guard' || f.type === 'salam') questTick(room, 'boss', 1);
    boom(room, cx(f), cy(f), 20, '#ffd166');
    room.foes.splice(i, 1);
  }

  if (room.boss && room.boss.hp <= 0) {
    boom(room, cx(room.boss), cy(room.boss), 140, '#ffd166');
    room.cells += 300; giveXp(room, 2000); room.boss = null; room.phase = 'won';
    say(room, 'Сервер', 'Моргарт повержен. Игра пройдена!');
    return;
  }
  if (!room.boss && room.foes.length === 0 && room.spawnLeft === 0) {
    room.phase = 'clear'; room.timer = 190;
    giveXp(room, 40 + room.level * 6);
    questTick(room, 'clear', 1);
    if (room.hitless) questTick(room, 'nohit', 1);
    addQuest(room);
    say(room, 'Сервер', 'Уровень ' + room.level + ' пройден.');
    broadcast(room, lobbyState(room));
    return;
  }
  if (room.heroes.every(h => h.down)) {
    room.phase = 'dead'; room.timer = 260; room.level = 1;
    room.quests.forEach(q => { if (q.k === 'clear') q.p = 0; });
    say(room, 'Сервер', 'Забег окончен. Опыт и клетки сохранены.');
  }
  if (room.tick % 1000 === 0) {
    const bots = room.heroes.filter(h => !h.owner && !h.down);
    if (bots.length) say(room, bots[Math.floor(Math.random()*bots.length)].c.name,
      BOT_LINES[Math.floor(Math.random()*BOT_LINES.length)]);
  }
}

/* ===================== сеть ===================== */
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(room, o) { const s = JSON.stringify(o); room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(s); }); }
function say(room, who, text) { broadcast(room, { t:'chat', who, text }); }

function lobbyState(room) {
  const lv = {}, xp = {}, nx = {};
  ORDER.forEach(k => { const l = levelOf(room.xp[k]); lv[k] = l;
    let acc = 0; for (let i = 1; i < l; i++) acc += xpNeed(i);
    xp[k] = room.xp[k] - acc; nx[k] = xpNeed(l); });
  return { t:'lobby', code:room.code, phase:room.phase, level:room.level, best:room.best,
    cells:room.cells, up:room.up, lv, xp, nx, quests:room.quests,
    slots: ORDER.map(k => {
      const h = room.heroes.find(x => x.key === k);
      const p = h && h.owner ? room.players.get(h.owner) : null;
      return { key:k, name:CLASSES[k].name, role:CLASSES[k].role, taken:!!p, by:p ? p.name : 'бот' };
    }),
    players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, cls:p.cls, slots:p.slots }))
  };
}
function snapshot(room) {
  const s = { t:'s', ph:room.phase, lv:room.level, tm:Math.ceil(room.timer/60), cl:room.cells,
    en: room.boss ? -1 : room.foes.length + room.spawnLeft, pl:room.plats,
    h: room.heroes.map(h => ({ k:h.key, x:Math.round(h.x), y:Math.round(h.y), f:h.face, l:h.lv,
        hp:Math.round(h.hp), mx:Math.round(h.max), dn:h.down?1:0, rt:Math.ceil(h.rt/60),
        sh:h.shield>0?1:0, g:h.onGround?1:0, o:h.owner || 0,
        rl:h.roll>0?1:0, sw:h.swing, cb:h.combo, iv:h.inv>0?1:0,
        cd:h.cds.slice(), sl:h.slots.slice() })),
    f: room.foes.map(f => ({ i:f.id, t:f.type, x:Math.round(f.x), y:Math.round(f.y), f:f.face,
        v:f.inv?1:0, z:f.frz>0?1:0, hp:Math.round(f.hp), mx:Math.round(f.max) })),
    p: room.shots.map(q => ({ i:q.id, x:Math.round(q.x), y:Math.round(q.y), r:q.r, c:q.c })),
    x: room.fx };
  if (room.boss) s.b = { x:Math.round(room.boss.x), y:Math.round(room.boss.y), f:room.boss.face,
                         hp:Math.round(room.boss.hp), mx:Math.round(room.boss.max), ph:room.boss.phase };
  room.fx = [];
  return s;
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('room') || 'ENVELL').toUpperCase().slice(0, 12);
  const name = (url.searchParams.get('name') || 'Игрок').slice(0, 14);
  const room = roomOf(code);

  if (room.players.size >= 5) { send(ws, { t:'full' }); ws.close(); return; }
  if (room.heroes.length === 0) buildLevel(room);

  const player = { id:uid++, name, ws, cls:null, slots:[0,1,2,3,4],
                   in:{ dx:0, jump:false, atk:false, roll:false, use:-1 } };
  room.players.set(player.id, player);

  send(ws, { t:'hello', id:player.id, code, classes:CLASSES, order:ORDER, abil:ABIL, W, H });
  broadcast(room, lobbyState(room));
  say(room, 'Сервер', name + ' в комнате (' + room.players.size + '/5)');

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'pick') {
      if (!ORDER.includes(m.cls)) return;
      const h = room.heroes.find(x => x.key === m.cls);
      if (!h || (h.owner && h.owner !== player.id)) return;
      const old = room.heroes.find(x => x.owner === player.id);
      if (old) old.owner = null;
      h.owner = player.id; h.slots = player.slots; player.cls = m.cls;
      broadcast(room, lobbyState(room));
    } else if (m.t === 'equip') {
      if (!Array.isArray(m.slots)) return;
      player.slots = m.slots.slice(0, 5).map(v => (v === null || v === undefined) ? null : Math.max(0, Math.min(99, v|0)));
      while (player.slots.length < 5) player.slots.push(null);
      const h = room.heroes.find(x => x.owner === player.id);
      if (h) h.slots = player.slots;
      broadcast(room, lobbyState(room));
    } else if (m.t === 'start') {
      if (room.phase === 'lobby' || room.phase === 'won' || room.phase === 'dead') {
        room.level = Math.max(1, Math.min(100, parseInt(m.level, 10) || 1));
        room.diff  = [0.75, 1, 1.4].includes(m.diff) ? m.diff : 1;
        room.phase = 'play'; buildLevel(room);
        broadcast(room, lobbyState(room));
        say(room, 'Сервер', 'Старт. Уровень ' + room.level + '.');
      }
    } else if (m.t === 'in') {
      player.in.dx = Math.max(-1, Math.min(1, +m.dx || 0));
      if (m.j) player.in.jump = true;
      if (m.k) player.in.atk = true;
      if (m.r) player.in.roll = true;
      if (m.u !== undefined && m.u >= 0 && m.u < 5) player.in.use = m.u|0;
    } else if (m.t === 'buy') {
      if (room.cells >= 25 && (m.what === 'hp' || m.what === 'dmg')) {
        room.cells -= 25; room.up[m.what]++;
        say(room, 'Сервер', player.name + ': отряд усилен (' + (m.what === 'hp' ? 'здоровье' : 'урон') + ' +12%)');
        broadcast(room, lobbyState(room));
      }
    } else if (m.t === 'chat' && typeof m.text === 'string') {
      say(room, player.name, m.text.slice(0, 80));
    } else if (m.t === 'menu') {
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

let net = 0;
setInterval(() => {
  net++;
  rooms.forEach(room => {
    tickRoom(room);
    if (net % 3 === 0 && room.players.size) broadcast(room, snapshot(room));
  });
}, 1000 / 60);

server.listen(PORT, () => console.log('Энвелл-сервер работает на порту ' + PORT));
