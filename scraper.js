// scraper.js v10
//
// DECODE FIX (cracked from analysis):
//   AllAnime Luf-Mp4/S-mp4 encoding:
//     1. Hex decode the string after "--"
//     2. 0x17 bytes → '/'  (path separator)
//     3. All other bytes → chr(byte + 23)  (shift by 23)
//     4. Prepend 'https://allanime.day' as base URL
//
// OTHER FIXES:
//   ok.ru: scrape HTML page, extract from data-options JSON (not dk API)
//   mp4upload: extract direct video URL from embed HTML
//   Fm-Hls: decode same way as Luf-Mp4 → direct HLS

const axios = require('axios');

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http  = axios.create({ timeout: 8000, headers: { 'User-Agent': UA } });

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
  const res = await axios.post(AA_API, { query, variables }, { headers: { ...AA_H, 'Content-Type': 'application/json' }, timeout: 8000 });
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

// ─── CRACKED DECODE: hex → (0x17='/', others += 23) → prepend base ────────────
const AA_BASE_URLS = [
  'https://allanime.day',
  'https://blog.allanime.pro',
  'https://allanime.pro',
];

function aaDecode(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  if (!encoded.startsWith('--')) return encoded.startsWith('http') ? encoded : null;

  const hex = encoded.slice(2);
  // Must be valid hex
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;

  try {
    const bytes = Buffer.from(hex, 'hex');
    let path = '';
    for (const b of bytes) {
      if (b === 0x17) {
        path += '/';
      } else {
        path += String.fromCharCode(b + 23);
      }
    }
    // path is something like /p_hecfn/rkn/bn/neh/rkn/rkn/
    // Try each base URL
    for (const base of AA_BASE_URLS) {
      const full = base + path;
      if (full.startsWith('http')) return full;
    }
    return null;
  } catch (_) { return null; }
}

// ─── AllAnime clock endpoint → actual video links ─────────────────────────────
async function aaClockLinks(clockUrl) {
  if (!clockUrl?.startsWith('http')) return [];
  try {
    const res = await http.get(clockUrl, { headers: AA_H, timeout: 6000 });
    return Array.isArray(res.data?.links) ? res.data.links : [];
  } catch (_) { return []; }
}

// ─── ok.ru extraction via HTML page scraping ──────────────────────────────────
async function extractOkRu(rawUrl) {
  const videoId = rawUrl.match(/(?:videoembed\/|\/video\/)(\d+)/)?.[1];
  if (!videoId) return null;

  try {
    // Fetch the actual video page HTML (not the dk API)
    const res = await http.get(`https://ok.ru/video/${videoId}`, {
      headers: { 'Referer': 'https://ok.ru', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA },
      timeout: 7000,
    });

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Find data-options attribute which contains video JSON
    const dataOptionsMatch = html.match(/data-options="([^"]+)"/);
    if (dataOptionsMatch) {
      const jsonStr = dataOptionsMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      try {
        const opts = JSON.parse(jsonStr);
        // Recursively search for HLS/MP4 URLs
        const url = findVideoUrl(opts);
        if (url) { console.log('[ok.ru] Found:', url.substring(0, 60)); return url; }
      } catch (_) {}
    }

    // Fallback: regex search for m3u8 in full HTML
    const m3u8 = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,200})["']/);
    if (m3u8) return m3u8[1];

    const mp4 = html.match(/["'](https?:\/\/[^"']+\.mp4[^"']{0,200})["']/);
    if (mp4) return mp4[1];

    console.log('[ok.ru] No video URL found for videoId:', videoId);
    return null;
  } catch (err) {
    console.error('[ok.ru]', err.message);
    return null;
  }
}

function findVideoUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj === 'string') return (obj.includes('.m3u8') || obj.includes('.mp4')) && obj.startsWith('http') ? obj : null;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.startsWith('http') && (v.includes('.m3u8') || v.includes('.mp4') || v.includes('/hls/'))) return v;
    if (typeof v === 'object') { const r = findVideoUrl(v, depth + 1); if (r) return r; }
  }
  return null;
}

// ─── mp4upload extraction ──────────────────────────────────────────────────────
async function extractMp4Upload(embedUrl) {
  try {
    const res = await http.get(embedUrl, {
      headers: { 'Referer': 'https://www.mp4upload.com/', 'User-Agent': UA },
      timeout: 6000,
    });
    const html = typeof res.data === 'string' ? res.data : '';

    // mp4upload player source URLs
    const srcMatch = html.match(/(?:src|file)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
    if (srcMatch) return srcMatch[1];

    // Alternative: look for any mp4/m3u8 URL
    const anyMatch = html.match(/["'](https?:\/\/[^"']*(?:storage|cdn|s\d)[^"']*\.(?:mp4|m3u8)[^"']*)["']/);
    if (anyMatch) return anyMatch[1];

    return null;
  } catch (_) { return null; }
}

// ─── Process individual source ────────────────────────────────────────────────
async function processSource(src, type, title, epNum) {
  const sname  = (src.sourceName || '').toLowerCase();
  const rawUrl  = src.sourceUrl;
  if (!rawUrl) return null;
  if (['default', 'sup', 'uni', 'vid-mp4'].includes(sname)) return null;
  if (rawUrl.includes('youtube') || rawUrl.includes('youtu.be')) return null;

  const label = `[${type.toUpperCase()}]`;

  // ok.ru → extract HLS from HTML
  if (rawUrl.includes('ok.ru')) {
    const url = await extractOkRu(rawUrl);
    if (url) return [{ url, name: `${label} ok.ru`, title: `${label} ${title} Ep${epNum}`, behaviorHints: { notWebReady: url.includes('.m3u8'), headers: { Referer: 'https://ok.ru' } } }];
    return null;
  }

  // mp4upload → extract direct video
  if (rawUrl.includes('mp4upload')) {
    const url = await extractMp4Upload(rawUrl);
    if (url) return [{ url, name: `${label} mp4upload`, title: `${label} ${title} Ep${epNum}`, behaviorHints: { notWebReady: url.includes('.m3u8'), headers: { Referer: 'https://www.mp4upload.com/' } } }];
    return null;
  }

  // Encoded URLs (Luf-Mp4, S-mp4, Fm-Hls, Yt-mp4)
  const decoded = rawUrl.startsWith('--') ? aaDecode(rawUrl) : (rawUrl.startsWith('http') ? rawUrl : null);
  if (!decoded) { console.log(`[AA] ${src.sourceName}: decode failed`); return null; }

  console.log(`[AA] ${src.sourceName} decoded: ${decoded.substring(0, 80)}`);

  // Clock URL → fetch actual video links
  if (decoded.includes('allanime') || decoded.includes('/clock') || decoded.includes('blog.allanime')) {
    const links = await aaClockLinks(decoded);
    const results = [];
    for (const lnk of links.slice(0, 3)) {
      const url = lnk.link || lnk.url;
      if (!url?.startsWith('http')) continue;
      results.push({ url, name: `${label} ${lnk.resolutionStr || 'auto'}`, title: `${label} ${title} Ep${epNum}`.trim(), behaviorHints: { notWebReady: !lnk.mp4, headers: { Referer: 'https://allanime.to' } } });
    }
    return results.length ? results : null;
  }

  // Direct video URL
  if (decoded.includes('.m3u8') || decoded.includes('.mp4') || decoded.includes('manifest')) {
    return [{ url: decoded, name: `${label} ${src.sourceName}`, title: `${label} ${title} Ep${epNum}`, behaviorHints: { notWebReady: decoded.includes('.m3u8'), headers: { Referer: 'https://allanime.to' } } }];
  }

  // Unknown URL — include as-is if it looks like a valid media endpoint
  if (decoded.startsWith('http') && !decoded.endsWith('.html')) {
    return [{ url: decoded, name: `${label} ${src.sourceName}`, title: `${label} ${title} Ep${epNum}`, behaviorHints: { notWebReady: true, headers: { Referer: 'https://allanime.to' } } }];
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
      console.log(`[AA] "${show.name}" for "${title}" (${type})`);
      const sourceUrls = await aaSourceUrls(show._id, epNum, type);
      console.log(`[AA] Sources: ${sourceUrls.map(s => s.sourceName).join(', ')}`);

      const priority = ['luf-mp4', 's-mp4', 'fm-hls', 'ss-hls', 'ok', 'mp4', 'yt-mp4'];
      const sorted   = [...sourceUrls].sort((a, b) => {
        const ai = priority.indexOf((a.sourceName||'').toLowerCase()), bi = priority.indexOf((b.sourceName||'').toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      for (const src of sorted.slice(0, 6)) {
        try {
          const result = await processSource(src, type, title, epNum);
          if (Array.isArray(result)) streams.push(...result);
          else if (result) streams.push(result);
          if (streams.length >= 6) break;
        } catch (e) { console.error(`[AA ${src.sourceName}]`, e.message); }
      }
    } catch (err) { console.error(`[AA ${type}]`, err.message); }
  }
  return streams;
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────
async function getTrending(skip = 0) {
  const p = Math.floor(skip/20)+1, d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:TRENDING_DESC,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function getLatest(skip = 0) {
  const p = Math.floor(skip/20)+1, d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:UPDATED_AT_DESC,type:ANIME,status:RELEASING,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function searchAnime(query, skip = 0) {
  const p = Math.floor(skip/20)+1, d = await anilist(`query($q:String,$p:Int){Page(page:$p,perPage:20){media(search:$q,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, {q:query,p});
  return (d?.Page?.media||[]).map(alToMeta).filter(Boolean);
}
async function getMovies(skip = 0) {
  const p = Math.floor(skip/20)+1, d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:POPULARITY_DESC,type:ANIME,format:MOVIE){id format title{english romaji}coverImage{large extraLarge}}}}`, {p});
  return (d?.Page?.media||[]).map(m=>({...alToMeta(m),type:'movie'})).filter(Boolean);
}
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
async function getStreams(rawAnimeId, epNum) {
  const alId = parseInt(rawAnimeId.replace(/^al/,''),10);
  if (!alId) return [];
  try {
    const d = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, {id:alId});
    const title = cleanTitle(d?.Media?.title?.english||d?.Media?.title?.romaji);
    if (!title) return [];
    console.log(`[Streams] "${title}" ep${epNum}`);
    const streams = await getAllAnimeStreams(title, epNum);
    console.log(`[Streams] ${streams.length} streams`);
    return streams;
  } catch (err) { console.error('[getStreams]', err.message); return []; }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────
async function getDebugInfo() {
  const out = { anilist: null, decode_test: null, okru_test: null, stream_test: null, errors: {} };
  try { const d = await getTrending(0); out.anilist = { working: true, count: d.length, sample: d.slice(0,3).map(a=>a.name) }; } catch(e){out.errors.anilist=e.message;}

  // Test decode with known Naruto Luf-Mp4
  try {
    const shows = await aaSearch('Naruto', 'sub');
    if (shows.length) {
      const srcs = await aaSourceUrls(shows[0]._id, '1', 'sub');
      const luf  = srcs.find(s=>(s.sourceName||'').toLowerCase().includes('luf'));
      if (luf?.sourceUrl) {
        const decoded = aaDecode(luf.sourceUrl);
        out.decode_test = { rawStart: luf.sourceUrl.substring(0,25), decoded: (decoded||'null').substring(0,100), isHttp: decoded?.startsWith('http') };
        if (decoded?.startsWith('http')) {
          const links = await aaClockLinks(decoded);
          out.decode_test.clockLinksCount = links.length;
          out.decode_test.clockSample = links.slice(0,2).map(l=>({res:l.resolutionStr,url:(l.link||'').substring(0,60),mp4:l.mp4}));
        }
      }
    }
  } catch(e){out.errors.decode=e.message;}

  // Test ok.ru
  try {
    const url = await extractOkRu('https://ok.ru/videoembed/9373914499730');
    out.okru_test = { url: (url||'null').substring(0,80), found: !!url };
  } catch(e){out.errors.okru=e.message;}

  // Full stream test
  try {
    const streams = await getAllAnimeStreams('Naruto', '1');
    out.stream_test = { count: streams.length, sample: streams.slice(0,3).map(s=>({name:s.name,url:(s.url||'').substring(0,60)})) };
  } catch(e){out.errors.stream_test=e.message;}

  return out;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
