// scraper.js v7
// Bug fixes vs v6:
//   - AllAnime field is `sourceUrl` NOT `url` (was crashing on every stream)
//   - Source name filter is now case-insensitive
//   - Null-safe everywhere
//
// Catalog+Meta : AniList GraphQL (confirmed ✓)
// Streams      : AllAnime API   (api.allanime.day)

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http = axios.create({ timeout: 8000, headers: { 'User-Agent': UA } });

// ─── Title cleaner ────────────────────────────────────────────────────────────
function cleanTitle(t) {
  if (!t) return t;
  return t
    .replace(/【([^】]*)】\s*/g, '$1 ')
    .replace(/[〔〕「」『』《》〈〉]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── AniList ──────────────────────────────────────────────────────────────────
async function anilist(query, variables = {}) {
  const res = await axios.post('https://graphql.anilist.co', { query, variables }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 8000,
  });
  return res.data?.data;
}

function alToMeta(m) {
  if (!m) return null;
  return {
    id:     `animekai:al${m.id}`,
    type:   m.format === 'MOVIE' ? 'movie' : 'series',
    name:   cleanTitle(m.title?.english || m.title?.romaji || String(m.id)),
    poster: m.coverImage?.extraLarge || m.coverImage?.large || '',
  };
}

// ─── AllAnime ─────────────────────────────────────────────────────────────────
const AA_API = 'https://api.allanime.day/api';
const AA_H   = {
  'Referer': 'https://allanime.to',
  'Origin':  'https://allanime.to',
  'User-Agent': UA,
};

async function aaPost(query, variables) {
  const res = await axios.post(AA_API, { query, variables }, {
    headers: { ...AA_H, 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  return res.data?.data;
}

// Search → array of {_id, name}
async function aaSearch(title, type = 'sub') {
  const d = await aaPost(
    `query($s:SearchInput,$t:VaildTranslationTypeEnumType){shows(search:$s,limit:5,page:1,translationType:$t){edges{_id name englishName}}}`,
    { s: { query: title }, t: type }
  );
  return d?.shows?.edges || [];
}

// Get sourceUrls for one episode
// IMPORTANT: field is `sourceUrl` (singular), NOT `url`
async function aaSourceUrls(showId, epNum, type = 'sub') {
  const d = await aaPost(
    `query($id:String!,$ep:String!,$t:VaildTranslationTypeEnumType!){episode(showId:$id,translationType:$t,episodeString:$ep){sourceUrls}}`,
    { id: showId, ep: String(epNum), t: type }
  );
  return d?.episode?.sourceUrls || [];
}

// Decode --base64rot13 URLs
function aaDecode(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  if (!encoded.startsWith('--')) return encoded;
  try {
    const b64 = encoded.slice(2);
    const str = Buffer.from(b64, 'base64').toString('utf-8');
    return str.replace(/[a-zA-Z]/g, c => {
      const b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
    });
  } catch (_) { return null; }
}

// Fetch real video links from AllAnime clock endpoint
async function aaClockLinks(clockUrl) {
  if (!clockUrl || typeof clockUrl !== 'string') return [];
  try {
    const res = await http.get(clockUrl, {
      headers: { Referer: 'https://allanime.to', Origin: 'https://allanime.to' },
      timeout: 6000,
    });
    return Array.isArray(res.data?.links) ? res.data.links : [];
  } catch (_) { return []; }
}

// Priority source names (case-insensitive match)
const GOOD_SOURCES = ['luf-mp4', 's-mp4', 'mp4', 'yt-mp4', 'ok', 'fm-hls'];

async function getAllAnimeStreams(title, epNum) {
  const streams = [];

  for (const type of ['sub', 'dub']) {
    try {
      const shows = await aaSearch(title, type);
      if (!shows.length) { console.log(`[AA] No shows for "${title}" (${type})`); continue; }

      const show = shows[0];
      console.log(`[AA] Found: "${show.name || show._id}" for "${title}" (${type})`);

      const sourceUrls = await aaSourceUrls(show._id, epNum, type);
      console.log(`[AA] ${sourceUrls.length} sources for ep${epNum} (${type}):`, sourceUrls.map(s => s.sourceName).join(', '));

      // Filter to known-good sources (case-insensitive)
      const good = sourceUrls.filter(s => GOOD_SOURCES.includes((s.sourceName || '').toLowerCase()));
      const toProcess = good.length ? good : sourceUrls.slice(0, 4);

      for (const src of toProcess.slice(0, 4)) {
        // KEY FIX: AllAnime uses `sourceUrl` not `url`
        const rawUrl = src.sourceUrl;
        if (!rawUrl || typeof rawUrl !== 'string') continue;

        // Decode if encoded
        const decoded = rawUrl.startsWith('--') ? aaDecode(rawUrl) : rawUrl;
        if (!decoded || typeof decoded !== 'string') continue;

        console.log(`[AA] Processing ${src.sourceName}: ${decoded.substring(0, 70)}`);

        // Case 1: AllAnime clock endpoint → fetch real links
        if (decoded.includes('allanime') || decoded.includes('clock')) {
          const links = await aaClockLinks(decoded);
          for (const lnk of links.slice(0, 3)) {
            const videoUrl = lnk.link || lnk.url;
            if (!videoUrl || !videoUrl.startsWith('http')) continue;
            const res = lnk.resolutionStr || lnk.resolution || 'auto';
            streams.push({
              url:   videoUrl,
              name:  `[${type.toUpperCase()}] ${res}`,
              title: `[${type.toUpperCase()}] ${title} Ep${epNum} ${res}`.trim(),
              behaviorHints: {
                notWebReady: !lnk.mp4,
                headers: { Referer: 'https://allanime.to' },
              },
            });
          }
        }
        // Case 2: Direct .m3u8 or .mp4 link
        else if (decoded.includes('.m3u8') || decoded.includes('.mp4') || decoded.startsWith('http')) {
          streams.push({
            url:   decoded,
            name:  `[${type.toUpperCase()}] ${src.sourceName || 'direct'}`,
            title: `[${type.toUpperCase()}] ${title} Ep${epNum}`.trim(),
            behaviorHints: {
              notWebReady: decoded.includes('.m3u8'),
              headers: { Referer: 'https://allanime.to' },
            },
          });
        }
      }
    } catch (err) {
      console.error(`[AA ${type}] ${err.message}`);
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
    id:          `animekai:${rawId}`,
    type:        isMovie ? 'movie' : 'series',
    name,
    description: m.description?.replace(/<[^>]*>/g, '') || undefined,
    poster:      m.coverImage?.extraLarge || m.coverImage?.large || undefined,
    background:  m.bannerImage || undefined,
    genres:      m.genres || undefined,
    videos:      Array.from({ length: Math.min(count, 500) }, (_, i) => ({
      id: `animekai:${rawId}:${i + 1}`, title: `Episode ${i + 1}`, season: 1, episode: i + 1,
    })),
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
    console.log(`[Streams] ${streams.length} streams found`);
    return streams;
  } catch (err) {
    console.error('[getStreams]', err.message);
    return [];
  }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const out = { anilist: null, allanime: null, streamTest: null, errors: {} };

  try {
    const d = await getTrending(0);
    out.anilist = { working: true, count: d.length, sample: d.slice(0, 3).map(a => a.name) };
  } catch (e) { out.errors.anilist = e.message; }

  try {
    const shows = await aaSearch('Naruto', 'sub');
    if (!shows.length) throw new Error('search returned 0 results');
    const srcs = await aaSourceUrls(shows[0]._id, '1', 'sub');
    out.allanime = {
      showFound:    shows[0].name || shows[0]._id,
      sourcesCount: srcs.length,
      // Show actual field names
      firstSrc:     srcs[0] ? { sourceName: srcs[0].sourceName, hasSourceUrl: !!srcs[0].sourceUrl, hasUrl: !!srcs[0].url } : null,
      sourceNames:  srcs.map(s => s.sourceName).join(', '),
    };

    // Test decode + clock
    const luf = srcs.find(s => (s.sourceName || '').toLowerCase().includes('luf') || (s.sourceName || '').toLowerCase().includes('mp4'));
    if (luf?.sourceUrl) {
      const decoded = aaDecode(luf.sourceUrl) || luf.sourceUrl;
      out.allanime.decodedUrl = (decoded || '').substring(0, 80);
      if (decoded && (decoded.includes('allanime') || decoded.includes('clock'))) {
        const links = await aaClockLinks(decoded);
        out.allanime.clockLinksCount = links.length;
        out.allanime.clockSample     = links.slice(0, 2).map(l => ({ res: l.resolutionStr, url: (l.link||'').substring(0,60) }));
        out.allanime.working         = links.length > 0;
      } else if (decoded) {
        out.allanime.working = true;
        out.allanime.directUrl = decoded.substring(0, 80);
      }
    }
  } catch (e) { out.errors.allanime = e.message; }

  // Test a real anime stream
  try {
    const streams = await getAllAnimeStreams('Naruto', '1');
    out.streamTest = { count: streams.length, sample: streams.slice(0, 2).map(s => ({ name: s.name, urlStart: (s.url||'').substring(0,50) })) };
  } catch (e) { out.errors.streamTest = e.message; }

  return out;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
