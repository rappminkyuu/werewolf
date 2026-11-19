// Database: Firebase Firestore (kalau serviceAccountKey.json ada), kalau tidak -> file JSON lokal (untuk coba-coba)
import fs from 'fs'
import crypto from 'crypto'

const KEY = process.env.FIREBASE_KEY || './serviceAccountKey.json'
const STAT = { global: 'wins', rajin: 'games', nyamar: 'wolfWins' }
const pub = (u) => u && ({ uid: u.uid, username: u.username, avatarAt: u.avatarAt || 0, games: u.games || 0, wins: u.wins || 0, wolfGames: u.wolfGames || 0, wolfWins: u.wolfWins || 0, survived: u.survived || 0 })
const summary = ({ log, ...g }) => g
const newUser = (username, tokenHash) => ({ uid: crypto.randomBytes(10).toString('hex'), username, usernameLower: username.toLowerCase(), tokenHash, avatar: '', avatarAt: 0, createdAt: Date.now(), games: 0, wins: 0, wolfGames: 0, wolfWins: 0, survived: 0 })
const delta = (p) => ({ games: 1, wins: p.win ? 1 : 0, wolfGames: p.team0 === 'wolf' ? 1 : 0, wolfWins: p.team0 === 'wolf' && p.win ? 1 : 0, survived: p.alive ? 1 : 0 })

function firebaseImpl(db, FieldValue) {
  const users = db.collection('users')
  return {
    async createUser(username, tokenHash) {
      const u = newUser(username, tokenHash)
      await db.runTransaction(async (t) => {
        const ref = db.collection('usernames').doc(u.usernameLower)
        if ((await t.get(ref)).exists) throw new Error('USERNAME_TAKEN')
        t.set(ref, { uid: u.uid })
        t.set(users.doc(u.uid), u)
      })
      return pub(u)
    },
    // ganti username: uid & token tetap, penjaga unik dipindah secara atomik
    async renameUser(uid, username) {
      const lower = username.toLowerCase()
      await db.runTransaction(async (t) => {
        const meRef = users.doc(uid)
        const me = await t.get(meRef)
        if (!me.exists) throw new Error('NO_USER')
        const oldLower = me.data().usernameLower || me.data().username.toLowerCase()
        const newRef = db.collection('usernames').doc(lower)
        const taken = await t.get(newRef)
        if (taken.exists && taken.data().uid !== uid) throw new Error('USERNAME_TAKEN')
        if (oldLower !== lower) t.delete(db.collection('usernames').doc(oldLower))
        t.set(newRef, { uid })
        t.update(meRef, { username, usernameLower: lower })
      })
    },
    async byToken(hash) { const s = await users.where('tokenHash', '==', hash).limit(1).get(); return s.empty ? null : pub(s.docs[0].data()) },
    async byId(uid) { const s = await users.doc(uid).get(); return s.exists ? s.data() : null },
    async setAvatar(uid, dataUrl) { const at = Date.now(); await users.doc(uid).update({ avatar: dataUrl, avatarAt: at }); return at },
    async saveGame(game) {
      const batch = db.batch()
      batch.set(db.collection('games').doc(game.id), game)
      for (const p of game.players) {
        const d = delta(p)
        batch.update(users.doc(p.uid), Object.fromEntries(Object.entries(d).map(([k, v]) => [k, FieldValue.increment(v)])))
      }
      await batch.commit()
    },
    async history(uid) {
      const s = await db.collection('games').where('uids', 'array-contains', uid).get()
      return s.docs.map((d) => summary(d.data())).sort((a, b) => b.endedAt - a.endedAt).slice(0, 50)
    },
    async getGame(id) { const s = await db.collection('games').doc(id).get(); return s.exists ? s.data() : null },
    async leaderboard(type) {
      const f = STAT[type] || 'wins'
      const s = await users.orderBy(f, 'desc').limit(20).get()
      return s.docs.map((d) => d.data()).filter((u) => u[f] > 0).map((u) => ({ uid: u.uid, username: u.username, avatarAt: u.avatarAt, value: u[f] }))
    },
  }
}

function fileImpl() {
  fs.mkdirSync('data', { recursive: true })
  const FILE = 'data/db.json'
  const d = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { users: {}, games: {} }
  let tm = null
  const save = () => { clearTimeout(tm); tm = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(d)), 300) }
  return {
    async createUser(username, tokenHash) {
      if (Object.values(d.users).some((u) => u.usernameLower === username.toLowerCase())) throw new Error('USERNAME_TAKEN')
      const u = newUser(username, tokenHash); d.users[u.uid] = u; save(); return pub(u)
    },
    async renameUser(uid, username) {
      const u = d.users[uid]
      if (!u) throw new Error('NO_USER')
      const lower = username.toLowerCase()
      if (Object.values(d.users).some((x) => x.uid !== uid && x.usernameLower === lower)) throw new Error('USERNAME_TAKEN')
      u.username = username; u.usernameLower = lower; save()
    },
    async byToken(hash) { return pub(Object.values(d.users).find((u) => u.tokenHash === hash)) || null },
    async byId(uid) { return d.users[uid] || null },
    async setAvatar(uid, dataUrl) { const u = d.users[uid]; u.avatar = dataUrl; u.avatarAt = Date.now(); save(); return u.avatarAt },
    async saveGame(game) {
      d.games[game.id] = game
      for (const p of game.players) { const u = d.users[p.uid]; if (u) for (const [k, v] of Object.entries(delta(p))) u[k] = (u[k] || 0) + v }
      save()
    },
    async history(uid) { return Object.values(d.games).filter((g) => g.uids.includes(uid)).map(summary).sort((a, b) => b.endedAt - a.endedAt).slice(0, 50) },
    async getGame(id) { return d.games[id] || null },
    async leaderboard(type) {
      const f = STAT[type] || 'wins'
      return Object.values(d.users).filter((u) => u[f] > 0).sort((a, b) => b[f] - a[f]).slice(0, 20).map((u) => ({ uid: u.uid, username: u.username, avatarAt: u.avatarAt, value: u[f] }))
    },
  }
}

let impl
if (fs.existsSync(KEY)) {
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore')
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(KEY, 'utf8'))) })
  impl = firebaseImpl(getFirestore(), FieldValue)
  console.log('[DB] Firebase Firestore aktif')
} else {
  impl = fileImpl()
  console.warn('[DB] serviceAccountKey.json tidak ditemukan -> pakai file lokal data/db.json (hanya untuk uji coba)')
}
export const { createUser, renameUser, byToken, byId, setAvatar, saveGame, history, getGame, leaderboard } = impl
export { pub as publicUser }
