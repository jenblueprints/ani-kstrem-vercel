// scraper.js v5
// Catalog + Meta : AniList GraphQL  (confirmed working)
// Episodes+Stream: HiAnime API v2   (correct endpoints)
//                  AllAnime GraphQL  (fallback)
//
// Title fix: strips Japanese brackets 【】 and cleans special chars

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http = axios.create({ timeout: 8000, headers: { 'User-Agent': UA } });

// ─── Title cleaner ────────────────────────────────────────────────────────────
function cleanTitle(t) {
  if (!t) return t;
  return t
    .replace(/[【】〔〕「」『』《》〈〉]/g, '')   // Japanese brackets
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── AniList ──────────────────────────────────────────────────────────────────
async function anilist(query, variables = {}) {
  const res = await axios.post(
    'https://graphql.anilist.co',
    { query, variables },
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 8000 }
  );
  return res.data?.data;
}

function alToMeta(m) {
  if (!m) return null;
  const name = cleanTitle(m.title?.english || m.title?.romaji || String(m.id));
  return {
    id:     `animekai:al${m.id}`,
    type:   m.format === 'MOVIE' ? 'movie' : 'series',
    name,
    poster: m.coverImage?.extraLarge || m.coverImage?.large || '',
  };
}

// ─── HiAnime API — v2 endpoints ───────────────────────────────────────────────
// Multiple public instances of https://github.com/ghoshRitesh12/aniwatch-api
const HIANIME = [
  'https://aniwatch-api-dusky.vercel.app',
  'https://aniwatch-api-eight.vercel.app',
  'https://aniwatch-api-one.vercel.app',
  'https://api.aniwatchtv.to',
];

async function hiGet(path) {
  const attempts = HIANIME.map(base =>
    http.get(base + path, { headers: { Accept: 'application/json' } }).then(r => {
      if (typeof r.data !== 'object') throw new Error('non-JSON');
      return r.data;
    })
  );
  try { return await Promise.any(attempts); }
  catch (_) { throw new Error('All HiAnime instances failed: ' + path); }
}

// Search HiAnime — returns first matching anime's ID
async function findHiAnimeId(title) {
  try {
    // v2 endpoint
    const data = await hiGet(`/api/v2/hianime/search?q=${encodeURIComponent(title)}&page=1`);
    const animes = data?.data?.animes || data?.animes || [];
    if (animes.length) return animes[0].id;
  } catch (_) {}
  try {
    // v1 endpoint fallback
    const data = await hiGet(`/anime/search?q=${encodeURIComponent(title)}&page=1`);
    const animes = data?.data?.animes || data?.animes || [];
    if (animes.length) return animes[0].id;
  } catch (_) {}
  return null;
}

async function hiEpisodes(animeId) {
  try {
    const data = await hiGet(`/api/v2/hianime/anime/${encodeURIComponent(animeId)}/episodes`);
    return data?.data?.episodes || data?.episodes || [];
  } catch (_) {}
  try {
    const data = await hiGet(`/anime/episodes/${encodeURIComponent(animeId)}`);
    return data?.data?.episodes || data?.episodes || [];
  } catch (_) { return []; }
}

async function hiSources(episodeId, category = 'sub') {
  try {
    const data = await hiGet(
      `/api/v2/hianime/episode/sources?animeEpisodeId=${encodeURIComponent(episodeId)}&server=hd-1&category=${category}`
    );
    return { sources: data?.data?.sources || [], headers: data?.data?.headers || {} };
  } catch (_) {}
  try {
    const data = await hiGet(
      `/anime/episode-srcs?id=${encodeURIComponent(episodeId)}&server=vidstreaming&category=${category}`
    );
    return { sources: data?.sources || [], headers: data?.headers || {} };
  } catch (_) { return { sources: [], headers: {} }; }
}

// ─── AllAnime GraphQL fallback for streams ────────────────────────────────────
async function allAnimeStream(title, epNum) {
  try {
    const searchRes = await axios.post(
      'https://api.allanime.day/api',
      {
        query: `query($search:SearchInput,$translationType:VaildTranslationTypeEnumType){shows(search:$search,limit:1,page:1,translationType:$translationType){edges{_id name episodes{sourceUrls}}}}`,
        variables: { search: { query: title }, translationType: 'sub' },
      },
      { headers: { 'Content-Type': 'application/json', Referer: 'https://allanime.to' }, timeout: 8000 }
    );
    const show = searchRes.data?.data?.shows?.edges?.[0];
    if (!show) return [];
    const ep = show.episodes?.find(e => String(e.sourceUrls?.episodeIdNum) === String(epNum));
    if (!ep?.sourceUrls) return [];
    return (ep.sourceUrls || []).slice(0, 3).map(s => ({
      url:   s.url,
      name:  `[SUB] AllAnime`,
      title: `[SUB] ${cleanTitle(title)} Ep${epNum}`,
      behaviorHints: { notWebReady: true },
    })).filter(s => s.url?.startsWith('http'));
  } catch (_) { return []; }
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────

async function getTrending(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:TRENDING_DESC,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { p: page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function getLatest(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:UPDATED_AT_DESC,type:ANIME,status:RELEASING,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { p: page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function searchAnime(query, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`query($q:String,$p:Int){Page(page:$p,perPage:20){media(search:$q,type:ANIME,format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]){id format title{english romaji}coverImage{large extraLarge}}}}`, { q: query, p: page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function getMovies(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`query($p:Int){Page(page:$p,perPage:20){media(sort:POPULARITY_DESC,type:ANIME,format:MOVIE){id format title{english romaji}coverImage{large extraLarge}}}}`, { p: page });
  return (data?.Page?.media || []).map(m => ({ ...alToMeta(m), type: 'movie' })).filter(Boolean);
}

// ─── META ─────────────────────────────────────────────────────────────────────

async function getAnimeMeta(rawId) {
  const alId = parseInt(rawId.replace(/^al/, ''), 10);
  if (!alId) return { id: `animekai:${rawId}`, type: 'series', name: rawId };

  const data = await anilist(`query($id:Int){Media(id:$id,type:ANIME){id format episodes title{english romaji}coverImage{large extraLarge}bannerImage description(asHtml:false)genres status}}`, { id: alId });
  const m = data?.Media;
  if (!m) return { id: `animekai:${rawId}`, type: 'series', name: rawId };

  const isMovie  = m.format === 'MOVIE';
  const epCount  = m.episodes || (isMovie ? 1 : 12);
  const name     = cleanTitle(m.title?.english || m.title?.romaji);

  const videos = [];
  for (let i = 1; i <= Math.min(epCount, 500); i++) {
    videos.push({ id: `animekai:${rawId}:${i}`, title: `Episode ${i}`, season: 1, episode: i });
  }

  return {
    id: `animekai:${rawId}`,
    type: isMovie ? 'movie' : 'series',
    name,
    description: m.description?.replace(/<[^>]*>/g, '') || undefined,
    poster:      m.coverImage?.extraLarge || m.coverImage?.large || undefined,
    background:  m.bannerImage || undefined,
    genres:      m.genres || undefined,
    videos,
  };
}

// ─── EPISODE LIST ─────────────────────────────────────────────────────────────

async function getEpisodeList(rawId) {
  const alId = parseInt(rawId.replace(/^al/, ''), 10);
  if (!alId) return [];
  try {
    const data = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = cleanTitle(data?.Media?.title?.english || data?.Media?.title?.romaji);
    if (!title) return [];
    const hiId = await findHiAnimeId(title);
    if (!hiId) return [];
    const eps = await hiEpisodes(hiId);
    return eps.map(ep => ({ id: ep.episodeId || ep.id, number: ep.number, title: ep.title || `Episode ${ep.number}` }));
  } catch (err) {
    console.error('[getEpisodeList]', err.message);
    return [];
  }
}

// ─── STREAMS ──────────────────────────────────────────────────────────────────

async function getStreams(rawAnimeId, epNum) {
  const alId = parseInt(rawAnimeId.replace(/^al/, ''), 10);
  if (!alId) return [];

  try {
    const data  = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = cleanTitle(data?.Media?.title?.english || data?.Media?.title?.romaji);
    if (!title) return [];

    // Find on HiAnime
    const hiId = await findHiAnimeId(title);
    if (hiId) {
      const eps = await hiEpisodes(hiId);
      const ep  = eps.find(e => String(e.number) === String(epNum)) || eps[parseInt(epNum, 10) - 1];
      if (ep) {
        const epId   = ep.episodeId || ep.id;
        const streams = [];

        // Sub streams
        const { sources: subSrc, headers: subH } = await hiSources(epId, 'sub');
        subSrc.slice(0, 3).forEach(s => {
          if (s.url) streams.push({
            url:   s.url,
            name:  `[SUB] ${s.quality || 'auto'}`,
            title: `[SUB] ${title} Ep${epNum}`,
            behaviorHints: { notWebReady: String(s.url).includes('.m3u8'), headers: subH },
          });
        });

        // Dub streams
        const { sources: dubSrc, headers: dubH } = await hiSources(epId, 'dub');
        dubSrc.slice(0, 2).forEach(s => {
          if (s.url) streams.push({
            url:   s.url,
            name:  `[DUB] ${s.quality || 'auto'}`,
            title: `[DUB] ${title} Ep${epNum}`,
            behaviorHints: { notWebReady: String(s.url).includes('.m3u8'), headers: dubH },
          });
        });

        if (streams.length) return streams;
      }
    }

    // Fallback: AllAnime
    console.log('[Streams] HiAnime failed, trying AllAnime for:', title);
    return await allAnimeStream(title, epNum);

  } catch (err) {
    console.error('[getStreams]', err.message);
    return [];
  }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const result = { anilist: null, hianime: null, errors: {} };

  // Test AniList
  try {
    const d = await getTrending(0);
    result.anilist = { working: true, count: d.length, sample: d.slice(0, 3).map(a => a.name) };
  } catch (e) { result.errors.anilist = e.message; }

  // Test HiAnime with both endpoint formats
  for (const instance of HIANIME) {
    for (const path of ['/api/v2/hianime/search?q=naruto&page=1', '/anime/search?q=naruto&page=1']) {
      try {
        const d = await http.get(instance + path);
        const animes = d.data?.data?.animes || d.data?.animes || [];
        if (animes.length) {
          result.hianime = { working: true, instance, path, count: animes.length, sample: animes.slice(0,2).map(a=>a.name||a.id) };
          break;
        }
      } catch (_) {}
    }
    if (result.hianime?.working) break;
  }
  if (!result.hianime) result.errors.hianime = 'All instances returned 0 results';

  return result;
}

module.exports = { getTrending, getLatest, searchAnime, getMovies, getAnimeMeta, getEpisodeList, getStreams, getDebugInfo };
