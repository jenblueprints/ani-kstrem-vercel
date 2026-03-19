// scraper.js v6
// Catalog+Meta : AniList GraphQL  (confirmed working ✓)
// Streams      : AllAnime API     (api.allanime.day — proper 3-step implementation)
//
// Title fix: 【OSHI NO KO】Season 3 → OSHI NO KO Season 3
// AllAnime 3 steps: search → sourceUrls → clock endpoint → actual HLS/mp4

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http = axios.create({ timeout: 8000, headers: { 'User-Agent': UA } });

// ─── Title cleaner ────────────────────────────────────────────────────────────
// 【OSHI NO KO】Season 3  →  OSHI NO KO Season 3
// 【JJK】                  →  JJK
function cleanTitle(t) {
  if (!t) return t;
  return t
    .replace(/【([^】]*)】\s*/g, '$1 ')   // replace 【content】 with "content " (keeps space)
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

// ─── AllAnime API — 3-step stream fetching ────────────────────────────────────
const AA_API = 'https://api.allanime.day/api';
const AA_HEADERS = {
  'Referer':      'https://allanime.to',
  'Origin':       'https://allanime.to',
  'Content-Type': 'application/json',
  'User-Agent':   UA,
};

// Step 1: search for a show, return its _id
async function aaSearch(title, translationType = 'sub') {
  const res = await axios.post(AA_API, {
    query: `query($search:SearchInput,$limit:Int,$page:Int,$translationType:VaildTranslationTypeEnumType){
      shows(search:$search,limit:$limit,page:$page,translationType:$translationType){
        edges{ _id name englishName }
      }
    }`,
    variables: { search: { query: title }, limit: 5, page: 1, translationType },
  }, { headers: AA_HEADERS, timeout: 8000 });
  return res.data?.data?.shows?.edges || [];
}

// Step 2: get sourceUrls for a specific episode
async function aaEpisodeSources(showId, epNum, translationType = 'sub') {
  const res = await axios.post(AA_API, {
    query: `query($showId:String!,$episodeString:String!,$translationType:VaildTranslationTypeEnumType!){
      episode(showId:$showId,translationType:$translationType,episodeString:$episodeString){
        sourceUrls
      }
    }`,
    variables: { showId, episodeString: String(epNum), translationType },
  }, { headers: AA_HEADERS, timeout: 8000 });
  return res.data?.data?.episode?.sourceUrls || [];
}

// Decode AllAnime URL (base64 + ROT13)
function aaDecodeUrl(url) {
  if (!url || !url.startsWith('--')) return url;
  try {
    const b64 = url.slice(2);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    // ROT13
    return decoded.replace(/[a-zA-Z]/g, c => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
  } catch (_) { return url; }
}

// Step 3: fetch actual HLS/mp4 links from the clock endpoint
async function aaClockFetch(clockUrl) {
  try {
    const res = await http.get(clockUrl, {
      headers: { Referer: 'https://allanime.to', Origin: 'https://allanime.to' },
      timeout: 6000,
    });
    // Response: { links: [{ link: 'https://...m3u8', resolutionStr: '1080', mp4: false }] }
    return res.data?.links || [];
  } catch (_) { return []; }
}

// Full stream pipeline for AllAnime
async function getAllAnimeStreams(title, epNum) {
  const streams = [];

  for (const type of ['sub', 'dub']) {
    try {
      // Step 1 — find show
      const shows = await aaSearch(title, type);
      if (!shows.length) continue;
      const show = shows[0];

      // Step 2 — get episode sourceUrls
      const sourceUrls = await aaEpisodeSources(show._id, epNum, type);

      // Only use Luf-mp4 and S-mp4 sources (these have actual video links)
      const goodSources = sourceUrls.filter(s =>
        ['Luf-mp4', 'S-mp4', 'Vd-mp4', 'Yt-mp4', 'Default'].includes(s.sourceName)
      );

      for (const src of goodSources.slice(0, 3)) {
        let url = src.url;

        // Decode if encoded
        if (url.startsWith('--')) url = aaDecodeUrl(url);
        if (!url.startsWith('http')) continue;

        // Step 3 — if it's a clock URL, fetch actual video link
        if (url.includes('allanime.day') && url.includes('clock')) {
          const links = await aaClockFetch(url);
          for (const link of links.slice(0, 2)) {
            if (link.link?.startsWith('http')) {
              const res = link.resolutionStr || 'auto';
              streams.push({
                url:   link.link,
                name:  `[${type.toUpperCase()}] AllAnime ${res}`,
                title: `[${type.toUpperCase()}] ${title} Ep${epNum} ${res}`,
                behaviorHints: {
                  notWebReady: link.link.includes('.m3u8') || !link.mp4,
                  headers: { Referer: 'https://allanime.to' },
                },
              });
            }
          }
        } else if (url.includes('.m3u8') || url.includes('.mp4')) {
          // Direct video URL
          streams.push({
            url,
            name:  `[${type.toUpperCase()}] AllAnime`,
            title: `[${type.toUpperCase()}] ${title} Ep${epNum}`,
            behaviorHints: {
              notWebReady: url.includes('.m3u8'),
              headers: { Referer: 'https://allanime.to' },
            },
          });
        }
      }
    } catch (err) {
      console.error(`[AllAnime ${type}]`, err.message);
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
      id:      `animekai:${rawId}:${i + 1}`,
      title:   `Episode ${i + 1}`,
      season:  1,
      episode: i + 1,
    })),
  };
}

async function getEpisodeList(rawId) { return []; }

// ─── STREAMS ──────────────────────────────────────────────────────────────────

async function getStreams(rawAnimeId, epNum) {
  const alId = parseInt(rawAnimeId.replace(/^al/, ''), 10);
  if (!alId) return [];

  try {
    const d     = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = cleanTitle(d?.Media?.title?.english || d?.Media?.title?.romaji);
    if (!title) return [];

    console.log(`[Streams] Searching AllAnime for: "${title}" ep${epNum}`);
    const streams = await getAllAnimeStreams(title, epNum);
    console.log(`[Streams] Found ${streams.length} streams`);
    return streams;
  } catch (err) {
    console.error('[getStreams]', err.message);
    return [];
  }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const result = { anilist: null, allanime: null, errors: {} };

  try {
    const d = await getTrending(0);
    result.anilist = { working: true, count: d.length, sample: d.slice(0, 3).map(a => a.name) };
  } catch (e) { result.errors.anilist = e.message; }

  try {
    // Test AllAnime search
    const shows = await aaSearch('Naruto', 'sub');
    if (shows.length) {
      // Test episode sources
      const srcs = await aaEpisodeSources(shows[0]._id, '1', 'sub');
      result.allanime = {
        working:      true,
        showFound:    shows[0].name || shows[0]._id,
        sourcesCount: srcs.length,
        sourceNames:  srcs.map(s => s.sourceName).join(', '),
      };

      // Test clock URL resolution
      const luf = srcs.find(s => ['Luf-mp4', 'S-mp4'].includes(s.sourceName));
      if (luf) {
        const decoded = aaDecodeUrl(luf.url);
        result.allanime.clockUrl = decoded.substring(0, 60) + '...';
        if (decoded.includes('clock')) {
          const links = await aaClockFetch(decoded);
          result.allanime.clockLinks = links.slice(0, 2).map(l => ({ res: l.resolutionStr, url: (l.link || '').substring(0, 50) }));
        }
      }
    } else {
      result.allanime = { working: false, reason: 'search returned 0 results' };
    }
  } catch (e) { result.errors.allanime = e.message; }

  return result;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
