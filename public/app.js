const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
const socket = io()
const call = (ev, data) => new Promise((r) => socket.emit(ev, data, r))
const PHASE = { lobby: 'Lobby', intro: '📜 Persiapan', head: '👑 Kepala Desa', night: '🌙 Malam', morning: '🌅 Pagi', day: '☀️ Diskusi', vote: '🗳️ Voting', end: 'Selesai' }
const CHL = { main: '🏘️ Desa', wolf: '🐺 Serigala', hyp: '🌀 Hipnotis', lovers: '💘 Pasangan', dead: '💀 Arwah', pm: '🔒 Pribadi' }
const S = { user: null, view: 'boot', room: null, tab: 'aksi', ch: 'main', chat: [], htab: 'rooms', rooms: [], lb: [], lbType: 'global', hist: null, replay: null, rpCh: 'all', end: null, unread: { chat: 0, pm: 0 }, pub: true, skew: 0, revealed: {}, reveal: false, death: null, cardView: false, mres: null, mbusy: false, muted: false, phaseKey: '', nextState: null, lastEnds: 0, total: 1 }

const card = (r) => `/cards/${r}.webp`
const tcard = (role, cls = '') => `<div class="tcard ${cls}"><div class="h l" style="background-image:url(${card(role)})"></div><div class="h r" style="background-image:url(${card(role)})"></div><div class="x">✖</div></div>`
const BANNER = { head: '👑 PILIH KEPALA DESA', night: '🌙 MALAM', morning: '🌅 PAGI HARI', day: '☀️ WAKTU DISKUSI', vote: '🗳️ WAKTU VOTING' }
let tt
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(tt); tt = setTimeout(() => (t.style.display = 'none'), 2600) }
const av = (uid, v, cls = '') => `<span class="av ${cls}">🙂${v ? `<img src="/avatar/${uid}?v=${v}" onerror="this.remove()">` : ''}</span>`
const newToken = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, '0')).join('') }
const dt = (ms) => new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })

// ---------------- koneksi & auth ----------------
socket.on('connect', async () => {
  const t = localStorage.getItem('ww_token')
  if (!t) { S.view = 'auth'; return render() }
  const r = await call('auth:login', { token: t })
  if (r.ok) afterAuth(r.user)
  else { S.view = 'auth'; render() }
})
async function afterAuth(u) {
  S.user = u
  if (['boot', 'auth'].includes(S.view)) S.view = 'home'
  render()
  const code = new URLSearchParams(location.search).get('room')
  if (code && !S.room) { history.replaceState(null, '', '/'); const r = await call('room:join', { code }); if (r.error) toast(r.error) }
}
socket.on('rooms:list', (l) => { S.rooms = l; if (S.view === 'home' && S.htab === 'rooms') render() })
socket.on('state', (v) => {
  if (S.view === 'end' || S.view === 'replay') { if (v.state === 'lobby') S.nextState = v; return }
  const old = S.room
  if (v.state === 'lobby' && S.view !== 'lobby') S.chat = []
  if (v.endsAt !== S.lastEnds) { S.lastEnds = v.endsAt; S.total = Math.max(1000, v.endsAt - v.now) }
  S.room = v; S.skew = v.now - Date.now(); S.view = v.state === 'lobby' ? 'lobby' : 'game'
  if (v.state === 'play' && v.me) {
    const key = v.phase + '|' + v.night
    if (key !== S.phaseKey) { S.phaseKey = key; showBanner(v) }
    if (old?.me?.alive && !v.me.alive) {
      const cause = v.players.find((x) => x.uid === v.me.uid)?.cause
      S.death = { role: v.me.role, cause }; S.reveal = false; renderOv()
      if (cause === 'vote') playEnd()
    }
    if (v.phase === 'intro' && !S.revealed[v.code]) { S.revealed[v.code] = true; S.reveal = true; renderOv(); setTimeout(() => { if (S.reveal) { S.reveal = false; renderOv() } }, 14000) }
  } else S.phaseKey = ''
  render()
})
socket.on('chat:history', (h) => { S.chat = h; render() })
socket.on('chat:msg', (m) => {
  S.chat.push(m)
  if (S.view === 'game') {
    if (m.ch === 'pm' && S.tab !== 'pesan') S.unread.pm++
    else if (m.ch !== 'pm' && S.tab !== 'chat') S.unread.chat++
  }
  render()
})
socket.on('game:end', (d) => { S.end = d; S.reveal = S.death = S.cardView = false; renderOv(); S.room = null; S.view = 'end'; document.body.classList.remove('night'); call('profile:me').then((r) => r.ok && (S.user = r.user)); render() })
socket.on('room:closed', ({ reason }) => { toast(reason); S.reveal = S.death = S.cardView = false; renderOv(); S.room = null; S.view = 'home'; render() })

// ---------------- render ----------------
function render() {
  const a = document.activeElement
  const keep = a && a.id === 'ci' ? { v: a.value, s: a.selectionStart } : null
  const m0 = $('#msgs'); const bottom = !m0 || m0.scrollHeight - m0.scrollTop - m0.clientHeight < 50
  const un = a && a.id === 'un' ? a.value : null
  const nn = a && a.id === 'nn' ? { v: a.value, s: a.selectionStart } : null
  const mq = a && a.id === 'mq' ? { v: a.value, s: a.selectionStart } : null
  const V = { boot: () => '<h1>…</h1>', auth: rAuth, home: rHome, lobby: rLobby, game: rGame, end: rEnd, replay: rReplay }
  $('#app').innerHTML = (V[S.view] || V.boot)()
  document.body.classList.toggle('night', S.view === 'game' && S.room?.phase === 'night')
  const m = $('#msgs'); if (m && bottom) m.scrollTop = m.scrollHeight
  renderTop()
  if (keep) { const i = $('#ci'); if (i) { i.value = keep.v; i.focus(); i.setSelectionRange(keep.s, keep.s) } }
  if (un != null && $('#un')) { $('#un').value = un; $('#un').focus() }
  if (nn && $('#nn')) { const i = $('#nn'); i.value = nn.v; i.focus(); i.setSelectionRange(nn.s, nn.s) }
  if (mq && $('#mq')) { const i = $('#mq'); i.value = mq.v; i.focus(); i.setSelectionRange(mq.s, mq.s) }
  syncMusic()
}
let lastTop = ''
function renderTop() {
  const r = S.room
  const h = S.view === 'game' && r ? `<div class="top ${r.phase === 'night' ? 'n' : ''}"><span class="px">${PHASE[r.phase] || r.phase}${r.phase === 'night' ? ' ' + r.night : ''}</span><span>👥 ${r.aliveN}</span><button class="sm gold" data-a="card">🃏 Kartu</button><span id="timer" class="tm"></span></div><div class="pbar"><i id="pbar"></i></div>` : ''
  if (h !== lastTop) { $('#tb').innerHTML = h; lastTop = h; tick() }
  document.body.classList.toggle('ingame', !!h)
}
function tick() {
  const r = S.room; if (!r || S.view !== 'game') return
  const left = r.endsAt ? Math.max(0, Math.ceil((r.endsAt - (Date.now() + S.skew)) / 1000)) : 0
  const txt = left ? `⏳ ${left} detik` : ''
  for (const id of ['timer', 'btimer']) { const e = $('#' + id); if (e) { e.textContent = txt; e.classList.toggle('warn', left > 0 && left <= 10) } }
  const b = $('#pbar'); if (b) b.style.width = (left ? Math.min(100, (left * 1000) / S.total * 100) : 0) + '%'
}
setInterval(tick, 250)
let bt
function showBanner(v) {
  const L = BANNER[v.phase]; if (!L) return
  $('#bn').innerHTML = `<div class="banner ${v.phase === 'night' ? 'n' : ''}"><div class="px">${L}${v.phase === 'night' ? ' ' + v.night : ''}</div><div class="bt" id="btimer"></div></div>`
  clearTimeout(bt); bt = setTimeout(() => ($('#bn').innerHTML = ''), 3600)
  setTimeout(tick, 50)
}
const deadBtns = () => {
  const r = S.room, q = r?.me?.queue
  return `<button class="gold" style="width:100%" data-a="closeov">👀 NONTON DULU</button><button class="${q ? 'on' : 'red'} mt" style="width:100%" data-a="queue">${q ? '✅ SUDAH ANTRI (tap batal)' : '🔁 ANTRI MAIN LAGI'}${r?.queuedN ? ` · ${r.queuedN} siap` : ''}</button><button class="mt" style="width:100%" data-a="tolobby">🏠 BALIK KE LOBBY</button>`
}
function renderOv() {
  const me = S.room?.me; let h = ''
  const sparks = Array.from({ length: 16 }, () => `<i class="sp" style="left:${8 + Math.random() * 84}%;animation-delay:${(2 + Math.random() * 1.4).toFixed(2)}s"></i>`).join('')
  if (S.reveal && me) h = `<div class="ovl" data-a="closeov"><div class="stage"><div class="px sm2">PEMBAGIAN ROLE</div><div class="flipw"><div class="flip"><div class="in"><div class="b"><span>🐺</span></div><div class="f" style="background-image:url(${card(me.role)})"></div></div></div>${sparks}</div><div class="px rt">KAMU ADALAH<br><span>${esc(me.roleName)}</span></div><button class="red" data-a="closeov">SIAP!</button></div></div>`
  else if (S.death) { const vt = S.death.cause === 'vote'; h = `<div class="ovl dk" data-a="closeov"><div class="stage"><div class="px sm2">${vt ? '🗳️ KAMU DI-VOTE KELUAR' : '💀 KAMU MATI'}</div>${vt ? '<div class="px theend">THIS IS THE END</div>' : ''}<div class="deadw">${tcard(S.death.role, 'go')}</div><p class="center dt">Kartumu dirobek. Mau ngapain?</p>${deadBtns()}</div></div>` }
  else if (S.cardView && me) h = `<div class="ovl" data-a="closeov"><div class="stage"><div class="px sm2">KARTU ROLE-MU</div><div class="deadw">${me.alive ? `<div class="cardf" style="background-image:url(${card(me.role)})"></div>` : tcard(me.role, 'go')}</div><button data-a="closeov">TUTUP</button></div></div>`
  $('#ov').innerHTML = h
}

const rAuth = () => `<h1>WEREWOLF</h1><div class="box"><h2>Masukkan username</h2>
<p class="muted">Username tidak boleh sama dengan pemain lain. Nanti bisa kamu ganti lewat profil, akunmu tetap sama. Tanpa password, akun tersimpan di perangkat ini.</p>
<input id="un" maxlength="16" placeholder="contoh: serigala_77" autocomplete="off"><button class="red mt" data-a="register">MULAI MAIN</button></div>`

const stat = (u) => `<div class="stats"><div><b>${u.games}</b>main</div><div><b>${u.wins}</b>menang</div><div><b>${u.wolfWins}</b>menang nyamar</div></div>`
function rHome() {
  const u = S.user
  const tabs = [['rooms', 'Room'], ['top', 'Top'], ['hist', 'Riwayat']]
  let body = ''
  if (S.htab === 'rooms') {
    body = `<div class="box"><h2>BUAT ROOM</h2><div class="row"><button class="grow ${S.pub ? 'on' : ''}" data-a="pub" data-x="1">🌐 Publik</button><button class="grow ${S.pub ? '' : 'on'}" data-a="pub" data-x="0">🔒 Privat</button></div>
<p class="muted">${S.pub ? 'Muncul otomatis di daftar room. Tetap ada kode & link.' : 'Hanya bisa masuk lewat kode / link.'}</p><button class="red" data-a="create">BUAT ROOM</button></div>
<div class="box"><h2>GABUNG PAKAI KODE</h2><div class="row"><input id="jc" maxlength="4" placeholder="KODE" style="text-transform:uppercase"><button class="gold" data-a="joincode">MASUK</button></div></div>
<div class="box sage"><h2>ROOM PUBLIK</h2>${S.rooms.length ? S.rooms.map((r) => `<div class="item"><div class="grow"><b class="px" style="font-size:12px">${r.code}</b><div class="muted">host ${esc(r.host)} · ${r.count}/${r.max}</div></div><button class="sm gold" data-a="joinroom" data-x="${r.code}">Gabung</button></div>`).join('') : '<p class="muted">Belum ada room publik. Buat yang pertama!</p>'}</div>`
  } else if (S.htab === 'top') {
    const lt = [['global', '🏆 Top Global'], ['rajin', '💪 Rajin'], ['nyamar', '🎭 Nyamar']]
    body = `<div class="tabs">${lt.map(([k, l]) => `<button class="${S.lbType === k ? 'on' : ''}" data-a="lb" data-x="${k}">${l}</button>`).join('')}</div><div class="box sage">
<p class="muted">${{ global: 'Paling banyak menang.', rajin: 'Paling banyak bermain.', nyamar: 'Paling banyak menang sebagai tim Werewolf.' }[S.lbType]}</p>
${S.lb.length ? S.lb.map((r, i) => `<div class="item"><span class="px" style="font-size:11px;width:26px">${i + 1}</span>${av(r.uid, r.avatarAt, 'sm')}<div class="grow">${esc(r.username)}</div><b class="px" style="font-size:12px">${r.value}</b></div>`).join('') : '<p class="muted">Belum ada data.</p>'}</div>`
  } else {
    body = `<div class="box sage"><h2>RIWAYAT PERMAINAN</h2>${S.hist == null ? '<p class="muted">Memuat…</p>' : S.hist.length ? S.hist.map((g) => { const me = g.players.find((p) => p.uid === u.uid); return `<div class="item" data-a="histopen" data-x="${g.id}" style="cursor:pointer"><div class="grow"><b>${esc(g.title.split('\n')[0])}</b><div class="muted">${dt(g.endedAt)} · ${g.players.length} pemain</div><div class="muted">kamu: ${esc(me?.rl || '')} ${me?.win ? '🏆 menang' : '💀 kalah'}</div></div><span class="badge">REPLAY</span></div>` }).join('') : '<p class="muted">Belum ada permainan selesai.</p>'}</div>`
  }
  return `<h1>WEREWOLF</h1><div class="box"><div class="row">
<div data-a="avatar" style="cursor:pointer" title="Ganti foto">${av(u.uid, u.avatarAt, 'big')}</div><div class="grow">${S.editName
    ? `<input id="nn" maxlength="16" value="${esc(u.username)}" autocomplete="off" autocapitalize="off"><div class="row mt"><button class="sm red grow" data-a="namesave">Simpan</button><button class="sm grow" data-a="namecancel">Batal</button></div>`
    : `<h2 style="margin:0 0 4px">${esc(u.username)} <button class="sm" data-a="nameedit" title="Ganti nama" aria-label="Ganti nama">✏️</button></h2><div class="muted">tap foto untuk ganti dari galeri</div>`}</div></div><div class="mt">${stat(u)}</div></div>
<div class="tabs">${tabs.map(([k, l]) => `<button class="${S.htab === k ? 'on' : ''}" data-a="htab" data-x="${k}">${l}</button>`).join('')}</div>${body}`
}

function rLobby() {
  const r = S.room, isHost = r.host === S.user.uid, link = `${location.origin}/?room=${r.code}`
  return `<h1>ROOM</h1><div class="box center"><div class="code">${r.code}</div><p class="muted">${r.isPublic ? '🌐 Publik' : '🔒 Privat'} · ${r.players.length}/${r.max} pemain (min ${r.min})</p>
<button class="gold" data-a="copy" data-x="${esc(link)}">🔗 Salin link masuk</button></div>
${musicBox(r, isHost)}
<div class="box sage"><h2>💬 CHAT LOBBY</h2><div class="msgs" id="msgs" style="height:30vh">${S.chat.filter((m) => m.ch === 'main').map(msgHtml).join('') || '<p class="muted center">Belum ada pesan. Sapa dulu yuk 👋</p>'}</div><div class="row"><input id="ci" maxlength="300" placeholder="Ketik pesan…" autocomplete="off"><button class="gold" data-a="send">Kirim</button></div></div>
<div class="box sage"><h2>PEMAIN</h2>${r.players.map((p) => `<div class="item">${av(p.uid, p.av, 'sm')}<div class="grow">${esc(p.name)} ${p.uid === r.host ? '<span class="badge">HOST</span>' : ''}${p.online ? '' : ' <span class="muted">(offline)</span>'}</div>${isHost && p.uid !== r.host ? `<button class="sm red" data-a="kick" data-x="${p.uid}">Kick</button>` : ''}</div>`).join('')}</div>
${isHost ? `<button class="red" style="width:100%" data-a="start" ${r.players.length < r.min ? 'disabled' : ''}>${r.players.length < r.min ? `BUTUH ${r.min - r.players.length} PEMAIN LAGI` : 'MULAI GAME'}</button><button class="mt" style="width:100%" data-a="close">Tutup room</button>` : '<p class="center muted">Menunggu host memulai…</p><button style="width:100%" data-a="leave">Keluar</button>'}`
}

function rGame() {
  const r = S.room, me = r.me
  if (!me) return '<h1>…</h1>'
  const pending = (r.polls || []).filter((q) => q.my == null).length
  const dot = (n) => (n ? `<span class="dot">${n}</span>` : '')
  const nav = [['aksi', '🎯 Aksi', pending], ['chat', '💬 Chat', S.unread.chat], ['pemain', '👥 Pemain', 0], ['pesan', '🔒 Pesan', S.unread.pm]]
  let body = ''
  if (S.tab === 'aksi') {
    body = `<div class="box"><div class="cardbox" data-a="card">${me.alive ? `<div class="cardf" style="background-image:url(${card(me.role)})"></div>` : tcard(me.role, 'st')}</div><p class="center muted">${esc(me.team)} ${me.alive ? '· tap kartu untuk memperbesar' : '· 💀 mati'}</p><p>${fmt(me.desc)}</p>
${me.mates?.length ? `<p><b>🐺 Rekan serigala:</b> ${me.mates.map((m) => `<span class="pill">${esc(m.name)}${m.role !== 'Werewolf' ? ' · ' + esc(m.role) : ''}</span>`).join('')}</p>` : ''}
${me.target ? `<p>🎯 Targetmu: <b>${esc(me.target)}</b></p>` : ''}${me.lover ? `<p>💘 Pasanganmu: <b>${esc(me.lover)}</b></p>` : ''}
${me.potion ? `<p>🧪 Ramuan: 💚 ${me.potion.heal ? 'ada' : 'habis'} · ☠️ ${me.potion.poison ? 'ada' : 'habis'}</p>` : ''}</div>`
    body += (r.polls || []).map((q) => {
      const lab = (v) => q.options.find((o) => o.value === v)?.label || v
      return `<div class="box sage"><h3>${esc(q.title)}</h3>${q.options.map((o) => `<button class="opt ${q.my === o.value ? 'on' : ''}" data-a="poll" data-x="${q.id}" data-v="${esc(o.value)}"><span>${esc(o.label)}</span>${q.pub ? `<span class="c">${q.votes.filter((v) => v.value === o.value).length}</span>` : ''}</button>`).join('')}
${q.my != null ? `<button class="sm" data-a="clear" data-x="${q.id}">Batalkan pilihan</button>` : ''}${q.pub && q.votes.length ? `<p class="who">${q.votes.map((v) => `${esc(v.who)} → ${esc(lab(v.value))}`).join('<br>')}</p>` : ''}</div>`
    }).join('')
    if (!me.alive) body += `<div class="box sage"><h3>💀 Kamu sudah mati</h3><p class="muted">Pantau game dari tab Chat & Pemain, atau pilih:</p>${deadBtns()}</div>`
    else if (!(r.polls || []).length) body += `<p class="center muted">Tidak ada aksi saat ini. Tunggu giliranmu / lihat tab Chat.</p>`
  } else if (S.tab === 'chat') {
    const chs = r.channels || []
    if (!chs.some((c) => c.id === S.ch)) S.ch = 'main'
    const c = chs.find((x) => x.id === S.ch)
    body = `<div class="tabs">${chs.map((x) => `<button class="${S.ch === x.id ? 'on' : ''}" data-a="ch" data-x="${x.id}">${x.label}${x.open ? '' : ' 🔒'}</button>`).join('')}</div>
<div class="msgs" id="msgs">${S.chat.filter((m) => m.ch === S.ch).map(msgHtml).join('') || '<p class="muted center">Belum ada pesan.</p>'}</div>
${c?.open ? `<div class="row"><input id="ci" maxlength="300" placeholder="Ketik pesan…" autocomplete="off"><button class="gold" data-a="send">Kirim</button></div>` : '<p class="center muted">🔒 Chat ini sedang ditutup.</p>'}`
  } else if (S.tab === 'pemain') {
    body = `<div class="pgrid">${r.players.map((p) => `<div class="item ${p.alive ? '' : 'dead'}">${!p.alive && p.role ? `<div class="mini">${tcard(p.role, 'st')}</div>` : av(p.uid, p.av, 'sm')}<div class="grow"><div>${esc(p.name)} ${p.uid === r.head ? '👑' : ''}</div><div class="muted">${p.alive ? (p.online ? '✅ hidup' : '📴 offline') : '💀 ' + esc(p.rl || '')}</div></div></div>`).join('')}</div><button class="red mt" style="width:100%" data-a="${me.alive ? 'leave' : 'tolobby'}">${me.alive ? 'Keluar dari game' : '🏠 Balik ke lobby'}</button>`
  } else {
    body = `<div class="msgs" id="msgs" style="height:62vh">${S.chat.filter((m) => m.ch === 'pm').map(msgHtml).join('') || '<p class="muted center">Belum ada pesan pribadi.</p>'}</div>`
  }
  return `${body}
<div class="nav">${nav.map(([k, l, n]) => `<button class="${S.tab === k ? 'on' : ''}" data-a="tab" data-x="${k}">${l}${dot(n)}</button>`).join('')}</div>`
}
const msgHtml = (m) => (m.kind === 'sys' ? `<div class="m sys ${m.ch === 'pm' ? 'pm' : ''}">${fmt(m.text)}</div>` : `<div class="m"><b class="n">${esc(m.name)}:</b> ${esc(m.text)}</div>`)

function rEnd() {
  const d = S.end
  return `<h1>SELESAI</h1><div class="box"><h2 class="center">${esc(d.title.split('\n')[0])}</h2>${d.players.map((p) => `<div class="item"><div class="grow">${esc(p.name)}<div class="muted">${esc(p.rl)} ${p.alive ? '✅' : '💀'}</div></div>${p.win ? '<span class="badge">🏆 MENANG</span>' : ''}</div>`).join('')}</div>
<button class="gold" style="width:100%" data-a="endreplay">📜 Lihat replay chat</button><button class="mt ${d.next ? 'red' : ''}" style="width:100%" data-a="back">${d.next ? '🎮 MASUK LOBBY BARU (kamu sudah antri)' : 'Kembali ke lobby'}</button>`
}

function rReplay() {
  const g = S.replay, log = g.log, chs = [...new Set(log.map((e) => e.ch))]
  const nameOf = (u) => g.players.find((p) => p.uid === u)?.name || '?'
  let last = '', html = ''
  for (const e of log) {
    if (S.rpCh !== 'all' && e.ch !== S.rpCh) continue
    const k = `${e.phase}|${e.night}`
    if (k !== last) { last = k; html += `<div class="ph">— ${PHASE[e.phase] || e.phase}${e.night ? ' · malam ke-' + e.night : ''} —</div>` }
    const who = e.ch === 'pm' ? `<b>🔒 ${esc(nameOf(e.to))}</b><br>` : S.rpCh === 'all' && e.ch !== 'main' ? `<span class="muted">[${CHL[e.ch]}]</span> ` : ''
    html += e.kind === 'sys' ? `<div class="m sys ${e.ch === 'pm' ? 'pm' : ''}">${who}${fmt(e.text)}</div>` : `<div class="m">${who}<b class="n">${esc(e.name)}:</b> ${esc(e.text)}</div>`
  }
  return `<h1>REPLAY</h1><div class="box"><h2>${esc(g.title.split('\n')[0])}</h2><p class="muted">${dt(g.endedAt)} · ${g.nights} malam</p>${g.players.map((p) => `<span class="pill">${p.win ? '🏆' : ''}${esc(p.name)} · ${esc(p.rl)}</span>`).join('')}</div>
<div class="tabs"><button class="${S.rpCh === 'all' ? 'on' : ''}" data-a="rpch" data-x="all">Semua</button>${chs.map((c) => `<button class="${S.rpCh === c ? 'on' : ''}" data-a="rpch" data-x="${c}">${CHL[c] || c}</button>`).join('')}</div>
<div class="msgs" style="height:auto;max-height:none">${html}</div><button style="width:100%" data-a="back">Kembali</button>`
}

// ---------------- aksi ----------------
async function loadLb() { const r = await call('lb:get', S.lbType); S.lb = r.rows || []; render() }
// ---------------- lagu ----------------
// ---- pemutar YouTube tersembunyi (audio saja) ----
const YTP = { p: null, ready: false, vid: '', playing: false }
{
  const h = document.createElement('div')
  h.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:200px;opacity:0;pointer-events:none'
  h.innerHTML = '<div id="ytp"></div>'
  document.body.appendChild(h)
  window.onYouTubeIframeAPIReady = () => {
    YTP.p = new window.YT.Player('ytp', {
      width: '200', height: '200', playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, origin: location.origin },
      events: {
        onReady: () => { YTP.ready = true; YTP.p.setVolume(50); syncMusic() },
        onStateChange: (e) => {
          YTP.playing = e.data === 1
          if (e.data === 0) { YTP.p.seekTo(0); YTP.p.playVideo() } // ulang terus
          const b = $('#mu'); if (b && S.room?.music) b.textContent = S.muted || !YTP.playing ? '🔇' : '🔊'
        },
        onError: () => toast('Lagu ini tidak bisa diputar (dibatasi YouTube). Pilih lagu lain.'),
      },
    })
  }
  const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(sc)
}
try { S.muted = localStorage.getItem('ww_muted') === '1' } catch {}
const END = new Audio('/assets/the-end.mp3'); END.preload = 'auto'
let endPlaying = false
function playEnd() {
  endPlaying = true; ytPause()
  END.currentTime = 0
  END.play().catch(() => { endPlaying = false; syncMusic() })
}
END.addEventListener('ended', () => { endPlaying = false; syncMusic() })
let musicUrl = '', interacted = false
const ytPause = () => { try { YTP.ready && YTP.p.pauseVideo() } catch {} }
const ytPlay = () => { try { YTP.ready && YTP.p.playVideo() } catch {} }
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '')
function musicBox(r, isHost) {
  const m = r.music
  const cur = m ? `<div class="item">${m.cover ? `<img class="mcov" src="${esc(safeUrl(m.cover))}" referrerpolicy="no-referrer" onerror="this.remove()">` : '<span class="mcov">🎵</span>'}<div class="grow"><b>${esc(m.title)}</b><div class="muted">${esc(m.artist)}</div></div>${isHost ? '<button class="sm red" data-a="mclear">Hapus</button>' : ''}</div>` : `<p class="muted">${isHost ? 'Belum ada lagu. Cari judulnya di bawah.' : 'Host belum memilih lagu.'}</p>`
  if (!isHost) return m ? `<div class="box sage"><h2>🎵 LAGU</h2>${cur}</div>` : ''
  const res = (S.mres || []).map((t, i) => `<div class="item"><div class="grow"><b>${esc(t.title)}</b><div class="muted">${esc(t.artist)}</div></div><button class="sm gold" data-a="mpick" data-x="${i}">Pilih</button></div>`).join('')
  return `<div class="box sage"><h2>🎵 LAGU</h2>${cur}<div class="row"><input id="mq" maxlength="100" placeholder="Cari lagu, mis. amnesia" autocomplete="off"><button class="gold" data-a="msearch" ${S.mbusy ? 'disabled' : ''}>${S.mbusy ? '…' : 'Cari'}</button></div>${res}</div>`
}
function syncMusic() {
  const m = S.room?.music, b = $('#mu')
  if (!m) { if (musicUrl) { musicUrl = ''; try { YTP.ready && YTP.p.stopVideo() } catch {} } if (b) b.style.display = 'none'; return }
  if (b) { b.style.display = 'block'; b.textContent = S.muted || !YTP.playing ? '🔇' : '🔊'; b.title = `${m.title} — ${m.artist}` }
  if (!YTP.ready) return
  if (musicUrl !== m.vid) { musicUrl = m.vid; if (interacted && !S.muted && !endPlaying) YTP.p.loadVideoById(m.vid); else YTP.p.cueVideoById(m.vid) }
  else if (interacted && !S.muted && !endPlaying && !YTP.playing) {
    const st = YTP.p.getPlayerState?.()
    if (st === 5 || st === 2 || st === -1) YTP.p.playVideo()
  }
}
const unlockAudio = () => { if (!interacted) { interacted = true; END.muted = true; END.play().then(() => { END.pause(); END.currentTime = 0; END.muted = false }).catch(() => { END.muted = false }); syncMusic() } }
document.addEventListener('pointerdown', unlockAudio, { once: true })
document.addEventListener('keydown', unlockAudio, { once: true })
async function loadHist() { const r = await call('hist:list'); S.hist = r.games || []; render() }
async function openReplay(id) { const r = await call('hist:get', id); if (r.error) return toast(r.error); S.replay = r.game; S.rpCh = 'all'; S.view = 'replay'; render() }
const err = (r) => r?.error && (toast(r.error), true)

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]'); if (!el) return
  const a = el.dataset.a, x = el.dataset.x
  if (a === 'register') {
    const username = $('#un').value.trim(), token = newToken()
    const r = await call('auth:register', { username, token })
    if (err(r)) return
    localStorage.setItem('ww_token', token); afterAuth(r.user)
  } else if (a === 'avatar') $('#file').click()
  else if (a === 'nameedit') { S.editName = true; render(); const i = $('#nn'); if (i) { i.focus(); i.select() } }
  else if (a === 'namecancel') { S.editName = false; render() }
  else if (a === 'namesave') saveName()
  else if (a === 'htab') { S.htab = x; if (x === 'top') loadLb(); if (x === 'hist') { S.hist = null; loadHist() } render() }
  else if (a === 'lb') { S.lbType = x; loadLb() }
  else if (a === 'histopen') openReplay(x)
  else if (a === 'pub') { S.pub = x === '1'; render() }
  else if (a === 'create') err(await call('room:create', { isPublic: S.pub }))
  else if (a === 'joincode') err(await call('room:join', { code: $('#jc').value }))
  else if (a === 'joinroom') err(await call('room:join', { code: x }))
  else if (a === 'copy') { try { await navigator.clipboard.writeText(x); toast('Link disalin!') } catch { prompt('Salin link ini:', x) } }
  else if (a === 'msearch') {
    const q = $('#mq')?.value.trim(); if (!q) return toast('Tulis judul lagunya dulu')
    S.mbusy = true; S.mres = null; render()
    const r = await call('music:search', { q }); S.mbusy = false
    if (r.error) toast(r.error); else S.mres = r.tracks
    render()
  }
  else if (a === 'mpick') { const r = await call('music:set', { i: Number(x) }); if (!err(r)) { S.mres = null; toast('Lagu diatur!'); render() } }
  else if (a === 'mclear') { S.mres = null; err(await call('music:clear')) }
  else if (a === 'mute') { S.muted = !S.muted; try { localStorage.setItem('ww_muted', S.muted ? '1' : '0') } catch {} if (S.muted) ytPause(); syncMusic() }
  else if (a === 'kick') err(await call('room:kick', { uid: x }))
  else if (a === 'start') err(await call('room:start'))
  else if (a === 'close') err(await call('room:close'))
  else if (a === 'leave') { if (S.room?.state === 'play' && S.room.me?.alive && !confirm('Keluar sekarang = dianggap mati. Yakin?')) return; if (S.room?.state === 'play' && S.room.me?.alive) playEnd(); await call('room:leave'); S.room = null; S.view = 'home'; render() }
  else if (a === 'tolobby') { await call('room:leave'); S.death = null; renderOv(); S.room = null; S.view = 'home'; render() }
  else if (a === 'queue') { const on = !S.room?.me?.queue; const r = await call('room:queue', { on }); if (err(r)) return; S.death = null; renderOv(); toast(on ? 'Kamu masuk antrian main lagi 🔁' : 'Antrian dibatalkan') }
  else if (a === 'tab') { S.tab = x; if (x === 'chat') S.unread.chat = 0; if (x === 'pesan') S.unread.pm = 0; render() }
  else if (a === 'ch') { S.ch = x; render() }
  else if (a === 'poll') err(await call('poll:vote', { id: x, value: el.dataset.v }))
  else if (a === 'clear') err(await call('poll:vote', { id: x, value: null }))
  else if (a === 'send') sendChat()
  else if (a === 'endreplay') openReplay(S.end.id)
  else if (a === 'rpch') { S.rpCh = x; render() }
  else if (a === 'card') { S.cardView = true; renderOv() }
  else if (a === 'closeov') { if (e.target.closest('.stage') && !el.matches('button')) return; S.reveal = S.death = S.cardView = false; renderOv() }
  else if (a === 'back') {
    if (S.end?.next && S.nextState) { S.room = S.nextState; S.nextState = null; S.chat = []; S.view = 'lobby'; S.end = null; S.replay = null; render(); return }
    S.view = 'home'; S.end = null; S.replay = null; S.nextState = null; S.htab = 'rooms'; render()
  }
})
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ci') sendChat(); if (e.key === 'Enter' && e.target.id === 'mq') document.querySelector('[data-a=msearch]')?.click(); if (e.key === 'Enter' && e.target.id === 'un') document.querySelector('[data-a=register]').click(); if (e.key === 'Enter' && e.target.id === 'nn') saveName(); if (e.key === 'Escape' && e.target.id === 'nn') { S.editName = false; render() } })
async function saveName() {
  const username = $('#nn')?.value.trim(); if (!username) return
  if (username === S.user.username) { S.editName = false; return render() }
  const r = await call('profile:rename', { username })
  if (err(r)) return
  S.user.username = r.username; S.editName = false; toast('Username diganti jadi ' + r.username); render()
}
// ganti nama dari tab/perangkat lain pada akun yang sama
socket.on('profile:renamed', ({ username }) => { if (S.user) { S.user.username = username; render() } })
async function sendChat() { const i = $('#ci'); if (!i || !i.value.trim()) return; const text = i.value; i.value = ''; err(await call('chat:send', { ch: S.view === 'lobby' ? 'main' : S.ch, text })) }

// ---------------- foto profil dari galeri ----------------
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''
  if (!f) return
  const img = new Image(); img.src = URL.createObjectURL(f)
  await img.decode().catch(() => {})
  const c = document.createElement('canvas'); c.width = c.height = 128
  const s = Math.min(img.width, img.height)
  c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
  const r = await call('profile:avatar', c.toDataURL('image/jpeg', 0.8))
  if (err(r)) return
  S.user.avatarAt = r.avatarAt; toast('Foto profil diganti'); render()
})
