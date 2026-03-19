// scraper.js v9
// Fixes vs v8:
//   BUG 1 (ok.ru): extractOkRu was returning the JSON string itself as the URL.
//                  Now uses ok.ru's dk API directly and extracts movie.hls properly.
//   BUG 2 (Luf-Mp4): Tries multiple decode approaches to find valid http URL.
//   NEW: Also processes Fm-Hls and Ss-Hls sources (may give direct HLS).

const axios = require('axios');

const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http = axios.create({ timeout: 8000, headers: { 'User-Agent': UA } });

// ─── Title cleaner ────────────────────────────────────────────────────────────
function cleanTitle(t) {
  if (!t) return t;
  return t.replace(/【([^】]*)】\s*/g, '$1 ').replace(/[〔〕「」『』《》〈〉]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── AniList ──────────────────────────────────────────────────────────────────
async function anilist(query, variables = {}) {
  const res = await axios.post('https://graphql.anilist.co', { query, variables }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 8000,
  });
  return res.data?.data;
}
function alToMeta(m) {
  if (!m) return null;
  return { id: `animekai:al${m.id}`, type: m.format === 'MOVIE' ? 'movie' : 'series', name: cleanTitle(m.title?.english || m.title?.romaji || String(m.id)), poster: m.coverImage?.extraLarge || m.coverImage?.large || '' };
}

// ─── AllAnime API ─────────────────────────────────────────────────────────────
const AA_API = 'https://api.allanime.day/api';
const AA_H   = { 'Referer': 'https://allanime.to', 'Origin': 'https://allanime.to', 'User-Agent': UA };

async function aaPost(query, variables) {
  const res = await axios.post(AA_API, { query, variables }, {
    headers: { ...AA_H, 'Content-Type': 'application/json' }, timeout: 8000,
  });
  return res.data?.data;
}
async function aaSearch(title, type = 'sub') {
  const d = await aaPost(`query($s:SearchInput,$t:VaildTranslationTypeEnumType){shows(search:$s,limit:5,page:1,translationType:$t){edges{_id name englishName}}}`, { s: { query: title }, t: type });
  return d?.shows?.edges || [];
}
async function aaSourceUrls(showId, epNum, type = 'sub') {
  const d = await aaPost(`query($id:String!,$ep:String!,$t:VaildTranslationTypeEnumType!){episode(showId:$id,translationType:$t,episodeString:$ep){sourceUrls}}`, { id: showId, ep: String(epNum), t: type });
  return d?.episode?.sourceUrls || [];
}

// ─── Decode Luf-Mp4 / S-mp4 / Fm-Hls encoded URLs ────────────────────────────
// AllAnime uses "--" prefix + some encoding. Try multiple approaches until
// we get a valid http URL.
function aaDecode(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  if (!encoded.startsWith('--')) return encoded.startsWith('http') ? encoded : null;

  const raw = encoded.slice(2);

  // Approach 1: hex → latin1 (no rot13)
  try {
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      const s = Buffer.from(raw, 'hex').toString('latin1');
      if (s.startsWith('http')) return s;
    }
  } catch (_) {}

  // Approach 2: hex → latin1 → rot13
  try {
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      const s = Buffer.from(raw, 'hex').toString('latin1');
      const r = s.replace(/[a-zA-Z]/g, c => {
        const b = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
      });
      if (r.startsWith('http')) return r;
    }
  } catch (_) {}

  // Approach 3: base64 → latin1 → rot13  (original approach)
  try {
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    const s = Buffer.from(padded, 'base64').toString('latin1');
    const r = s.replace(/[a-zA-Z]/g, c => {
      const b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
    });
    if (r.startsWith('http')) return r;
  } catch (_) {}

  // Approach 4: base64 → utf8 → rot13
  try {
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    const s = Buffer.from(padded, 'base64').toString('utf8');
    const r = s.replace(/[a-zA-Z]/g, c => {
      const b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
    });
    if (r.startsWith('http')) return r;
  } catch (_) {}

  // Approach 5: raw is itself the URL path (no encoding)
  if (raw.startsWith('http')) return raw;

  return null; // all approaches failed
}

// ─── AllAnime clock endpoint ──────────────────────────────────────────────────
async function aaClockLinks(clockUrl) {
  if (!clockUrl?.startsWith('http')) return [];
  try {
    const res = await http.get(clockUrl, { headers: AA_H, timeout: 6000 });
    return Array.isArray(res.data?.links) ? res.data.links : [];
  } catch (_) { return []; }
}

// ─── ok.ru video extraction (FIXED) ──────────────────────────────────────────
// The ok.ru DK API returns JSON: {"movie":{"hls":"https://...m3u8",...}}
// We just need to hit the right endpoint and extract movie.hls
async function extractOkRu(rawUrl) {
  const videoId = rawUrl.match(/(?:videoembed\/|\/video\/)(\d+)/)?.[1];
  if (!videoId) return null;

  try {
    // Use ok.ru's video metadata API (returns JSON directly)
    const res = await http.get(
      `https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${videoId}`,
      {
        headers: {
          'Referer':          'https://ok.ru',
          'Accept':           'application/json, text/javascript, */*',
          'Accept-Language':  'en-US,en;q=0.9',
          'User-Agent':       UA,
        },
        timeout: 6000,
        // Force response as text so we can manually parse
        responseType: 'text',
      }
    );

    // res.data is now guaranteed to be a string
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Parse JSON
    let data;
    try { data = JSON.parse(text); } catch (_) { data = null; }

    if (data?.movie) {
      // Direct HLS URL
      const hls = data.movie.hls || data.movie.hlsUrl || data.movie.hlsManifestUrl;
      if (hls && hls.startsWith('http')) return hls;

      // Check videos array
      const vids = data.movie.videos || data.movie.seekMap?.videos || [];
      for (const v of vids) {
        if (v.url && v.url.includes('.m3u8')) return v.url;
        if (v.url && v.url.includes('.mp4')) return v.url;
      }
    }

    // Regex fallback: find m3u8 URL anywhere in the JSON text
    const m3u8Match = text.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (m3u8Match) return m3u8Match[1];

    const mp4Match = text.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (mp4Match) return mp4Match[1];

    console.log('[ok.ru] No video URL found in response. Keys:', data ? Object.keys(data.movie || {}).join(', ') : 'parse failed');
    return null;
  } catch (err) {
    console.error('[ok.ru]', err.message);
    return null;
  }
}

// ─── Process individual source ────────────────────────────────────────────────
async function processSource(src, type, title, epNum) {
  const sname  = (src.sourceName || '').toLowerCase();
  const rawUrl = src.sourceUrl;
  if (!rawUrl) return null;

  // Skip known-unusable sources
  if (['default', 'sup', 'uni', 'vid-mp4'].includes(sname)) return null;
  if (rawUrl.includes('mp4upload') || rawUrl.includes('youtube') || rawUrl.includes('youtu.be')) return null;
  if (rawUrl.endsWith('.html') || rawUrl.includes('/embed-')) return null;

  // ok.ru → extract HLS
  if (rawUrl.includes('ok.ru')) {
    const url = await extractOkRu(rawUrl);
    if (url) {
      return [{ url, name: `[${type.toUpperCase()}] ok.ru`, title: `[${type.toUpperCase()}] ${title} Ep${epNum}`, behaviorHints: { notWebReady: url.includes('.m3u8'), headers: { Referer: 'https://ok.ru' } } }];
    }
    return null;
  }

  // Decode "--" encoded URLs
  const decoded = rawUrl.startsWith('--') ? aaDecode(rawUrl) : (rawUrl.startsWith('http') ? rawUrl : null);
  if (!decoded) { console.log(`[AA] ${src.sourceName}: decode failed for "${rawUrl.substring(0,30)}"`); return null; }

  console.log(`[AA] ${src.sourceName} → ${decoded.substring(0, 80)}`);

  // Clock URL → actual HLS links
  if (decoded.includes('allanime') || decoded.includes('/clock') || decoded.includes('blog.allanime')) {
    const links = await aaClockLinks(decoded);
    const results = [];
    for (const lnk of links.slice(0, 3)) {
      const url = lnk.link || lnk.url;
      if (!url?.startsWith('http')) continue;
      results.push({ url, name: `[${type.toUpperCase()}] ${lnk.resolutionStr || 'auto'}`, title: `[${type.toUpperCase()}] ${title} Ep${epNum}`.trim(), behaviorHints: { notWebReady: !lnk.mp4, headers: { Referer: 'https://allanime.to' } } });
    }
    return results.length ? results : null;
  }

  // Direct video URL
  if (decoded.includes('.m3u8') || decoded.includes('.mp4') || decoded.includes('manifest')) {
    return [{ url: decoded, name: `[${type.toUpperCase()}] ${src.sourceName || 'HLS'}`, title: `[${type.toUpperCase()}] ${title} Ep${epNum}`, behaviorHints: { notWebReady: decoded.includes('.m3u8'), headers: { Referer: 'https://allanime.to' } } }];
  }

  return null;
}

// ─── Main stream pipeline ─────────────────────────────────────────────────────
async function getAllAnimeStreams(title, epNum) {
  const streams = [];
  for (const type of ['sub', 'dub']) {
    try {
      const shows = await aaSearch(title, type);
      if (!shows.length) continue;
      const show = shows[0];
      console.log(`[AA] "${show.name}" matched for "${title}" (${type})`);
      const sourceUrls = await aaSourceUrls(show._id, epNum, type);
      console.log(`[AA] Sources (${type}):`, sourceUrls.map(s => s.sourceName).join(', '));

      // Priority: Luf-Mp4, S-mp4, Fm-Hls, Ss-Hls, Ok, Mp4, Yt-mp4
      const priority = ['luf-mp4', 's-mp4', 'fm-hls', 'ss-hls', 'ok', 'mp4', 'yt-mp4'];
      const sorted   = [...sourceUrls].sort((a, b) => {
        const ai = priority.indexOf((a.sourceName||'').toLowerCase()); const bi = priority.indexOf((b.sourceName||'').toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      for (const src of sorted.slice(0, 6)) {
        try {
          const result = await processSource(src, type, title, epNum);
          if (Array.isArray(result)) streams.push(...result);
          else if (result) streams.push(result);
          if (streams.length >= 6) break; // enough streams
        } catch (e) { console.error(`[AA ${src.sourceName}]`, e.message); }
      }
    } catch (err) { console.error(`[AA ${type}]`, err.message); }
  }
  return streams;
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────
async function getTrending(skip = 0) {
  const p = Math.floor(skip/20)+1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:TRENDING_DESC,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function getLatest(skip = 0) {
  const p = Math.floor(skip/20)+1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:UPDATED_AT_DESC,type:ANIME,status:RELEASING,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function searchAnime(query, skip = 0) {
  const p = Math.floor(skip/20)+1;
  const d = await anilist(`query($q:String,$p:Int){Page(page:$p,perPage:20){media(search:$q,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {q:query,p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function getMovies(skip = 0) {
  const p = Math.floor(skip/20)+1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:POPULARITY_DESC,type:ANIME,format:MOVIE){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(m=>({...alToMeta(m),type:'movie'})).filter(Boolean);
}

// ─── META ─────────────────────────────────────────────────────────────────────
async function getAnimeMeta(rawId) {
  const alId = parseInt(rawId.replace(/^al/,''),10);
  if (!alId) return {id:`animekai:${rawId}`,type:'series',name:rawId};
  const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){id format episodes title{english romaji}coverImage{large extraLarge}bannerImage description(asHtml:false)genres}}`, {id:alId});
  const m = d?.Media;
  if (!m) return {id:`animekai:${rawId}`,type:'series',name:rawId};
  const isMovie = m.format==='MOVIE', count = m.episodes||(isMovie?1:12), name = cleanTitle(m.title?.english||m.title?.romaji);
  return {id:`animekai:${rawId}`,type:isMovie?'movie':'series',name,description:m.description?.replace(/<[^>]*>/g,'')||undefined,poster:m.coverImage?.extraLarge||m.coverImage?.large||undefined,background:m.bannerImage||undefined,genres:m.genres||undefined,videos:Array.from({length:Math.min(count,500)},(_,i)=>({id:`animekai:${rawId}:${i+1}`,title:`Episode ${i+1}`,season:1,episode:i+1}))};
}
async function getEpisodeList() { return []; }

// ─── STREAMS ──────────────────────────────────────────────────────────────────
async function getStreams(rawAnimeId, epNum) {
  const alId = parseInt(rawAnimeId.replace(/^al/,''),10);
  if (!alId) return [];
  try {
    const d     = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, {id:alId});
    const title = cleanTitle(d?.Media?.title?.english||d?.Media?.title?.romaji);
    if (!title) return [];
    console.log(`[Streams] "${title}" ep${epNum}`);
    const streams = await getAllAnimeStreams(title, epNum);
    console.log(`[Streams] ${streams.length} direct streams`);
    return streams;
  } catch (err) { console.error('[getStreams]', err.message); return []; }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────
async function getDebugInfo() {
  const out = { anilist: null, okru_test: null, luf_decode: null, stream_test: null, errors: {} };

  try {
    const d = await getTrending(0);
    out.anilist = { working: true, count: d.length, sample: d.slice(0,3).map(a=>a.name) };
  } catch (e) { out.errors.anilist = e.message; }

  // Test ok.ru extraction with a known video ID
  try {
    const testId = '9373914499730';
    const res = await http.get(`https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${testId}`, {
      headers: { Referer: 'https://ok.ru', 'User-Agent': UA, Accept: 'application/json, text/javascript, */*' },
      responseType: 'text', timeout: 6000,
    });
    const text = res.data;
    let data; try { data = JSON.parse(text); } catch(_){}
    out.okru_test = {
      responseType: typeof text,
      hasMovieKey:  !!data?.movie,
      movieKeys:    data?.movie ? Object.keys(data.movie).slice(0,10).join(', ') : 'n/a',
      hlsFound:     !!(data?.movie?.hls),
      hlsUrl:       (data?.movie?.hls || '').substring(0, 60),
    };
  } catch (e) { out.errors.okru = e.message; }

  // Test Luf-Mp4 decode with a live fetch
  try {
    const shows = await aaSearch('Naruto', 'sub');
    if (shows.length) {
      const srcs = await aaSourceUrls(shows[0]._id, '1', 'sub');
      const luf  = srcs.find(s => (s.sourceName||'').toLowerCase().includes('luf'));
      if (luf?.sourceUrl) {
        const decoded = aaDecode(luf.sourceUrl);
        out.luf_decode = {
          rawStart:   luf.sourceUrl.substring(0, 25),
          decoded:    (decoded||'null').substring(0, 80),
          isHttp:     decoded?.startsWith('http'),
        };
        if (decoded?.startsWith('http') && (decoded.includes('clock') || decoded.includes('allanime'))) {
          const links = await aaClockLinks(decoded);
          out.luf_decode.clockLinks = links.slice(0,2).map(l=>({res:l.resolutionStr, url:(l.link||'').substring(0,60)}));
        }
      }
    }
  } catch (e) { out.errors.luf = e.message; }

  // Test full stream pipeline
  try {
    const streams = await getAllAnimeStreams('Naruto', '1');
    out.stream_test = { count: streams.length, sample: streams.slice(0,3).map(s=>({name:s.name,url:(s.url||'').substring(0,60)})) };
  } catch (e) { out.errors.stream_test = e.message; }

  return out;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
