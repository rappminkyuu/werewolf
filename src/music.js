// Pencarian lagu di YouTube (paket yt-search, dijalankan di server).
// Pemutaran dilakukan di browser lewat YouTube IFrame Player yang disembunyikan -> hanya audio yang terdengar.
import yts from 'yt-search'

const ID = /^[\w-]{11}$/

export async function searchTracks(q) {
  q = String(q || '').trim().slice(0, 100)
  if (!q) throw new Error('Tulis judul lagunya dulu')
  let r
  try {
    r = await Promise.race([
      yts({ query: q, hl: 'id' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ])
  } catch (e) {
    console.warn('[music] pencarian YouTube gagal:', e.message)
    throw new Error(e.message === 'timeout' ? 'Pencarian terlalu lama, coba lagi' : 'Gagal mencari di YouTube')
  }
  const tracks = (r.videos || [])
    .filter((v) => ID.test(v.videoId || '') && v.seconds > 0 && v.seconds <= 900)
    .slice(0, 6)
    .map((v) => ({
      title: String(v.title || 'Tanpa judul').slice(0, 120),
      artist: String(v.author?.name || '').slice(0, 120),
      cover: v.image || v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      vid: v.videoId,
      dur: v.timestamp || '',
    }))
  if (!tracks.length) throw new Error('Lagu tidak ditemukan')
  return tracks
}
