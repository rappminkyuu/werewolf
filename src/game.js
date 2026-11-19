// ============================================================
//  WEREWOLF WEB — engine game
//  Logika role, skill malam, voting, dll DIPINDAH dari game-werewolf.js
//  (versi WhatsApp). Yang diganti hanya "lapisan transport":
//  polling WA -> pilihan di layar (Socket.IO), PM bot -> pesan pribadi, grup -> room.
// ============================================================
import crypto from 'crypto'
import { ROLES, TEAM_NAME } from './roles.js'
import * as DB from './db.js'

export const SPEED = Number(process.env.WW_SPEED || 1) // hanya untuk testing
export const CFG = { MIN: 6, MAX: 15, EXT_MIN: 10, HEAD_MS: 45000, DAY_MS: 90000, VOTE_MS: 45000, NIGHT_MS: 60000, NIGHT_P1_MS: 40000, SHOT_MS: 25000 }
export const rooms = {} // kode -> room
export const polls = new Map() // pollId -> poll
export const hooks = { roomsChanged() {} }
let io = null
export const initIO = (i) => { io = i }

const NONE = '__none__'
const bar = '━━━━━━━━━━━━━━━━'
const num = (j = '') => String(j)
const same = (a, b) => !!a && !!b && String(a) === String(b)
const uniq = (arr) => [...new Set(arr)]
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)]
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
const secs = (ms) => Math.round(ms / 1000)
export const getP = (room, jid) => room.players.find((p) => same(p.jid, jid))
const alive = (room) => room.players.filter((p) => p.alive)
const roleOf = (p) => ROLES[p.role]
const isWolf = (p) => p.role === 'werewolf' && p.team === 'wolf'
const tag = (p) => p.name
const mentionsOf = (list) => list.map((p) => p.jid)
const label = (p) => `${p.no}. ${p.name}`.slice(0, 40)
const roomOf = (jid) => Object.values(rooms).find((r) => r.players.some((p) => same(p.jid, jid) && !p.left))
export const roomOfUser = roomOf
const toUser = (uid, ev, data) => io && io.to('u:' + uid).emit(ev, data)

// ---------------------------- LOG / CHAT / STATE ----------------------------
function addLog(room, entry, vis) {
  entry.t = Date.now(); entry.phase = room.phase; entry.night = room.night; entry.vis = vis
  room.log.push(entry)
  const { vis: _v, ...out } = entry
  for (const uid of vis) toUser(uid, 'chat:msg', out)
}
// to = kode room (pesan umum) atau uid pemain (pesan pribadi)
export function say(conn, to, text) {
  const room = rooms[to] || roomOf(to)
  if (!room || room.dead) return null
  if (rooms[to]) addLog(room, { ch: 'main', kind: 'sys', text }, room.players.map((p) => p.jid))
  else addLog(room, { ch: 'pm', kind: 'sys', text, to }, [to])
  schedulePush(room)
  return true
}
export function historyFor(room, uid) {
  return room.log.filter((e) => e.vis.includes(uid)).slice(-400).map(({ vis, ...e }) => e)
}

function canChat(room, p, ch) {
  if (room.dead) return false
  if (room.state === 'lobby') return ch === 'main' // di lobby semua pemain bebas ngobrol
  if (room.state !== 'play') return false
  const ph = room.phase
  if (ch === 'main') return p.alive && ['head', 'day', 'vote'].includes(ph) && !(['day', 'vote'].includes(ph) && room.silenced && room.silenced.has(num(p.jid)))
  if (ch === 'wolf') return p.alive && p.team === 'wolf' && ph === 'night'
  if (ch === 'hyp') return p.alive && p.team === 'hyp' && ph === 'night'
  if (ch === 'lovers') return p.alive && !!p.lover && ph === 'night'
  if (ch === 'dead') return !p.alive
  return false
}
const audience = (room, ch) => room.players.filter((p) => {
  if (ch === 'main') return true
  if (ch === 'wolf') return p.team === 'wolf'
  if (ch === 'hyp') return p.team === 'hyp'
  if (ch === 'lovers') return !!p.lover
  if (ch === 'dead') return !p.alive
  return false
}).map((p) => p.jid)

export function chatSend(room, p, ch, text) {
  text = String(text || '').trim().slice(0, 300)
  if (!text) return 'Pesan kosong'
  if (!p || !canChat(room, p, ch)) return 'Chat ini sedang ditutup'
  addLog(room, { ch, kind: 'chat', uid: p.jid, name: p.name, text }, audience(room, ch))
  return null
}

function viewOf(room, p) {
  const play = room.state === 'play'
  const v = {
    code: room.code, isPublic: room.isPublic, state: room.state, phase: room.phase, night: room.night,
    music: room.music || null, queuedN: room.players.filter((x) => x.queue && !x.alive && !x.left).length,
    endsAt: room.endsAt || 0, now: Date.now(), host: room.host, head: room.head, min: CFG.MIN, max: CFG.MAX, aliveN: alive(room).length,
    players: room.players.map((x) => ({
      uid: x.jid, no: x.no, name: x.name, av: x.av || 0, alive: x.alive, online: x.online !== false, left: !!x.left,
      role: play && (!x.alive || x === p) ? x.role : undefined, rl: play && x.role && (!x.alive || x === p) ? `${ROLES[x.role].emoji} ${ROLES[x.role].name}` : undefined, cause: !x.alive ? x.cause : undefined,
    })),
  }
  if (!play || !p.role) return v
  const r = ROLES[p.role]
  v.me = {
    uid: p.jid, alive: p.alive, role: p.role, roleName: r.name, emoji: r.emoji, team: TEAM_NAME[p.team], desc: r.desc,
    mates: p.team === 'wolf' ? room.players.filter((w) => w !== p && w.team === 'wolf').map((w) => ({ name: w.name, role: ROLES[w.role].name })) : undefined,
    target: p.role === 'executioner' && p.target ? getP(room, p.target)?.name : undefined,
    lover: p.lover ? getP(room, p.lover)?.name : undefined,
    potion: p.role === 'witch' ? room.potion : undefined,
    queue: !!p.queue,
  }
  const chs = [{ id: 'main', label: '🏘️ Desa' }]
  if (p.team === 'wolf') chs.push({ id: 'wolf', label: '🐺 Serigala' })
  if (p.team === 'hyp') chs.push({ id: 'hyp', label: '🌀 Hipnotis' })
  if (p.lover) chs.push({ id: 'lovers', label: '💘 Pasangan' })
  if (!p.alive) chs.push({ id: 'dead', label: '💀 Arwah' })
  v.channels = chs.map((c) => ({ ...c, open: canChat(room, p, c.id) }))
  v.polls = [...polls.values()].filter((q) => q.chat === room.chat && !q.ballot.closed && (q.to === room.chat || q.to === p.jid)).map((q) => ({
    id: q.id, title: q.title, options: q.options, pub: q.to === room.chat, my: q.ballot.votes.get(num(p.jid))?.value ?? null,
    votes: q.to === room.chat ? [...q.ballot.votes].map(([uid, x]) => ({ who: getP(room, uid)?.name, value: x.value })) : undefined,
  }))
  return v
}
export function pushState(room) {
  if (room.dead) return
  for (const p of room.players) if (!p.left) toUser(p.jid, 'state', viewOf(room, p))
}
function schedulePush(room) {
  if (room._pp) return
  room._pp = setTimeout(() => { room._pp = null; pushState(room) }, 40)
}

// ---------------------------- WAKTU / POLLING (versi web) ----------------------------
function wait(room, ms) {
  return new Promise((res) => {
    room._res = () => { room.early = null; res() }
    room._t = setTimeout(room._res, ms / SPEED)
    room.endsAt = Date.now() + ms / SPEED
    pushState(room)
  })
}
export function halt(room, reason) {
  room.dead = true
  clearTimeout(room._t); clearTimeout(room._pp)
  room._res?.()
  for (const id of room.pollIds) polls.delete(id)
  if (rooms[room.chat] === room) delete rooms[room.chat]
  if (reason) for (const p of room.players) toUser(p.jid, 'room:closed', { reason })
  hooks.roomsChanged()
}
// to = room.chat -> semua pemain; to = uid -> satu pemain
async function sendPoll(conn, room, to, title, options, ballot) {
  const id = crypto.randomBytes(6).toString('hex')
  polls.set(id, { id, chat: room.chat, to, title, options: options.map((o) => ({ label: o.label, value: o.value })), ballot })
  room.pollIds.push(id)
  ballot.pollIds.push(id)
  schedulePush(room)
}
const closeBallot = (ballot) => {
  let room = null
  for (const id of ballot.pollIds) { const q = polls.get(id); if (q) room = rooms[q.chat] || room; polls.delete(id) }
  ballot.closed = true
  if (room) schedulePush(room)
}
// dipanggil dari socket: pemain memilih / membatalkan pilihan. return pesan error atau null
export async function vote(uid, pollId, value) {
  const poll = polls.get(pollId)
  if (!poll) return 'Pilihan sudah ditutup'
  const room = rooms[poll.chat]
  const p = room && getP(room, uid)
  if (!p || room.dead) return 'Room tidak ditemukan'
  if (poll.to !== room.chat && poll.to !== p.jid) return 'Bukan pilihanmu'
  const b = poll.ballot
  if (b.closed || !b.canVote(p)) return 'Kamu tidak bisa memilih sekarang'
  const key = num(p.jid)
  const prev = b.votes.get(key)
  if (value == null || value === NONE) {
    if (prev && prev.pollId === poll.id) { b.votes.delete(key); await b.onChange?.(p, prev.value, undefined) }
  } else {
    if (!poll.options.some((o) => o.value === value)) return 'Opsi tidak valid'
    const err = b.check(p, value)
    if (err) { say(null, p.jid, err); return err }
    if (prev && prev.value === value && prev.pollId === poll.id) return null
    b.votes.set(key, { pollId: poll.id, value })
    await b.onChange?.(p, prev?.value, value)
  }
  schedulePush(room)
  if (room.early && room.early()) { clearTimeout(room._t); room._res?.() }
  return null
}


function listText(room) {
  const lines = room.players.map((p) => {
    const crown = same(p.jid, room.host) && room.state === 'lobby' ? ' 🔰host' : ''
    const head = room.head && same(p.jid, room.head) ? ' 👑' : ''
    if (room.state === 'lobby') return `${p.no}. ${tag(p)}${crown}`
    return p.alive ? `${p.no}. ${tag(p)}${head} — ✅ hidup` : `${p.no}. ${tag(p)} — 💀 ${roleOf(p).emoji} ${roleOf(p).name}`
  })
  const head = room.state === 'lobby' ? `👥 *Pemain di room* (${room.players.length}/${CFG.MAX})` : `👥 *Pemain* — hidup ${alive(room).length}/${room.players.length}`
  return `${head}\n\n${lines.join('\n')}`
}

const WOLF_SUP = ['illusionist', 'puppeteer', 'silencer', 'blackmailer', 'framer', 'trickster', 'poisoner']
const EXT_POOL = ['cupid', 'swapster', 'bodyguard', 'detective', 'spy', 'thief', 'hunter', 'avenger', 'plague', 'necromancer', 'phantom', 'amnesiac', 'gambler', 'mayor', 'joker', 'survivor', 'executioner', 'hipnotis', 'arsonist']
const SOLO_KILL = ['hipnotis', 'arsonist']

function makeRoles(n) {
  const wolves = n >= 10 ? 3 : 2
  const roles = [...Array(wolves).fill('werewolf'), 'seer', 'guard']
  if (n >= 8) roles.push('witch')
  if (n < CFG.EXT_MIN) {
    // di bawah batas: role dasar saja
    while (roles.length < n) roles.push('villager')
    return shuffle(roles)
  }
  // mode role tambahan: 1 slot serigala bisa diganti role pendukung (selalu sisa >= 2 werewolf)
  if (Math.random() < 0.75) roles[0] = rand(WOLF_SUP)
  const slots = n - roles.length
  const villagers = Math.max(1, Math.round(slots / 3))
  const pick = []
  let solo = 0
  for (const k of shuffle(EXT_POOL)) {
    if (pick.length >= slots - villagers) break
    if (SOLO_KILL.includes(k)) {
      if (solo >= 1) continue
      solo++
    }
    pick.push(k)
  }
  roles.push(...pick)
  while (roles.length < n) roles.push('villager')
  return shuffle(roles)
}

// set role + state awal sebuah pemain
function assignRole(room, p, role) {
  p.role = role
  p.team = ROLES[role].team
  p.use = {}
  if (role === 'arsonist') p.doused = new Set()
  if (role === 'executioner') initExecutioner(room, p)
}

// pilih target rahasia Executioner (bukan serigala, bukan dirinya)
function initExecutioner(room, p) {
  const cand = room.players.filter((x) => x !== p && x.alive && x.team !== 'wolf' && x.role !== 'executioner')
  if (cand.length) p.target = rand(cand).jid
  else {
    p.role = 'villager'
    p.team = 'village'
  }
}

function compositionText(room) {
  const count = {}
  for (const p of room.players) count[p.role] = (count[p.role] || 0) + 1
  return Object.keys(ROLES)
    .filter((k) => count[k])
    .map((k) => `${ROLES[k].emoji} ${ROLES[k].name}: ${count[k]}`)
    .join('\n')
}

async function sendRolePM(conn, room, p, head) {
  const r = roleOf(p)
  let text = `${head || `${r.emoji} *ROLE KAMU: ${r.name.toUpperCase()}*`}\n${bar}\n${r.desc}`
  if (p.team === 'wolf') {
    const mates = room.players
      .filter((w) => w !== p && w.team === 'wolf')
      .map((w) => `• ${label(w)}${w.role !== 'werewolf' ? ` (${ROLES[w.role].name})` : ''}`)
    text += `\n\n🐺 *Rekan tim serigala:*\n${mates.length ? mates.join('\n') : '(kamu sendirian)'}`
  }
  if (p.role === 'executioner' && p.target) text += `\n\n🎯 *Target rahasiamu:* ${getP(room, p.target)?.name}`
  text += `\n\n🤫 Jangan beri tahu siapa pun role-mu. Aksi malam akan muncul di tab *Aksi*.`
  await say(conn, p.jid, text)
}

async function sendRolePMs(conn, room) {
  for (const p of room.players) await sendRolePM(conn, room, p)
}

const isKillerSide = (p) => p.role === 'arsonist' || p.team === 'hyp'

function checkWinner(room) {
  const a = alive(room)
  if (!a.length) return 'none'
  if (room.lovers && a.length === 2 && a.every((p) => p.lover)) return 'lovers'
  const wolfN = a.filter((p) => p.team === 'wolf').length
  const killers = a.filter(isKillerSide)
  if (wolfN === 0 && killers.length === 0) return 'village'
  if (wolfN > 0 && wolfN >= a.length - wolfN) return 'wolf'
  if (wolfN === 0 && killers.length === a.length) {
    if (a.every((p) => p.team === 'hyp')) return 'hyp'
    if (a.every((p) => p.role === 'arsonist')) return 'arsonist'
  }
  return null
}

async function checkEnd(conn, room) {
  const side = checkWinner(room)
  if (!side) return false
  await finish(conn, room, side)
  return true
}

// ballot = kotak suara satu fase
function newBallot(opts) {
  return {
    votes: new Map(), // numPemilih -> { pollId, value }
    pollIds: [],
    closed: false,
    canVote: () => true, // (player) => bool
    check: () => null, // (player, value) => pesan error | null
    onChange: null, // (player, prevValue, newValue)
    ...opts,
  }
}

// hitung pilihan setiap pemain (value atau undefined)
const choiceOf = (ballot, p) => ballot.votes.get(num(p.jid))?.value

function kill(room, p, cause) {
  if (!p || !p.alive) return false
  p.alive = false
  p.cause = cause || 'unknown'
  return true
}

const CAUSE_NOTE = {
  love: ' 💔 (ikut mati karena pasangannya)',
  shot: ' 🏹 (tertembak Hunter)',
  revenge: ' ⚔️ (dibawa mati Avenger)',
  'gamble-fail': ' 🎰 (salah tebak)',
  gamble: ' 🎰 (korban tebakan Gambler)',
  guard: ' 💂 (mengorbankan diri sebagai Bodyguard)',
  fire: ' 🔥 (terbakar)',
}
const deathLine = (d) => `💀 ${tag(d.p)} — ${roleOf(d.p).emoji} *${roleOf(d.p).name}*${CAUSE_NOTE[d.cause] || ''}`

const pmq = (room, to, text) => {
  room.pm = room.pm || []
  room.pm.push({ to, text })
}
async function flushPM(conn, room) {
  const list = room.pm || []
  room.pm = []
  for (const x of list) await say(conn, x.to, x.text)
}
const pubq = (room, text) => {
  room.pub = room.pub || []
  room.pub.push(text)
}
const takePub = (room) => {
  const t = (room.pub || []).join('\n')
  room.pub = []
  return t
}

// Efek instan akibat kematian: pasangan ikut mati, Joker/Executioner, pengikut Hipnotis bebas.
// list = [{ p, cause, voters? }] yang sudah di-kill. Return: semua kematian (termasuk tambahan).
function cascade(room, list) {
  const all = [...list]
  for (let i = 0; i < all.length; i++) {
    const d = all[i]
    const p = d.p
    if (p.lover) {
      const partner = getP(room, p.lover)
      if (partner && partner.alive) {
        kill(room, partner, 'love')
        all.push({ p: partner, cause: 'love' })
      }
    }
    if (p.role === 'hipnotis') {
      for (const x of room.players) if (x !== p && x.team === 'hyp') x.team = ROLES[x.role].team
    }
    if (p.role === 'joker' && d.cause === 'vote' && !p.won) {
      p.won = true
      pubq(room, `🃏 *JOKER MENANG!* ${tag(p)} berhasil membuat dirinya digantung. Warga telah tertipu! (Game tetap lanjut.)`)
    }
    for (const x of room.players) {
      if (x.role === 'executioner' && x.alive && x.target && same(x.target, p.jid)) {
        if (d.cause === 'vote') {
          x.won = true
          pubq(room, `🎯 *EXECUTIONER MENANG!* ${tag(x)} berhasil membuat targetnya digantung. (Game tetap lanjut.)`)
          x.target = null
        } else {
          x.role = 'villager'
          x.team = 'village'
          x.target = null
          pmq(room, x.jid, '🎯 Targetmu mati bukan karena digantung, jadi tujuanmu gagal. Kamu kini menjadi *Warga* biasa.')
        }
      }
    }
  }
  return all
}

async function runTriggers(conn, room, deaths) {
  const out = []
  const queue = [...deaths]
  while (queue.length && !room.dead) {
    const d = queue.shift()
    const p = d.p
    let pool = null
    let cause = null
    let title = ''
    let intro = ''
    if (p.role === 'hunter') {
      pool = alive(room)
      cause = 'shot'
      title = '🏹 Tembak siapa?'
      intro = `🏹 *KAMU MATI, TAPI MASIH BISA MENEMBAK!*\nPilih 1 pemain yang kamu tembak lewat tab Aksi.\n⏳ ${secs(CFG.SHOT_MS)} detik. Tidak memilih = tidak menembak.`
    } else if (p.role === 'avenger' && d.cause === 'vote') {
      const voters = (d.voters || []).filter((x) => x.alive)
      pool = voters.length ? voters : alive(room)
      cause = 'revenge'
      title = '⚔️ Bawa siapa mati bersamamu?'
      intro = `⚔️ *BALAS DENDAM!*\nPilih 1 pemain ${voters.length ? 'yang tadi memilihmu ' : ''}untuk ikut mati lewat tab Aksi.\n⏳ ${secs(CFG.SHOT_MS)} detik. Tidak memilih = tidak membalas.`
    }
    if (!pool || !pool.length) continue
    const ballot = newBallot({ canVote: (q) => q === p })
    await say(conn, room.chat, `${roleOf(p).emoji} ${tag(p)} adalah *${roleOf(p).name}* dan kini sedang memilih targetnya... ⏳ ${secs(CFG.SHOT_MS)} detik.`, [p.jid])
    await say(conn, p.jid, intro)
    await sendPoll(conn, room, p.jid, title, pool.map((x) => ({ label: label(x), value: x.jid })), ballot)
    await wait(room, CFG.SHOT_MS)
    if (room.dead) return out
    closeBallot(ballot)
    const t = choiceOf(ballot, p)
    const target = t ? getP(room, t) : null
    if (target && target.alive) {
      kill(room, target, cause)
      const chain = cascade(room, [{ p: target, cause }])
      out.push(`${roleOf(p).emoji} ${tag(p)} memilih ${tag(target)}!`)
      for (const c of chain) out.push(deathLine(c))
      queue.push(...chain)
    } else {
      out.push(`${roleOf(p).emoji} ${tag(p)} tidak sempat memilih target.`)
    }
  }
  await flushPM(conn, room)
  return out
}

async function runHeadElection(conn, room) {
  room.phase = 'head'
  const ballot = newBallot({
    canVote: (p) => p.alive,
  })
  room.ballot = ballot
  room.early = () => alive(room).filter((p) => ballot.canVote(p)).every((p) => ballot.votes.has(num(p.jid)))
  await say(
    conn,
    room.chat,
    `👑 *PEMILIHAN KEPALA DESA*
${bar}
Sebelum malam pertama, warga desa harus memilih pemimpin. Kepala desa punya *suara 2x* saat voting siang.

🗳️ Pilih lewat *tab Aksi* (tinggal tap nama, tidak perlu mengetik).
⏳ Waktu: *${secs(CFG.HEAD_MS)} detik*

⚠️ Pilih dengan bijak... siapa tahu seekor serigala menyamar jadi pemimpin 😈`,
    mentionsOf(room.players)
  )
  await sendPoll(conn, room, room.chat, '👑 Pilih Kepala Desa', room.players.map((p) => ({ label: label(p), value: p.jid })), ballot)
  await wait(room, CFG.HEAD_MS)
  if (room.dead) return
  closeBallot(ballot)

  // hitung
  const tally = new Map()
  for (const { value } of ballot.votes.values()) tally.set(value, (tally.get(value) || 0) + 1)
  let winner
  let note = ''
  if (!tally.size) {
    winner = rand(room.players)
    note = 'Tidak ada yang memilih, jadi bot menunjuk kepala desa secara acak.'
  } else {
    const top = Math.max(...tally.values())
    const tied = [...tally].filter(([, c]) => c === top).map(([j]) => getP(room, j))
    winner = rand(tied)
    if (tied.length > 1) note = `Suara seri (${tied.length} kandidat), pemenang diundi oleh bot.`
  }
  room.head = winner.jid
  const result = [...tally]
    .sort((a, b) => b[1] - a[1])
    .map(([j, c]) => `• ${tag(getP(room, j))} — ${c} suara`)
    .join('\n')
  await say(
    conn,
    room.chat,
    `🎊 *KEPALA DESA TERPILIH!*
${bar}
${result ? result + '\n\n' : ''}${note ? note + '\n\n' : ''}👑 Selamat kepada ${tag(winner)} yang kini menjadi *Kepala Desa*! Suaramu bernilai 2x saat voting siang.

🏘️ Untuk seluruh warga: *tetap waspada!* Tidak semua kepala desa itu baik, bisa jadi dia justru serigala berbulu domba 🐺🐑`,
    mentionsOf(room.players)
  )
  await wait(room, 4000)
}

const optsOf = (list) => list.map((p) => ({ label: label(p), value: p.jid }))
const others = (room, p) => alive(room).filter((x) => x !== p)
const single = (intro, title, list, id) => (list.length ? { intro, polls: [{ id: id || 't', title, options: optsOf(list) }] } : null)
const pair = (intro, ta, la, tb, lb) => (la.length && lb.length ? { intro, pair: true, polls: [{ id: 'a', title: ta, options: optsOf(la) }, { id: 'b', title: tb, options: optsOf(lb) }] } : null)
const nUse = (p, k) => p.use[k] || 0

const SKILLS = {
  seer: (room, p) => single('🔮 *GILIRAN SEER*\nPilih 1 pemain yang ingin kamu terawang. Hasilnya dikirim menjelang pagi.', '🔮 Terawang siapa?', others(room, p)),
  guard: (room, p) => {
    const last = room.lastGuard ? getP(room, room.lastGuard) : null
    const list = alive(room).filter((x) => !same(x.jid, room.lastGuard))
    return single(`🛡️ *GILIRAN GUARD*\nPilih 1 pemain yang ingin kamu lindungi (boleh dirimu sendiri).${last ? `\n(Tidak bisa memilih ${last.name}, karena kemarin sudah kamu lindungi.)` : ''}`, '🛡️ Lindungi siapa?', list)
  },
  bodyguard: (room, p) => single('💂 *GILIRAN BODYGUARD*\nPilih 1 pemain untuk kamu jaga. Kalau dia diserang, *kamu* yang mati menggantikannya.', '💂 Jaga siapa?', others(room, p)),
  detective: (room, p) => pair('🕵️ *GILIRAN DETECTIVE*\nPilih 2 pemain (dua pilihan). Kamu akan tahu apakah mereka satu kubu atau beda kubu.', '🕵️ Pemain pertama', alive(room), '🕵️ Pemain kedua', alive(room)),
  spy: (room, p) => single('👁️ *GILIRAN SPY*\nPilih 1 pemain. Kamu akan tahu siapa saja yang dia kunjungi malam ini.', '👁️ Intip siapa?', others(room, p)),
  cupid: (room, p) => (room.lovers ? null : pair('💘 *GILIRAN CUPID*\nPilih 2 pemain (dua pilihan) untuk dijadikan *pasangan*. Boleh siapa saja, termasuk dirimu. Kalau satu mati, yang lain ikut mati.', '💘 Pasangan #1', alive(room), '💘 Pasangan #2', alive(room))),
  hipnotis: (room, p) => {
    if (!p.use.recruited) {
      return {
        intro: '🌀 *GILIRAN HIPNOTIS*\nKamu bisa *merekrut 1 pemain acak* (hoki-hokian, bisa warga bisa werewolf), hanya sekali. Sebelum merekrut kamu belum bisa membunuh.',
        polls: [{ id: 'r', title: '🌀 Rekrut sekarang?', options: [{ label: '🌀 Ya, rekrut 1 pemain acak', value: 'yes' }, { label: '⏳ Belum, nanti saja', value: 'no' }] }],
      }
    }
    return single('🌀 *GILIRAN HIPNOTIS*\nKemampuan membunuhmu sudah terbuka. Pilih 1 korban malam ini.', '🌀 Bunuh siapa?', others(room, p).filter((x) => x.team !== 'hyp'))
  },
  illusionist: (room, p) => single('🎭 *GILIRAN ILLUSIONIST*\nPilih 1 pemain. Hasil pemeriksaan Seer/Detective terhadapnya malam ini akan *dibalik*.', '🎭 Ilusi siapa?', others(room, p)),
  puppeteer: (room, p) => pair('🪆 *GILIRAN PUPPETEER*\nPilih 2 pemain (dua pilihan): *boneka* lalu *arah baru*. Aksi 1 target milik boneka akan dibelokkan ke arah baru.', '🪆 Boneka (yang dikendalikan)', others(room, p), '🪆 Arahkan ke siapa?', alive(room)),
  silencer: (room, p) => single('🤐 *GILIRAN SILENCER*\nPilih 1 pemain yang akan dibungkam besok (pesannya dihapus bot).', '🤐 Bungkam siapa?', others(room, p)),
  blackmailer: (room, p) => single('📩 *GILIRAN BLACKMAILER*\nPilih 1 pemain yang tidak boleh ikut voting besok.', '📩 Peras siapa?', others(room, p)),
  framer: (room, p) => single('🖼️ *GILIRAN FRAMER*\nPilih 1 pemain yang akan tampak seperti Werewolf jika diperiksa malam ini.', '🖼️ Jebak siapa?', others(room, p)),
  trickster: (room, p) => (nUse(p, 'trick') < 2 ? single(`🎲 *GILIRAN TRICKSTER* (sisa ${2 - nUse(p, 'trick')}x)\nPilih 1 pemain. Suaranya di voting besok dialihkan ke pemain acak.`, '🎲 Kacaukan suara siapa?', others(room, p)) : null),
  thief: (room, p) => (nUse(p, 'steal') < 1 ? single('🥷 *GILIRAN THIEF* (sekali seumur game)\nPilih 1 pemain, kamu mencuri role-nya dan dia jadi Warga biasa.', '🥷 Curi role siapa?', others(room, p)) : null),
  swapster: (room, p) => (nUse(p, 'swap') < 2 ? pair(`🔄 *GILIRAN SWAPSTER* (sisa ${2 - nUse(p, 'swap')}x)\nPilih 2 pemain (dua pilihan). Aksi malam yang menuju satu pemain akan tertukar ke pemain satunya.`, '🔄 Pemain pertama', alive(room), '🔄 Pemain kedua', alive(room)) : null),
  poisoner: (room, p) => (nUse(p, 'poison') < 2 ? single(`☠️ *GILIRAN POISONER* (sisa ${2 - nUse(p, 'poison')}x)\nPilih 1 pemain untuk diracun. Dia mati pada malam berikutnya.`, '☠️ Racuni siapa?', others(room, p)) : null),
  arsonist: (room, p) => {
    const dz = [...p.doused].map((j) => getP(room, j)).filter((x) => x && x.alive)
    const fresh = others(room, p).filter((x) => !dz.includes(x))
    const options = []
    if (dz.length) options.push({ label: `🔥 BAKAR ${dz.length} pemain yang sudah disiram`, value: 'ignite' })
    for (const x of fresh) options.push({ label: `🛢️ Siram ${label(x)}`.slice(0, 100), value: x.jid })
    if (!options.length) return null
    return { intro: `🔥 *GILIRAN ARSONIST*\nSudah tersiram: ${dz.length ? dz.map((x) => x.name).join(', ') : '-'}\nPilih: siram 1 pemain baru, atau bakar semua yang sudah tersiram.`, polls: [{ id: 't', title: '🔥 Siram / bakar?', options }] }
  },
  plague: (room, p) => (nUse(p, 'plague') < 1 ? single('🦠 *GILIRAN PLAGUE DOCTOR* (sekali seumur game)\nPilih 1 pemain untuk ditulari penyakit. Dia mati 2 malam lagi.', '🦠 Tulari siapa?', others(room, p)) : null),
  necromancer: (room, p) => {
    if (room.night < 2 || nUse(p, 'revive') >= 1) return null
    const list = room.players.filter((x) => !x.alive && x.cause !== 'vote' && x.cause !== 'love' && !x.lover && !x.revived)
    return single('⚰️ *GILIRAN NECROMANCER* (sekali seumur game)\nPilih 1 pemain yang mati di malam hari untuk dihidupkan kembali saat pagi.', '⚰️ Hidupkan siapa?', list)
  },
  phantom: (room, p) => {
    if (p.alive || nUse(p, 'haunt') >= 1) return null
    return single('👻 *ROHMU MASIH BISA MENGHANTUI* (sekali)\nPilih 1 pemain hidup. Kemampuan malamnya diblokir malam ini.', '👻 Hantui siapa?', alive(room))
  },
  amnesiac: (room, p) => {
    if (nUse(p, 'amnesia') >= 1) return null
    const list = room.players.filter((x) => !x.alive && x.role !== 'amnesiac')
    return single('🧠 *GILIRAN AMNESIAC* (sekali seumur game)\nPilih 1 pemain yang sudah mati. Kamu mendapatkan role-nya.', '🧠 Ambil role siapa?', list)
  },
  gambler: (room, p) => {
    if (nUse(p, 'gamble') >= 1) return null
    const others1 = others(room, p)
    const roleOpts = Object.keys(ROLES)
      .filter((k) => room.players.some((x) => x.role === k))
      .map((k) => ({ label: `${ROLES[k].emoji} ${ROLES[k].name}`, value: k }))
    if (!others1.length) return null
    return {
      intro: '🎰 *GILIRAN GAMBLER* (sekali seumur game)\nPilih 1 pemain (pilihan pertama) lalu tebak role-nya (pilihan kedua).\n✅ Benar: dia mati.  ❌ Salah: kamu yang mati.\nTidak memilih salah satunya = batal.',
      polls: [{ id: 't', title: '🎰 Tebak siapa?', options: optsOf(others1) }, { id: 'r', title: '🎰 Tebakan role-nya?', options: roleOpts }],
    }
  },
}

// pilihan satu pemain pada polling `id` (undefined kalau diblokir / tidak memilih)
const val = (room, p, id) => {
  if (room.blocked && room.blocked.has(num(p.jid))) return undefined
  const b = p.nb && p.nb[id]
  return b ? choiceOf(b, p) : undefined
}

async function runNight(conn, room) {
  room.night++
  room.phase = 'night'
  room.silenced = new Set()
  room.blackmail = new Set()
  room.trick = new Set()
  room.frame = new Set()
  room.illu = new Set()
  room.blocked = new Set()
  room.lastRevived = []
  room.pending = room.pending || []
  for (const p of room.players) p.nb = null

  const living = alive(room)
  const wolves = living.filter(isWolf)
  const witch = living.find((p) => p.role === 'witch')
  const witchActive = !!witch && (room.potion.heal || room.potion.poison)
  const p1 = witchActive ? CFG.NIGHT_P1_MS : CFG.NIGHT_MS

  await say(
    conn,
    room.chat,
    `🌙 *MALAM KE-${room.night} TIBA*
${bar}
Desa mendadak sunyi. Lampu-lampu padam, pintu dikunci rapat... Di kegelapan, sesuatu mulai bergerak. 🐾

📩 Yang punya skill malam: buka tab *Aksi* dan pilih.
😴 Yang tidak punya skill cukup tidur & berdoa.
⏳ Waktu: *${secs(CFG.NIGHT_MS)} detik*`
  )

  // ---- polling werewolf (kolektif) ----
  const wolfBallot = newBallot({ canVote: (p) => p.alive && isWolf(p) })
  wolfBallot.onChange = async (p, prev, next) => {
    const mates = alive(room).filter((w) => isWolf(w) && w !== p)
    const name = next ? getP(room, next)?.name : null
    let text
    if (!next) text = `🐺 *${p.name}* membatalkan pilihannya.`
    else if (!prev) text = `🐺 *${p.name}* memilih *${name}* sebagai korban.`
    else text = `🐺 *${p.name}* telah mengganti pilihan ke *${name}*.`
    const wl = alive(room).filter(isWolf)
    const picks = wl.map((w) => choiceOf(wolfBallot, w))
    const all = picks.every(Boolean) && new Set(picks).size === 1
    const status = all ? `✅ Kalian *sepakat*: ${getP(room, picks[0]).name}` : `⚠️ Belum sepakat — semua werewolf harus memilih orang yang sama.`
    for (const w of mates) await say(conn, w.jid, `${text}\n${status}`)
  }
  const wolfTargets = living.filter((p) => p.team !== 'wolf')
  for (const w of wolves) {
    const mates = wolves.filter((x) => x !== w).map((x) => x.name)
    await say(
      conn,
      w.jid,
      `🐺 *GILIRAN WEREWOLF — Malam ke-${room.night}*\nPilih 1 korban lewat tab Aksi.${mates.length ? `\nRekanmu: ${mates.join(', ')}` : ''}\n\n⚠️ Semua werewolf yang hidup harus memilih *orang yang sama*, kalau beda tidak ada yang mati.\n⏳ ${secs(p1)} detik.`
    )
    await sendPoll(conn, room, w.jid, `🐺 Malam ${room.night}: pilih korban`, optsOf(wolfTargets), wolfBallot)
  }

  // ---- skill role lain ----
  const acts = []
  const ghosts = room.players.filter((p) => !p.alive && p.role === 'phantom')
  for (const p of living.concat(ghosts)) {
    const fn = SKILLS[p.role]
    if (!fn) continue
    const spec = fn(room, p)
    if (!spec) continue
    p.nb = {}
    for (const pl of spec.polls) {
      const id = pl.id
      p.nb[id] = newBallot({
        canVote: (q) => q === p,
        check: spec.pair
          ? (q, v) => {
              const o = p.nb[id === 'a' ? 'b' : 'a']
              return o && choiceOf(o, p) === v ? '⚠️ Pilih dua pemain yang *berbeda*.' : null
            }
          : () => null,
      })
    }
    acts.push({ p, role: p.role, spec })
  }
  for (const { p, spec } of acts) {
    await say(conn, p.jid, `${spec.intro}\n\n⏳ ${secs(p1)} detik. Tidak memilih = tidak beraksi.`)
    for (const pl of spec.polls) await sendPoll(conn, room, p.jid, `🌙 Malam ${room.night}: ${pl.title}`, pl.options, p.nb[pl.id])
  }

  // ---- tunggu tahap 1 ----
  await wait(room, p1)
  if (room.dead) return
  closeBallot(wolfBallot)
  for (const { p } of acts) for (const b of Object.values(p.nb)) closeBallot(b)

  // ================= RESOLUSI TAHAP 1 =================
  const actOf = (role) => {
    const a = acts.find((x) => x.role === role)
    return a ? a.p : null
  }
  const has = (p) => !!p
  const dm = (p, text) => say(conn, p.jid, text)

  // 1) Phantom (roh) memblokir kemampuan target
  {
    const ph = actOf('phantom')
    if (ph) {
      const t = val(room, ph, 't')
      const tp = t && getP(room, t)
      if (tp && tp.alive) {
        room.blocked.add(num(tp.jid))
        ph.use.haunt = 1
        await dm(ph, `👻 Kamu menghantui *${tp.name}*. Kemampuannya diblokir malam ini.`)
        await dm(tp, '👻 Sesosok roh menghantuimu semalam... *kemampuan malammu diblokir* malam ini.')
      }
    }
  }

  // 2) Puppeteer & Swapster: tentukan pembelokan target
  let puppet = null
  let puppetTo = null
  {
    const pp = actOf('puppeteer')
    if (pp) {
      const a = getP(room, val(room, pp, 'a'))
      const b = getP(room, val(room, pp, 'b'))
      if (a && b && a !== b && a.alive && b.alive) {
        puppet = a
        puppetTo = b
      }
    }
  }
  let swA = null
  let swB = null
  {
    const sp = actOf('swapster')
    if (sp) {
      const a = getP(room, val(room, sp, 'a'))
      const b = getP(room, val(room, sp, 'b'))
      if (a && b && a !== b && a.alive && b.alive) {
        swA = a
        swB = b
        sp.use.swap = nUse(sp, 'swap') + 1
        await dm(sp, `🔄 Kamu menukar aksi malam antara *${a.name}* dan *${b.name}*.`)
      }
    }
  }
  const redirect = (p, v) => {
    if (!v || v === NONE) return v
    if (!getP(room, v)) return v
    let out = v
    if (puppet && p === puppet && puppetTo) out = puppetTo.jid
    if (swA && swB) {
      if (same(out, swA.jid)) out = swB.jid
      else if (same(out, swB.jid)) out = swA.jid
    }
    return out
  }
  const tg = (p, id) => redirect(p, val(room, p, id || 't'))

  // catatan kunjungan (untuk Spy)
  const visits = {}
  const visit = (actor, t) => {
    if (!actor || !t) return
    const k = num(actor.jid)
    visits[k] = visits[k] || []
    visits[k].push(t.name)
  }
  const act = (role) => {
    const a = actOf(role)
    if (!a) return null
    const v = tg(a, 't')
    const t = v && v !== NONE ? getP(room, v) : null
    if (!t) return null
    visit(a, t)
    return { a, t }
  }

  // 3) Kumpulkan target semua role
  const rSeer = act('seer')
  const rGuard = act('guard')
  const rBody = act('bodyguard')
  const rSpy = act('spy')
  const rIllu = act('illusionist')
  const rFramer = act('framer')
  const rSilence = act('silencer')
  const rBlack = act('blackmailer')
  const rTrick = act('trickster')
  const rThief = act('thief')
  const rPoison = act('poisoner')
  const rPlague = act('plague')
  const rHipKill = act('hipnotis')
  const rNecro = act('necromancer')
  const rAmne = act('amnesiac')
  const rGamb = act('gambler')
  const arsonist = actOf('arsonist')
  const arV = arsonist ? tg(arsonist, 't') : null
  if (arsonist && arV && arV !== 'ignite' && getP(room, arV)) visit(arsonist, getP(room, arV))

  // serangan werewolf
  let victim = null
  let victimPick = null
  {
    const wl = wolves.filter((w) => !room.blocked.has(num(w.jid)))
    const picks = wl.map((w) => {
      const v = choiceOf(wolfBallot, w)
      return puppet && puppet === w && puppetTo && v ? puppetTo.jid : v
    })
    if (wl.length && picks.every(Boolean) && new Set(picks).size === 1) {
      victimPick = getP(room, picks[0])
      victim = getP(room, redirect(null, picks[0]))
    }
    for (const w of wl) {
      if (victim) visit(w, victim)
      await dm(w, victimPick ? `🐺 Malam selesai. Kalian sepakat menyerang *${victimPick.name}*.` : `🐺 Malam selesai. Kalian *tidak sepakat* (atau ada yang tidak memilih), jadi tidak ada korban malam ini.`)
    }
  }

  // 4) Perubahan status: Cupid, Hipnotis (rekrut), Thief, Amnesiac, penanda hari berikutnya
  {
    const cu = actOf('cupid')
    if (cu && !room.lovers) {
      const a = getP(room, val(room, cu, 'a'))
      const b = getP(room, val(room, cu, 'b'))
      if (a && b && a !== b) {
        room.lovers = [a.jid, b.jid]
        a.lover = b.jid
        b.lover = a.jid
        await dm(cu, `💘 Kamu menyatukan *${a.name}* dan *${b.name}* sebagai pasangan.`)
        await dm(a, `💘 *KAMU JATUH CINTA!*\nPasanganmu: *${b.name}* (${roleOf(b).emoji} ${roleOf(b).name}).\nKalau salah satu dari kalian mati, yang lain ikut mati. Kalau tinggal berdua, kalian menang bersama.`)
        await dm(b, `💘 *KAMU JATUH CINTA!*\nPasanganmu: *${a.name}* (${roleOf(a).emoji} ${roleOf(a).name}).\nKalau salah satu dari kalian mati, yang lain ikut mati. Kalau tinggal berdua, kalian menang bersama.`)
      }
    }
    const hp = actOf('hipnotis')
    if (hp && !hp.use.recruited && val(room, hp, 'r') === 'yes') {
      const cands = alive(room).filter((x) => x !== hp && x.team !== 'hyp')
      if (cands.length) {
        const t = rand(cands)
        hp.use.recruited = 1
        t.team = 'hyp'
        await dm(hp, `🌀 Rekrutmen berhasil! *${t.name}* (${roleOf(t).emoji} ${roleOf(t).name}) kini berpihak padamu. Mulai malam berikutnya kamu bisa membunuh.`)
        await dm(t, `🌀 Kamu *direkrut Hipnotis*: *${hp.name}*! Kamu tetap memegang role ${roleOf(t).emoji} ${roleOf(t).name}, tapi kini berpihak pada tim Hipnotis. Menangkan bersama.`)
      }
    }
    if (has(rThief) && rThief.t.alive && rThief.t !== rThief.a) {
      const th = rThief.a
      const tv = rThief.t
      const old = tv.role
      assignRole(room, th, old)
      assignRole(room, tv, 'villager')
      th.use.steal = 1
      await sendRolePM(conn, room, th, `🥷 *KAMU MENCURI ROLE ${ROLES[old].name.toUpperCase()}!*`)
      await dm(tv, '🥷 Rolemu *dicuri* seseorang! Kamu kini menjadi *Warga* biasa.')
      if (th.team === 'wolf') for (const w of room.players) if (w !== th && w.alive && w.team === 'wolf') await dm(w, `🐺 *${th.name}* kini bergabung di tim serigala sebagai ${roleOf(th).emoji} ${roleOf(th).name}.`)
    }
    if (has(rAmne) && !rAmne.t.alive && rAmne.t.role !== 'amnesiac') {
      const am = rAmne.a
      const old = rAmne.t.role
      assignRole(room, am, old)
      am.use.amnesia = 1
      await sendRolePM(conn, room, am, `🧠 *INGATANMU KEMBALI! KAMU KINI ${ROLES[old].name.toUpperCase()}*`)
      if (am.team === 'wolf') for (const w of room.players) if (w !== am && w.alive && w.team === 'wolf') await dm(w, `🐺 *${am.name}* kini bergabung di tim serigala sebagai ${roleOf(am).emoji} ${roleOf(am).name}.`)
    }
    if (has(rFramer)) {
      room.frame.add(num(rFramer.t.jid))
      await dm(rFramer.a, `🖼️ Kamu menjebak *${rFramer.t.name}*.`)
    }
    if (has(rIllu)) {
      room.illu.add(num(rIllu.t.jid))
      await dm(rIllu.a, `🎭 Kamu menciptakan ilusi pada *${rIllu.t.name}*.`)
    }
    if (has(rSilence)) {
      room.silenced.add(num(rSilence.t.jid))
      await dm(rSilence.a, `🤐 *${rSilence.t.name}* akan dibungkam besok.`)
      await dm(rSilence.t, '🤐 Kamu *dibungkam*! Besok kamu tidak boleh bicara di grup (chat-mu dikunci).')
    }
    if (has(rBlack)) {
      room.blackmail.add(num(rBlack.t.jid))
      await dm(rBlack.a, `📩 *${rBlack.t.name}* tidak bisa voting besok.`)
      await dm(rBlack.t, '📩 Kamu *diperas*! Kamu tidak bisa ikut voting besok.')
    }
    if (has(rTrick)) {
      room.trick.add(num(rTrick.t.jid))
      rTrick.a.use.trick = nUse(rTrick.a, 'trick') + 1
      await dm(rTrick.a, `🎲 Suara *${rTrick.t.name}* di voting besok akan diacak.`)
    }
    if (has(rPoison)) {
      rPoison.a.use.poison = nUse(rPoison.a, 'poison') + 1
      room.pending.push({ jid: rPoison.t.jid, dieNight: room.night + 1, kind: 'poison' })
      await dm(rPoison.a, `☠️ Kamu meracuni *${rPoison.t.name}*. Dia mati pada malam berikutnya.`)
      await dm(rPoison.t, '☠️ Kamu merasa mual... *kamu diracun* dan akan mati pada malam berikutnya, kecuali ada yang menyembuhkanmu.')
    }
    if (has(rPlague)) {
      rPlague.a.use.plague = 1
      room.pending.push({ jid: rPlague.t.jid, dieNight: room.night + 2, kind: 'plague' })
      await dm(rPlague.a, `🦠 Kamu menulari *${rPlague.t.name}*. Dia mati 2 malam lagi.`)
      await dm(rPlague.t, '🦠 Kamu *terinfeksi penyakit mematikan*! Kamu akan mati 2 malam lagi, kecuali ada yang menyembuhkanmu.')
    }
    if (arsonist && arV && arV !== 'ignite') {
      const t = getP(room, arV)
      if (t && t.alive) {
        arsonist.doused.add(t.jid)
        await dm(arsonist, `🛢️ Kamu menyiram bensin ke *${t.name}*.`)
      }
    }
  }

  // 5) Hasil informasi: Seer, Detective, Spy
  const apTeam = (p) => {
    const k = num(p.jid)
    if (room.frame.has(k)) return 'wolf'
    if (room.illu.has(k)) return p.team === 'wolf' ? 'village' : 'wolf'
    return p.team
  }
  if (actOf('seer')) {
    const s = actOf('seer')
    if (rSeer) await dm(s, `🔮 *HASIL TERAWANGAN*\n${rSeer.t.name} ${apTeam(rSeer.t) === 'wolf' ? 'adalah 🐺 *WEREWOLF*!' : 'adalah ✅ *BUKAN werewolf*.'}`)
    else await dm(s, '🔮 Kamu tidak menerawang siapa pun malam ini.')
  }
  {
    const dt = actOf('detective')
    if (dt) {
      const a = getP(room, val(room, dt, 'a'))
      const b = getP(room, val(room, dt, 'b'))
      if (a && b && a !== b) {
        visit(dt, a)
        visit(dt, b)
        const sameTeam = apTeam(a) === apTeam(b)
        await dm(dt, `🕵️ *HASIL PENYELIDIKAN*\n${a.name} & ${b.name} berasal dari ${sameTeam ? '✅ *kubu yang SAMA*' : '❌ *kubu yang BERBEDA*'}.`)
      } else await dm(dt, '🕵️ Kamu tidak menyelidiki siapa pun malam ini.')
    }
  }
  if (actOf('spy')) {
    const s = actOf('spy')
    if (rSpy) {
      const v = visits[num(rSpy.t.jid)] || []
      await dm(s, `👁️ *HASIL PENGINTAIAN*\n${rSpy.t.name} ${v.length ? `semalam mengunjungi: *${uniq(v).join(', ')}*.` : 'semalam *tidak mengunjungi siapa pun*.'}`)
    } else await dm(s, '👁️ Kamu tidak mengintai siapa pun malam ini.')
  }
  {
    const g = actOf('guard')
    if (g) await dm(g, rGuard ? `🛡️ Kamu melindungi *${rGuard.t.name}* malam ini.` : '🛡️ Kamu tidak melindungi siapa pun malam ini.')
    const bgp = actOf('bodyguard')
    if (bgp) await dm(bgp, rBody ? `💂 Kamu menjaga *${rBody.t.name}* malam ini.` : '💂 Kamu tidak menjaga siapa pun malam ini.')
  }
  room.lastGuard = rGuard ? rGuard.t.jid : null

  // ================= TAHAP 2: PENYIHIR =================
  const dueNow = (room.pending || []).filter((x) => x.dieNight === room.night && getP(room, x.jid) && getP(room, x.jid).alive)
  const healedJids = new Set()
  let poisonedByWitch = null
  if (witchActive) {
    const w = getP(room, witch.jid)
    const blockedW = room.blocked.has(num(w.jid))
    const healBallot = newBallot({ canVote: (p) => p === w })
    const poisonBallot = newBallot({ canVote: (p) => p === w, check: (p, v) => (same(v, p.jid) ? 'Kamu tidak bisa meracuni dirimu sendiri.' : null) })
    const p2 = CFG.NIGHT_MS - CFG.NIGHT_P1_MS
    const cands = []
    if (victim) cands.push(victim)
    for (const x of dueNow) {
      const xp = getP(room, x.jid)
      if (!cands.includes(xp)) cands.push(xp)
    }
    if (blockedW) {
      await dm(w, '👻 Roh menghantuimu, *kemampuanmu diblokir* malam ini.')
    } else {
      await dm(
        w,
        `🧪 *GILIRAN PENYIHIR — Malam ke-${room.night}*\n` +
          `Korban serangan werewolf: ${victim ? `*${victim.name}*` : '*tidak ada* (werewolf tidak sepakat)'}\n` +
          `${dueNow.length ? `Akan mati karena racun/penyakit malam ini: *${dueNow.map((x) => getP(room, x.jid).name).join(', ')}*\n` : ''}` +
          `Ramuan: 💚 Penyembuh ${room.potion.heal ? '✅ ada' : '❌ habis'} | ☠️ Racun ${room.potion.poison ? '✅ ada' : '❌ habis'}\n\n` +
          `Pilih lewat tab Aksi. *Tidak memilih = tidak memakai ramuan.*\n⏳ ${secs(p2)} detik.`
      )
      if (room.potion.heal && cands.length) {
        await sendPoll(conn, room, w.jid, '💚 Selamatkan siapa?', [...cands.map((c) => ({ label: `💚 Selamatkan ${c.name}`.slice(0, 100), value: c.jid })), { label: '❌ Tidak', value: 'no' }], healBallot)
      }
      if (room.potion.poison) {
        await sendPoll(conn, room, w.jid, '☠️ Racuni siapa? (kosongkan = tidak)', alive(room).filter((p) => p !== w).map((p) => ({ label: label(p), value: p.jid })), poisonBallot)
      }
    }
    await say(conn, room.chat, `🧪 Sesuatu mendidih di sudut desa... malam masih menyisakan *${secs(p2)} detik*.`)
    await wait(room, p2)
    if (room.dead) return
    closeBallot(healBallot)
    closeBallot(poisonBallot)
    if (!blockedW) {
      const hv = choiceOf(healBallot, w)
      if (room.potion.heal && hv && hv !== 'no' && cands.some((c) => same(c.jid, hv))) {
        healedJids.add(num(hv))
        room.potion.heal = false
        await dm(w, `💚 Kamu memakai *Ramuan Penyembuh* untuk ${getP(room, hv).name}.`)
      }
      const pt = choiceOf(poisonBallot, w)
      if (room.potion.poison && pt && pt !== 'no') {
        poisonedByWitch = getP(room, pt)
        room.potion.poison = false
        await dm(w, `☠️ Kamu memakai *Ramuan Racun* pada ${poisonedByWitch.name}.`)
      }
    }
  }

  // ================= HASIL MALAM =================
  const deaths = []
  const addDeath = (p, cause) => {
    if (!p || !p.alive || deaths.some((d) => d.p === p)) return
    deaths.push({ p, cause })
  }
  const guardedT = rGuard ? rGuard.t : null
  const attack = (t, cause) => {
    if (!t || !t.alive) return
    if (guardedT && guardedT === t) return
    if (rBody && rBody.a.alive && rBody.t === t && rBody.a !== t) {
      addDeath(rBody.a, 'guard')
      return
    }
    addDeath(t, cause)
  }
  if (victim && !healedJids.has(num(victim.jid))) attack(victim, 'wolf')
  if (rHipKill) attack(rHipKill.t, 'hip')
  if (arsonist && arV === 'ignite') {
    for (const j of arsonist.doused) {
      const x = getP(room, j)
      if (x && x.alive) addDeath(x, 'fire')
    }
    arsonist.doused = new Set()
  }
  if (has(rGamb)) {
    const guess = val(room, rGamb.a, 'r')
    if (guess) {
      rGamb.a.use.gamble = 1
      if (rGamb.t.role === guess) {
        addDeath(rGamb.t, 'gamble')
        await dm(rGamb.a, `🎰 Tebakanmu *BENAR*! ${rGamb.t.name} memang ${ROLES[guess].emoji} ${ROLES[guess].name}.`)
      } else {
        addDeath(rGamb.a, 'gamble-fail')
        await dm(rGamb.a, `🎰 Tebakanmu *SALAH*. Kamu harus membayarnya dengan nyawamu...`)
      }
    }
  }
  for (const x of dueNow) {
    if (!healedJids.has(num(x.jid))) addDeath(getP(room, x.jid), 'poison')
  }
  room.pending = (room.pending || []).filter((x) => x.dieNight > room.night)
  if (poisonedByWitch) addDeath(poisonedByWitch, 'witch')

  for (const d of deaths) kill(room, d.p, d.cause)

  // Necromancer: hidupkan kembali saat pagi
  if (has(rNecro) && !rNecro.t.alive && !rNecro.t.revived) {
    rNecro.a.use.revive = 1
    rNecro.t.alive = true
    rNecro.t.cause = null
    rNecro.t.revived = true
    room.lastRevived.push(rNecro.t)
    await dm(rNecro.a, `⚰️ Kamu menghidupkan kembali *${rNecro.t.name}*.`)
    await dm(rNecro.t, '⚰️ Kamu *dihidupkan kembali* oleh Necromancer! Rolemu tetap sama.')
  }

  room.lastDeaths = cascade(room, deaths)
}

async function runMorning(conn, room) {
  room.phase = 'morning'
  const deaths = room.lastDeaths || []
  const revived = room.lastRevived || []
  let text = `🌅 *PAGI TELAH TIBA — Hari ke-${room.night}*\n${bar}\nAyam berkokok, matahari mengintip dari balik bukit. Para warga keluar rumah dengan hati berdebar...\n\n`
  if (!deaths.length) {
    text += `🍀 *Keajaiban!* Tidak ada korban tadi malam. Entah serigala sedang tidak kompak, atau ada yang melindungi desa ini...`
  } else {
    text += `😱 *Tadi malam ada korban!*\n${deaths.map(deathLine).join('\n')}\n\nJasad ${deaths.length > 1 ? 'mereka' : 'dia'} ditemukan mengenaskan. Semoga tenang di alam sana 🕯️`
    if (room.head && deaths.some((d) => same(d.p.jid, room.head))) text += `\n\n👑 *Kepala Desa gugur!* Jabatan kosong, suara siapa pun kini bernilai sama.`
  }
  if (revived.length) text += `\n\n⚰️ *KEAJAIBAN!* ${revived.map(tag).join(', ')} bangkit kembali dari kubur!`
  const pub = takePub(room)
  if (pub) text += `\n\n${pub}`
  text += `\n\n👥 Pemain hidup: *${alive(room).length}*`
  await say(conn, room.chat, text, mentionsOf(room.players))
  await flushPM(conn, room)
  const extra = await runTriggers(conn, room, deaths)
  if (extra.length && !room.dead) await say(conn, room.chat, extra.join('\n'), mentionsOf(room.players))
}

async function runDay(conn, room) {
  room.phase = 'day'
  const sil = [...(room.silenced || [])].map((n) => room.players.find((p) => num(p.jid) === n)).filter((p) => p && p.alive)
  await say(
    conn,
    room.chat,
    `☀️ *SIANG HARI — DISKUSI*
${bar}
Saatnya warga berkumpul di balai desa. Siapa yang bertingkah mencurigakan? Siapa yang terlalu pendiam?

💬 Diskusikan dan beri argumenmu!${sil.length ? `\n\n🤐 *Dibungkam hari ini:* ${sil.map(tag).join(', ')}\nChat mereka dikunci .` : ''}
⏳ Voting dimulai dalam *${secs(CFG.DAY_MS)} detik*.

${listText(room)}`,
    mentionsOf(room.players)
  )
  await wait(room, CFG.DAY_MS)
}

const voteWeight = (room, p) => 1 + (room.head && same(p.jid, room.head) ? 1 : 0) + (p.role === 'mayor' ? 1 : 0)

async function runVote(conn, room) {
  if (room.dead) return
  room.phase = 'vote'
  const living = alive(room)
  const ballot = newBallot({
    canVote: (p) => p.alive && !(room.blackmail && room.blackmail.has(num(p.jid))),
    check: (p, v) => (same(v, p.jid) ? '⚠️ Kamu tidak bisa memilih dirimu sendiri. Pilih pemain lain atau opsi lewati.' : null),
  })
  room.ballot = ballot
  room.early = () => alive(room).filter((p) => ballot.canVote(p)).every((p) => ballot.votes.has(num(p.jid)))
  const bm = [...(room.blackmail || [])].map((n) => room.players.find((p) => num(p.jid) === n)).filter((p) => p && p.alive)
  await say(
    conn,
    room.chat,
    `🗳️ *VOTING DIMULAI*
${bar}
Pilih pemain yang akan *digantung* hari ini lewat tab *Aksi* (tinggal tap namanya).
${room.head && getP(room, room.head)?.alive ? `👑 Suara Kepala Desa (${tag(getP(room, room.head))}) bernilai *2x*.\n` : ''}${bm.length ? `📩 Ada pemain yang diperas dan tidak bisa memberi suara hari ini.\n` : ''}Yang paling banyak dipilih akan digantung. Kalau seri atau mayoritas memilih lewati, tidak ada yang digantung.
⏳ Waktu: *${secs(CFG.VOTE_MS)} detik*`,
    mentionsOf(living)
  )
  const opts = [{ label: '⏭️ Lewati (tidak ada yang digantung)', value: 'skip' }, ...living.map((p) => ({ label: label(p), value: p.jid }))]
  await sendPoll(conn, room, room.chat, '🗳️ Siapa yang digantung hari ini?', opts, ballot)
  await wait(room, CFG.VOTE_MS)
  if (room.dead) return
  closeBallot(ballot)

  // hitung dengan bobot
  const tally = new Map()
  const votersFor = new Map() // jid -> [pemilih]
  let tricked = false
  for (const p of alive(room)) {
    let v = choiceOf(ballot, p)
    if (!v) continue
    if (room.trick && room.trick.has(num(p.jid))) {
      const pool = alive(room).filter((x) => x !== p && !same(x.jid, v))
      if (pool.length) {
        v = rand(pool).jid
        tricked = true
      }
    }
    tally.set(v, (tally.get(v) || 0) + voteWeight(room, p))
    if (!votersFor.has(v)) votersFor.set(v, [])
    votersFor.get(v).push(p)
  }
  const lines = [...tally]
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `• ${v === 'skip' ? '⏭️ Lewati' : tag(getP(room, v))} — ${c} suara`)
  let text = `📊 *HASIL VOTING*\n${bar}\n${lines.length ? lines.join('\n') : 'Tidak ada yang memberikan suara.'}\n${tricked ? '\n🎲 Ada suara yang tampak dikacaukan seseorang...\n' : ''}\n`

  let target = null
  if (tally.size) {
    const top = Math.max(...tally.values())
    const leaders = [...tally].filter(([, c]) => c === top).map(([v]) => v)
    if (leaders.length === 1 && leaders[0] !== 'skip') target = getP(room, leaders[0])
    else if (leaders.length > 1) text += '⚖️ Suara *seri*, tidak ada yang digantung.\n'
    else text += '⏭️ Warga memilih untuk melewati voting.\n'
  }
  let deaths = []
  if (target) {
    kill(room, target, 'vote')
    deaths = cascade(room, [{ p: target, cause: 'vote', voters: votersFor.get(target.jid) || [] }])
    text += `⚰️ Warga sepakat menggantung ${tag(target)}...\nDia ternyata adalah ${roleOf(target).emoji} *${roleOf(target).name}*!`
    for (const d of deaths) if (d.p !== target) text += `\n${deathLine(d)}`
    if (room.head && deaths.some((d) => same(d.p.jid, room.head))) text += `\n\n👑 Kepala Desa ikut gugur. Jabatan kosong.`
  } else if (!tally.size) text += '😶 Desa terlalu bingung hingga tidak ada yang digantung.'
  const pub = takePub(room)
  if (pub) text += `\n\n${pub}`
  await say(conn, room.chat, text, mentionsOf(room.players))
  await flushPM(conn, room)
  if (deaths.length) {
    const extra = await runTriggers(conn, room, deaths)
    if (extra.length && !room.dead) await say(conn, room.chat, extra.join('\n'), mentionsOf(room.players))
  }
}

async function runGame(conn, room) {
  try {
    await runHeadElection(conn, room)
    while (!room.dead) {
      await runNight(conn, room)
      if (room.dead) return
      await runMorning(conn, room)
      if (room.dead) return
      if (await checkEnd(conn, room)) return
      await runDay(conn, room)
      if (room.dead) return
      await runVote(conn, room)
      if (room.dead) return
      if (await checkEnd(conn, room)) return
      await wait(room, 3000)
    }
  } catch (e) {
    console.error('[WW] error game:', e)
    await say(conn, room.chat, '⚠️ Terjadi error pada game Werewolf, room dihentikan. Silakan buat room baru.')
    halt(room, 'Terjadi error pada game, room dihentikan.')
  }
}


// ---------------------------- SELESAI GAME ----------------------------
async function finish(conn, room, side) {
  room.phase = 'end'
  const players = room.players
  let winners = []
  let title
  if (side === 'wolf') { winners = players.filter((p) => p.team === 'wolf'); title = '🐺 WEREWOLF MENANG!' }
  else if (side === 'village') { winners = players.filter((p) => p.team === 'village'); title = '🏘️ WARGA MENANG!' }
  else if (side === 'lovers') { winners = players.filter((p) => p.lover); title = '💞 PASANGAN CUPID MENANG!' }
  else if (side === 'hyp') { winners = players.filter((p) => p.team === 'hyp'); title = '🌀 TIM HIPNOTIS MENANG!' }
  else if (side === 'arsonist') { winners = players.filter((p) => p.role === 'arsonist' && p.alive); title = '🔥 ARSONIST MENANG!' }
  else title = '☠️ SEMUA PEMAIN MATI! Tidak ada pemenang.'
  const personal = players.filter((p) => p.won || (p.role === 'survivor' && p.alive))
  const winSet = new Set([...winners, ...personal])
  const reveal = players.map((p) => `${p.no}. ${p.name} — ${roleOf(p).emoji} ${roleOf(p).name} ${p.alive ? '✅' : '💀'}`).join('\n')
  say(conn, room.chat, `${title}\n\n🎭 *Role semua pemain*\n${reveal}`)
  const game = {
    id: room.code + '-' + Date.now().toString(36), startedAt: room.startedAt, endedAt: Date.now(), side, title, nights: room.night,
    players: players.map((p) => ({ uid: p.jid, name: p.name, role: p.role, role0: p.role0, team0: p.team0, rl: `${roleOf(p).emoji} ${roleOf(p).name}`, alive: p.alive, win: winSet.has(p) })),
    uids: players.map((p) => p.jid),
    log: room.log.map(({ vis, ...e }) => e),
  }
  try { await DB.saveGame(game) } catch (e) { console.error('[WW] gagal simpan riwayat:', e) }
  // pemain mati yang pilih "antri main lagi" -> dikumpulkan di lobby baru
  const queued = players.filter((p) => p.queue && !p.left && p.online !== false)
  for (const p of players) toUser(p.jid, 'game:end', { id: game.id, title, side, players: game.players, next: queued.includes(p) })
  halt(room)
  if (queued.length) {
    const mk = (p) => ({ uid: p.jid, username: p.name, avatarAt: p.av })
    const host = queued.find((p) => same(p.jid, room.host)) || queued[0]
    const next = createRoom(mk(host), room.isPublic)
    next.music = room.music || null
    for (const p of queued) if (p !== host) addPlayer(next, mk(p))
  }
}

// ---------------------------- LOBBY ----------------------------
export const publicRooms = () => Object.values(rooms).filter((r) => r.isPublic && r.state === 'lobby').map((r) => ({ code: r.code, host: getP(r, r.host)?.name, count: r.players.length, max: CFG.MAX }))

export function createRoom(user, isPublic) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code
  do code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
  while (rooms[code])
  const room = {
    chat: code, code, isPublic: !!isPublic, host: user.uid, state: 'lobby', phase: 'lobby', players: [], head: null, night: 0,
    potion: { heal: true, poison: true }, lovers: null, pending: [], pm: [], pub: [], silenced: new Set(), blackmail: new Set(), trick: new Set(),
    frame: new Set(), illu: new Set(), blocked: new Set(), lastRevived: [], lastDeaths: [], lastGuard: null, pollIds: [], dead: false, log: [],
  }
  rooms[code] = room
  addPlayer(room, user)
  return room
}
export function addPlayer(room, user) {
  // pemain baru ikut bisa membaca chat lobby yang sudah ada
  for (const e of room.log) if (e.phase === 'lobby' && e.ch === 'main' && !e.vis.includes(user.uid)) e.vis.push(user.uid)
  room.players.push({ jid: user.uid, name: user.username, av: user.avatarAt || 0, no: room.players.length + 1, role: null, alive: true, online: true })
  pushState(room)
  hooks.roomsChanged()
}
export function removePlayer(room, uid) {
  const p = getP(room, uid)
  if (!p || room.state !== 'lobby') return
  room.players = room.players.filter((x) => x !== p)
  room.players.forEach((x, i) => (x.no = i + 1))
  if (!room.players.length) return halt(room)
  if (same(room.host, uid)) room.host = room.players[0].jid
  pushState(room)
  hooks.roomsChanged()
}

export async function startGame(room) {
  room.state = 'play'
  room.startedAt = Date.now()
  hooks.roomsChanged()
  const roles = makeRoles(room.players.length)
  room.players.forEach((p, i) => {
    p.role = roles[i]; p.team = ROLES[p.role].team; p.role0 = p.role; p.team0 = p.team
    p.use = {}; p.lover = null; p.won = false
    if (p.role === 'arsonist') p.doused = new Set()
  })
  for (const p of room.players) if (p.role === 'executioner') initExecutioner(room, p)
  room.phase = 'intro'
  say(null, room.chat, `🐺 *GAME WEREWOLF DIMULAI!*\n${bar}\n👥 ${room.players.length} pemain\n\n🎭 *Susunan role*\n${compositionText(room)}\n\nRole-mu ada di tab Aksi. Jangan bocorkan ke siapa pun!\nPertama, kita pilih *Kepala Desa*...`)
  await sendRolePMs(null, room)
  await wait(room, 10000)
  if (room.dead) return
  runGame(null, room)
}

// pemain keluar saat game berjalan = dianggap mati
export async function playerExit(room, p) {
  p.left = true
  if (!p.alive) { pushState(room); return }
  kill(room, p, 'exit')
  const chain = cascade(room, [{ p, cause: 'exit' }])
  const more = chain.filter((d) => d.p !== p).map(deathLine)
  say(null, room.chat, `🏃 ${p.name} kabur dari desa dan dianggap *mati*.\nDia ternyata ${roleOf(p).emoji} *${roleOf(p).name}*.${more.length ? '\n' + more.join('\n') : ''}`)
  await flushPM(null, room)
  await checkEnd(null, room)
  pushState(room)
}
