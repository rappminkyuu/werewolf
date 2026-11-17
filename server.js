import express from 'express'
import http from 'http'
import crypto from 'crypto'
import { Server } from 'socket.io'
import * as DB from './src/db.js'
import { searchTracks } from './src/music.js'
import { rooms, hooks, initIO, getP, roomOfUser, createRoom, addPlayer, removePlayer, startGame, playerExit, chatSend, vote, pushState, halt, historyFor, publicRooms, CFG } from './src/game.js'

const app = express()
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 3e5 })
initIO(io)
hooks.roomsChanged = () => io.emit('rooms:list', publicRooms())

app.use(express.static('public'))
const avCache = new Map()
app.get('/avatar/:uid', async (req, res) => {
  try {
    let buf = avCache.get(req.params.uid + req.query.v)
    if (!buf) {
      const u = await DB.byId(req.params.uid)
      if (!u?.avatar) return res.sendStatus(404)
      buf = Buffer.from(u.avatar.split(',')[1], 'base64')
      if (avCache.size > 300) avCache.clear()
      avCache.set(req.params.uid + req.query.v, buf)
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }).send(buf)
  } catch { res.sendStatus(404) }
})

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')
const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data })
const fail = (cb, error) => typeof cb === 'function' && cb({ error })

io.on('connection', (socket) => {
  const user = () => socket.data.user
  const myRoom = () => user() && roomOfUser(user().uid)

  async function bind(u, cb) {
    socket.data.user = u
    socket.join('u:' + u.uid)
    ok(cb, { user: u })
    socket.emit('rooms:list', publicRooms())
    const room = roomOfUser(u.uid)
    if (room) {
      const p = getP(room, u.uid)
      p.online = true; clearTimeout(p.leaveT)
      pushState(room)
      socket.emit('chat:history', historyFor(room, u.uid))
    }
  }

  socket.on('auth:register', async ({ username, token } = {}, cb) => {
    username = String(username || '').trim()
    if (!/^[A-Za-z0-9_.-]{3,16}$/.test(username)) return fail(cb, 'Username 3-16 karakter: huruf, angka, _ . -')
    if (String(token || '').length < 32) return fail(cb, 'Token tidak valid')
    try { bind(await DB.createUser(username, sha(token)), cb) }
    catch (e) { fail(cb, e.message === 'USERNAME_TAKEN' ? 'Username sudah dipakai orang lain' : 'Gagal membuat akun') ; if (e.message !== 'USERNAME_TAKEN') console.error(e) }
  })
  socket.on('auth:login', async ({ token } = {}, cb) => {
    const u = token && (await DB.byToken(sha(token)))
    if (!u) return fail(cb, 'Akun tidak ditemukan')
    bind(u, cb)
  })

  // ---- profil, statistik, riwayat ----
  socket.on('profile:me', async (cb) => { const u = user(); if (!u) return; const fresh = await DB.byId(u.uid); socket.data.user = DB.publicUser(fresh); ok(cb, { user: socket.data.user }) })
  socket.on('profile:avatar', async (dataUrl, cb) => {
    const u = user()
    if (!u) return fail(cb, 'Belum masuk')
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 120000) return fail(cb, 'Foto tidak valid / terlalu besar')
    u.avatarAt = await DB.setAvatar(u.uid, dataUrl)
    ok(cb, { avatarAt: u.avatarAt })
  })
  socket.on('lb:get', async (type, cb) => ok(cb, { rows: await DB.leaderboard(type) }))
  socket.on('hist:list', async (cb) => user() && ok(cb, { games: await DB.history(user().uid) }))
  socket.on('hist:get', async (id, cb) => {
    const g = await DB.getGame(String(id))
    if (!g || !user() || !g.uids.includes(user().uid)) return fail(cb, 'Riwayat tidak ditemukan')
    ok(cb, { game: g })
  })

  // ---- room ----
  socket.on('room:create', ({ isPublic } = {}, cb) => {
    if (!user()) return fail(cb, 'Belum masuk')
    if (myRoom()) return fail(cb, 'Kamu masih ada di sebuah room')
    ok(cb, { code: createRoom(user(), isPublic).code })
  })
  socket.on('room:join', ({ code } = {}, cb) => {
    const u = user()
    if (!u) return fail(cb, 'Belum masuk')
    const room = rooms[String(code || '').trim().toUpperCase()]
    if (!room) return fail(cb, 'Room tidak ditemukan')
    const mine = myRoom()
    if (mine && mine !== room) return fail(cb, 'Kamu masih ada di room lain')
    if (!getP(room, u.uid)) {
      if (room.state !== 'lobby') return fail(cb, 'Game di room ini sudah dimulai')
      if (room.players.length >= CFG.MAX) return fail(cb, `Room penuh (maks ${CFG.MAX})`)
      addPlayer(room, u)
    }
    ok(cb, { code: room.code })
  })
  socket.on('room:leave', async (_, cb) => {
    const room = myRoom()
    if (!room) return ok(cb)
    if (room.state === 'lobby') removePlayer(room, user().uid)
    else await playerExit(room, getP(room, user().uid))
    ok(cb)
  })
  // pemain yang sudah mati: antri untuk game berikutnya (tetap bisa nonton)
  socket.on('room:queue', ({ on } = {}, cb) => {
    const room = myRoom()
    if (!room || room.state !== 'play') return fail(cb, 'Kamu tidak sedang dalam game')
    const p = getP(room, user().uid)
    if (!p || p.alive) return fail(cb, 'Antri main lagi hanya untuk pemain yang sudah mati')
    p.queue = !!on
    pushState(room); ok(cb)
  })
  socket.on('room:kick', ({ uid } = {}, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid) return fail(cb, 'Hanya host yang bisa kick')
    if (room.state !== 'lobby') return fail(cb, 'Kick hanya bisa sebelum game mulai')
    if (uid === room.host || !getP(room, uid)) return fail(cb, 'Tidak bisa kick pemain ini')
    removePlayer(room, uid)
    io.to('u:' + uid).emit('room:closed', { reason: 'Kamu dikeluarkan oleh host' })
    ok(cb)
  })
  socket.on('room:start', (_, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid) return fail(cb, 'Hanya host yang bisa memulai')
    if (room.state !== 'lobby') return fail(cb, 'Game sudah berjalan')
    if (room.players.length < CFG.MIN) return fail(cb, `Minimal ${CFG.MIN} pemain (sekarang ${room.players.length})`)
    startGame(room)
    ok(cb)
  })
  socket.on('room:close', (_, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid || room.state !== 'lobby') return fail(cb, 'Tidak bisa menutup room')
    halt(room, 'Room ditutup oleh host')
    ok(cb)
  })

  // ---- lagu (host saja, di lobby) ----
  socket.on('music:search', async ({ q } = {}, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid) return fail(cb, 'Hanya host yang bisa mengatur lagu')
    if (room.state !== 'lobby') return fail(cb, 'Lagu hanya bisa diatur sebelum game mulai')
    try {
      room.musicCands = await searchTracks(q)
      ok(cb, { tracks: room.musicCands.map(({ title, artist, cover, dur }) => ({ title, artist, cover, dur })) })
    } catch (e) { fail(cb, e.message || 'Gagal mencari lagu') }
  })
  socket.on('music:set', ({ i } = {}, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid) return fail(cb, 'Hanya host yang bisa mengatur lagu')
    if (room.state !== 'lobby') return fail(cb, 'Lagu hanya bisa diatur sebelum game mulai')
    const t = room.musicCands?.[Number(i)]
    if (!t) return fail(cb, 'Hasil pencarian sudah kedaluwarsa, cari lagi')
    room.music = t; room.musicCands = null
    pushState(room); ok(cb)
  })
  socket.on('music:clear', (_, cb) => {
    const room = myRoom()
    if (!room || room.host !== user().uid) return fail(cb, 'Hanya host yang bisa mengatur lagu')
    room.music = null; room.musicCands = null
    pushState(room); ok(cb)
  })

  // ---- in-game ----
  socket.on('poll:vote', async ({ id, value } = {}, cb) => { if (!user()) return; const err = await vote(user().uid, id, value); err ? fail(cb, err) : ok(cb) })
  socket.on('chat:send', ({ ch, text } = {}, cb) => {
    const room = myRoom()
    if (!room) return fail(cb, 'Tidak ada room')
    const err = chatSend(room, getP(room, user().uid), ch, text)
    err ? fail(cb, err) : ok(cb)
  })
  socket.on('chat:sync', () => { const room = myRoom(); if (room) socket.emit('chat:history', historyFor(room, user().uid)) })

  socket.on('disconnect', async () => {
    const u = user()
    if (!u || (await io.in('u:' + u.uid).fetchSockets()).length) return
    const room = roomOfUser(u.uid)
    const p = room && getP(room, u.uid)
    if (!p) return
    p.online = false
    if (room.state === 'lobby') p.leaveT = setTimeout(() => rooms[room.code] && removePlayer(room, u.uid), 20000)
    pushState(room)
  })
})

// bersihkan room game yang semua pemainnya sudah offline > 3 menit
setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.players.every((p) => p.online === false || p.left)) {
      room.offSince = room.offSince || Date.now()
      if (Date.now() - room.offSince > 180000) halt(room)
    } else room.offSince = null
  }
}, 60000)

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`Werewolf Web jalan di http://localhost:${PORT}`))
