// scraper.js v8
// Root cause fixes:
//   BUG 1: Buffer.from(b64,'base64').toString('utf-8') → garbage
//           FIX:  Buffer.from(b64,'base64').toString('latin1') ← correct
//   BUG 2: ok.ru embed pages returned as stream URL → playback error
//           FIX:  Fetch ok.ru page and extract direct video URL from JSON
//   BUG 3: mp4upload embed pages included
//           FIX:  Skip them entirely (can't be extracted without browser)
//
// Catalog+Meta : AniList GraphQL (confirmed ✓)
// Streams      : AllAnime API   (Luf-Mp4 clock HLS + Ok.ru direct)

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

// ─── AllAnime ─────────────────────────────────────────────────────────────────
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

// ─── THE KEY FIX: use latin1 not utf-8 ───────────────────────────────────────
// AllAnime encodes: "--" + base64(rot13(url))
// Decode:          rot13( base64decode_as_latin1(str_without_prefix) )
function aaDecode(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  if (!encoded.startsWith('--')) return encoded;
  try {
    const b64 = encoded.slice(2);
    // CRITICAL: must use 'latin1', NOT 'utf-8' — utf-8 corrupts non-ASCII bytes
    const rot13str = Buffer.from(b64, 'base64').toString('latin1');
    // Apply ROT13 to get the actual URL
    return rot13str.replace(/[a-zA-Z]/g, c => {
      const b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
    });
  } catch (_) { return null; }
}

// ─── AllAnime clock endpoint → actual HLS/mp4 links ──────────────────────────
async function aaClockLinks(clockUrl) {
  if (!clockUrl || !clockUrl.startsWith('http')) return [];
  try {
    const res = await http.get(clockUrl, { headers: { ...AA_H }, timeout: 6000 });
    return Array.isArray(res.data?.links) ? res.data.links : [];
  } catch (_) { return []; }
}

// ─── Ok.ru direct video extraction ───────────────────────────────────────────
// ok.ru embed page contains JSON with actual video URLs in data-options attribute
async function extractOkRu(embedUrl) {
  try {
    const videoId = embedUrl.match(/videoembed\/(\d+)/)?.[1];
    if (!videoId) return null;

    // Ok.ru metadata API — returns video info including HLS URL
    const apiUrl = `https://ok.ru/video/${videoId}`;
    const res    = await http.get(apiUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 6000,
    });

    const html = res.data || '';

    // Extract JSON from data-options or flashvars
    const dataMatch = html.match(/data-options="([^"]+)"/);
    if (dataMatch) {
      const jsonStr  = dataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const jsonData = JSON.parse(jsonStr);
      // Find HLS manifest URL in nested metadata
      const flashvars = jsonData?.flashvars || jsonData?.videoSrc || jsonData;
      const hlsUrl = findHlsInObj(flashvars);
      if (hlsUrl) return hlsUrl;
    }

    // Fallback: regex search for m3u8 or dash manifest in HTML
    const m3u8 = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
    if (m3u8) return m3u8[1];

    return null;
  } catch (_) { return null; }
}

function findHlsInObj(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (typeof obj === 'string' && obj.includes('.m3u8')) return obj;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && (v.includes('.m3u8') || v.includes('hls'))) return v;
    if (typeof v === 'object') { const r = findHlsInObj(v, depth + 1); if (r) return r; }
  }
  return null;
}

// ─── Main stream pipeline ─────────────────────────────────────────────────────
// Sources processed in priority order:
//   Luf-Mp4, S-mp4  → decode → clock URL → HLS  ✓ (direct, best quality)
//   Fm-Hls          → decode → m3u8 URL          ✓ (direct HLS)
//   Ok              → ok.ru embed → extract HLS   ✓ (requires extra fetch)
//   Mp4             → SKIP (mp4upload embed, can't extract)
//   Yt-mp4          → decode → may be YouTube URL (Stremio can't play)

const SKIP_SOURCES = ['default', 'sup', 'uni'];                            // unsupported
const EMBED_SKIP   = ['mp4upload.com', 'youtu.be', 'youtube.com'];        // embed pages

async function processSource(src, type, title, epNum) {
  const name = (src.sourceName || '').toLowerCase();
  const rawUrl = src.sourceUrl;

  if (!rawUrl) return null;
  if (SKIP_SOURCES.includes(name)) return null;

  // Ok.ru — extract direct video
  if (rawUrl.includes('ok.ru')) {
    const videoUrl = await extractOkRu(rawUrl);
    if (videoUrl) {
      return { url: videoUrl, name: `[${type.toUpperCase()}] Ok.ru auto`, title: `[${type.toUpperCase()}] ${title} Ep${epNum}`, behaviorHints: { notWebReady: videoUrl.includes('.m3u8'), headers: { Referer: 'https://ok.ru' } } };
    }
    // Fall through — ok.ru embed itself sometimes works in Stremio's player
    // Only include if it doesn't contain /videoembed (that's definitely embed page)
    if (rawUrl.includes('videoembed')) return null;
    return null;
  }

  // Skip known embed pages that can't be played
  if (EMBED_SKIP.some(d => rawUrl.includes(d))) return null;
  if (rawUrl.endsWith('.html') || rawUrl.includes('/embed-')) return null;

  // Decode "--" encoded URLs
  const decoded = rawUrl.startsWith('--') ? aaDecode(rawUrl) : rawUrl;
  if (!decoded || typeof decoded !== 'string') return null;

  console.log(`[AA] ${src.sourceName} decoded: ${decoded.substring(0, 80)}`);

  // Valid http URL check
  if (!decoded.startsWith('http')) return null;

  // Clock URL → fetch actual HLS links
  if (decoded.includes('allanime') || decoded.includes('/clock')) {
    const links = await aaClockLinks(decoded);
    const results = [];
    for (const lnk of links.slice(0, 3)) {
      const videoUrl = lnk.link || lnk.url;
      if (!videoUrl || !videoUrl.startsWith('http')) continue;
      const res = lnk.resolutionStr || lnk.resolution || 'auto';
      results.push({
        url:   videoUrl,
        name:  `[${type.toUpperCase()}] ${res}`,
        title: `[${type.toUpperCase()}] ${title} Ep${epNum} ${res}`.trim(),
        behaviorHints: { notWebReady: !lnk.mp4, headers: { Referer: 'https://allanime.to' } },
      });
    }
    return results.length ? results : null;
  }

  // Direct video URL (m3u8 or mp4)
  if (decoded.includes('.m3u8') || decoded.includes('.mp4') || decoded.includes('manifest')) {
    return [{
      url:   decoded,
      name:  `[${type.toUpperCase()}] ${src.sourceName || 'HLS'}`,
      title: `[${type.toUpperCase()}] ${title} Ep${epNum}`.trim(),
      behaviorHints: { notWebReady: decoded.includes('.m3u8'), headers: { Referer: 'https://allanime.to' } },
    }];
  }

  // Unknown — try including as-is if it looks like a video URL
  return null;
}

async function getAllAnimeStreams(title, epNum) {
  const streams = [];

  for (const type of ['sub', 'dub']) {
    try {
      const shows = await aaSearch(title, type);
      if (!shows.length) { console.log(`[AA] No shows for "${title}" (${type})`); continue; }

      const show = shows[0];
      console.log(`[AA] "${show.name}" matched for "${title}" (${type})`);

      const sourceUrls = await aaSourceUrls(show._id, epNum, type);
      console.log(`[AA] Sources (${type}): ${sourceUrls.map(s => s.sourceName).join(', ')}`);

      // Priority order: Luf-Mp4/S-mp4 first (best HLS), then Ok, then others
      const priority = ['luf-mp4', 's-mp4', 'fm-hls', 'ok', 'mp4', 'yt-mp4'];
      const sorted   = [...sourceUrls].sort((a, b) => {
        const ai = priority.indexOf((a.sourceName||'').toLowerCase());
        const bi = priority.indexOf((b.sourceName||'').toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      for (const src of sorted.slice(0, 5)) {
        try {
          const result = await processSource(src, type, title, epNum);
          if (Array.isArray(result)) streams.push(...result);
          else if (result) streams.push(result);
        } catch (e) {
          console.error(`[AA ${src.sourceName}]`, e.message);
        }
      }
    } catch (err) {
      console.error(`[AA ${type}]`, err.message);
    }
  }

  return streams;
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────

async function getTrending(skip = 0) {
  const p = Math.floor(skip / 20) + 1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:TRENDING_DESC,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { p });
  return (d?.Page?.media || []).map(alToMeta).filter(Boolean);
}
async function getLatest(skip = 0) {
  const p = Math.floor(skip / 20) + 1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:UPDATED_AT_DESC,type:ANIME,status:RELEASING,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { p });
  return (d?.Page?.media || []).map(alToMeta).filter(Boolean);
}
async function searchAnime(query, skip = 0) {
  const p = Math.floor(skip / 20) + 1;
  const d = await anilist(`query($q:String,$p:Int){Page(page:$p,perPage:20){media(search:$q,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { q: query, p });
  return (d?.Page?.media || []).map(alToMeta).filter(Boolean);
}
async function getMovies(skip = 0) {
  const p = Math.floor(skip / 20) + 1;
  const d = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:POPULARITY_DESC,type:ANIME,format:MOVIE){id format title{english romaji}coverImage{large extraLarge}}}}`, { p });
  return (d?.Page?.media || []).map(m => ({ ...alToMeta(m), type: 'movie' })).filter(Boolean);
}

// ─── META ─────────────────────────────────────────────────────────────────────

async function getAnimeMeta(rawId) {
  const alId = parseInt(rawId.replace(/^al/, ''), 10);
  if (!alId) return { id: `animekai:${rawId}`, type: 'series', name: rawId };
  const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){id format episodes title{english romaji}coverImage{large extraLarge}bannerImage description(asHtml:false)genres}}`, { id: alId });
  const m = d?.Media;
  if (!m) return { id: `animekai:${rawId}`, type: 'series', name: rawId };
  const isMovie = m.format === 'MOVIE';
  const count   = m.episodes || (isMovie ? 1 : 12);
  const name    = cleanTitle(m.title?.english || m.title?.romaji);
  return {
    id: `animekai:${rawId}`, type: isMovie ? 'movie' : 'series', name,
    description: m.description?.replace(/<[^>]*>/g, '') || undefined,
    poster: m.coverImage?.extraLarge || m.coverImage?.large || undefined,
    background: m.bannerImage || undefined, genres: m.genres || undefined,
    videos: Array.from({ length: Math.min(count, 500) }, (_, i) => ({ id: `animekai:${rawId}:${i+1}`, title: `Episode ${i+1}`, season: 1, episode: i+1 })),
  };
}

async function getEpisodeList() { return []; }

// ─── STREAMS ──────────────────────────────────────────────────────────────────

async function getStreams(rawAnimeId, epNum) {
  const alId = parseInt(rawAnimeId.replace(/^al/, ''), 10);
  if (!alId) return [];
  try {
    const d     = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = cleanTitle(d?.Media?.title?.english || d?.Media?.title?.romaji);
    if (!title) return [];
    console.log(`[Streams] "${title}" ep${epNum}`);
    const streams = await getAllAnimeStreams(title, epNum);
    console.log(`[Streams] ${streams.length} direct streams found`);
    return streams;
  } catch (err) { console.error('[getStreams]', err.message); return []; }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const out = { anilist: null, allanime_decode: null, streamTest: null, errors: {} };

  try {
    const d = await getTrending(0);
    out.anilist = { working: true, count: d.length, sample: d.slice(0, 3).map(a => a.name) };
  } catch (e) { out.errors.anilist = e.message; }

  // Test decode fix
  try {
    const shows = await aaSearch('Naruto', 'sub');
    if (shows.length) {
      const srcs = await aaSourceUrls(shows[0]._id, '1', 'sub');
      const luf  = srcs.find(s => (s.sourceName||'').toLowerCase().includes('luf'));
      if (luf?.sourceUrl) {
        const decoded = aaDecode(luf.sourceUrl);
        out.allanime_decode = {
          sourceName: luf.sourceName,
          rawUrlStart: (luf.sourceUrl||'').substring(0,20),
          decodedUrl:  (decoded||'').substring(0,100),
          isValidHttp: typeof decoded === 'string' && decoded.startsWith('http'),
        };
        if (decoded?.startsWith('http') && (decoded.includes('allanime') || decoded.includes('clock'))) {
          const links = await aaClockLinks(decoded);
          out.allanime_decode.clockLinks = links.slice(0,2).map(l => ({ res: l.resolutionStr, url: (l.link||'').substring(0,60), mp4: l.mp4 }));
        }
      }
    }
  } catch (e) { out.errors.allanime_decode = e.message; }

  try {
    const streams = await getAllAnimeStreams('Naruto', '1');
    out.streamTest = { count: streams.length, sample: streams.slice(0,3).map(s => ({ name: s.name, url: (s.url||'').substring(0,60) })) };
  } catch (e) { out.errors.streamTest = e.message; }

  return out;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
