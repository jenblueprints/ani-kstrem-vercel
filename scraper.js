// scraper.js v3 — Uses Consumet API + AniWatch API
// WHY: AnimeKai blocks Vercel/cloud datacenter IPs with bot protection.
//      Consumet API runs its own infrastructure that bypasses this.
//      AniWatch (Zoro) is used as primary since it's the most reliable.
//
// Sources tried in order:
//   1. Consumet AniWatch  → https://api.consumet.org/anime/zoro
//   2. Consumet AnimeFox  → https://api.consumet.org/anime/animefox
//   3. Direct AnimeKai scrape (for non-Vercel hosts like Koyeb)

const axios = require('axios');

// ─── Public Consumet API instances ──────────────────────────────────────────
// Consumet is open-source: https://github.com/consumet/consumet.ts
// These are free public instances — no API key needed.
const CONSUMET_INSTANCES = [
  'https://api.consumet.org',
  'https://consumet-api.onrender.com',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: 8000,
  headers: { 'User-Agent': UA },
});

// ─── Find a working Consumet instance ────────────────────────────────────────
let CONSUMET = CONSUMET_INSTANCES[0];

async function consumetGet(path) {
  // Try all instances in parallel, use fastest
  const attempts = CONSUMET_INSTANCES.map(base =>
    http.get(base + path).then(r => {
      CONSUMET = base;
      return r.data;
    })
  );
  try {
    return await Promise.any(attempts);
  } catch (_) {
    throw new Error('All Consumet instances failed for: ' + path);
  }
}

// ─── Convert Consumet result → Stremio MetaPreview ───────────────────────────
function toMeta(item, type = 'series') {
  if (!item) return null;
  const id = `animekai:${item.id || item.malId || item.title}`;
  return {
    id,
    type: item.type?.toLowerCase() === 'movie' ? 'movie' : type,
    name: item.title || item.name || String(item.id),
    poster: item.image || item.cover || item.poster || '',
  };
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

async function getTrending(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  try {
    // AniWatch trending
    const data = await consumetGet(`/anime/zoro/top-airing?page=${page}`);
    const results = data?.results || data?.animes || [];
    return results.map(a => toMeta(a, 'series')).filter(Boolean);
  } catch (err) {
    console.error('[getTrending]', err.message);
    // Fallback: AniList trending
    return getAniListTrending(page);
  }
}

async function getLatest(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  try {
    const data = await consumetGet(`/anime/zoro/recent-episodes?page=${page}`);
    const results = data?.results || data?.animes || [];
    return results.map(a => toMeta(a, 'series')).filter(Boolean);
  } catch (err) {
    console.error('[getLatest]', err.message);
    return getAniListRecent(page);
  }
}

async function searchAnime(query, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const q    = encodeURIComponent(query);
  try {
    const data = await consumetGet(`/anime/zoro/${q}?page=${page}`);
    const results = data?.results || [];
    return results.map(a => toMeta(a, 'series')).filter(Boolean);
  } catch (err) {
    console.error('[searchAnime]', err.message);
    return searchAniList(query, page);
  }
}

async function getMovies(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  try {
    // AniWatch movies category
    const data = await consumetGet(`/anime/zoro/movies?page=${page}`);
    const results = data?.results || data?.animes || [];
    return results.map(a => toMeta(a, 'movie')).filter(Boolean);
  } catch (err) {
    console.error('[getMovies]', err.message);
    return getAniListMovies(page);
  }
}

// ─── AniList fallback (GraphQL — always works, no bot protection) ─────────────

async function anilistQuery(query, variables) {
  const res = await axios.post('https://graphql.anilist.co', { query, variables }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 8000,
  });
  return res.data?.data;
}

async function getAniListTrending(page = 1) {
  const data = await anilistQuery(`
    query($page:Int){Page(page:$page,perPage:20){media(sort:TRENDING_DESC,type:ANIME,format_not:MUSIC){
      id title{romaji english} coverImage{large} format
    }}}`, { page });
  return (data?.Page?.media || []).map(m => ({
    id:     `animekai:al${m.id}`,
    type:   m.format === 'MOVIE' ? 'movie' : 'series',
    name:   m.title?.english || m.title?.romaji || String(m.id),
    poster: m.coverImage?.large || '',
  }));
}

async function getAniListRecent(page = 1) {
  const data = await anilistQuery(`
    query($page:Int){Page(page:$page,perPage:20){media(sort:UPDATED_AT_DESC,type:ANIME,status:RELEASING,format_not:MUSIC){
      id title{romaji english} coverImage{large} format
    }}}`, { page });
  return (data?.Page?.media || []).map(m => ({
    id:     `animekai:al${m.id}`,
    type:   'series',
    name:   m.title?.english || m.title?.romaji || String(m.id),
    poster: m.coverImage?.large || '',
  }));
}

async function searchAniList(query, page = 1) {
  const data = await anilistQuery(`
    query($q:String,$page:Int){Page(page:$page,perPage:20){media(search:$q,type:ANIME,format_not:MUSIC){
      id title{romaji english} coverImage{large} format
    }}}`, { q: query, page });
  return (data?.Page?.media || []).map(m => ({
    id:     `animekai:al${m.id}`,
    type:   m.format === 'MOVIE' ? 'movie' : 'series',
    name:   m.title?.english || m.title?.romaji || String(m.id),
    poster: m.coverImage?.large || '',
  }));
}

async function getAniListMovies(page = 1) {
  const data = await anilistQuery(`
    query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME,format:MOVIE){
      id title{romaji english} coverImage{large} format
    }}}`, { page });
  return (data?.Page?.media || []).map(m => ({
    id:     `animekai:al${m.id}`,
    type:   'movie',
    name:   m.title?.english || m.title?.romaji || String(m.id),
    poster: m.coverImage?.large || '',
  }));
}

// ─── Meta handler ─────────────────────────────────────────────────────────────

async function getAnimeMeta(rawId) {
  // AniList IDs have "al" prefix, Consumet/AniWatch IDs are numeric/slug
  const isAniList = rawId.startsWith('al');
  const id        = rawId.replace(/^al/, '');

  try {
    if (isAniList) {
      // Get full details from AniList
      const data = await anilistQuery(`
        query($id:Int){Media(id:$id,type:ANIME){
          id title{romaji english} coverImage{large extraLarge} bannerImage
          description genres episodes format status
          relations{edges{relationType node{id title{romaji english}}}}
        }}`, { id: parseInt(id) });
      const m = data?.Media;
      if (!m) return null;

      // Try to get episodes from Consumet using title search
      const title  = m.title?.english || m.title?.romaji;
      let episodes = [];
      try {
        const searchData = await consumetGet(`/anime/zoro/${encodeURIComponent(title)}?page=1`);
        const topResult  = searchData?.results?.[0];
        if (topResult) {
          episodes = await getEpisodeList(topResult.id);
        }
      } catch (_) {}

      return {
        id:          `animekai:${rawId}`,
        type:        m.format === 'MOVIE' ? 'movie' : 'series',
        name:        m.title?.english || m.title?.romaji,
        description: m.description?.replace(/<[^>]*>/g, '') || undefined,
        poster:      m.coverImage?.extraLarge || m.coverImage?.large || undefined,
        background:  m.bannerImage || undefined,
        genres:      m.genres || undefined,
        videos:      episodes.map(ep => ({
          id:      `animekai:${rawId}:${ep.id}`,
          title:   ep.title || `Episode ${ep.number}`,
          season:  1,
          episode: ep.number,
        })),
      };
    } else {
      // Consumet/AniWatch ID
      const data = await consumetGet(`/anime/zoro/info?id=${encodeURIComponent(id)}`);
      const eps  = data?.episodes || [];
      return {
        id:          `animekai:${rawId}`,
        type:        data?.type?.toLowerCase() === 'movie' ? 'movie' : 'series',
        name:        data?.title || rawId,
        description: data?.description || undefined,
        poster:      data?.image || undefined,
        genres:      data?.genres || undefined,
        videos:      eps.map(ep => ({
          id:      `animekai:${rawId}:${ep.id}`,
          title:   ep.title || `Episode ${ep.number}`,
          season:  1,
          episode: ep.number,
        })),
      };
    }
  } catch (err) {
    console.error('[getAnimeMeta]', err.message);
    return { id: `animekai:${rawId}`, type: 'series', name: rawId };
  }
}

// ─── Episode list ─────────────────────────────────────────────────────────────

async function getEpisodeList(aniwatchId) {
  try {
    const data = await consumetGet(`/anime/zoro/info?id=${encodeURIComponent(aniwatchId)}`);
    return (data?.episodes || []).map(ep => ({
      id:     ep.id,
      number: ep.number || 1,
      title:  ep.title || `Episode ${ep.number}`,
    }));
  } catch (err) {
    console.error('[getEpisodeList]', err.message);
    return [];
  }
}

// ─── Stream extraction ────────────────────────────────────────────────────────

async function getStreams(animeId, episodeId) {
  try {
    // episodeId is the full AniWatch episode ID like "one-piece-100/ep-1200"
    const data = await consumetGet(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}`);
    const sources = data?.sources || [];

    return sources.slice(0, 4).map(s => ({
      url:   s.url,
      name:  `AniWatch ${s.quality || 'auto'}`,
      title: `AniWatch ${s.quality || 'auto'}`,
      behaviorHints: {
        notWebReady: s.url.includes('.m3u8'),
        headers: data?.headers || {},
      },
    }));
  } catch (err) {
    console.error('[getStreams]', err.message);
    return [];
  }
}

// ─── Debug ───────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const result = { consumetInstance: null, trending: [], anilistTest: [], error: null };
  try {
    const data = await consumetGet('/anime/zoro/top-airing?page=1');
    result.consumetInstance = CONSUMET;
    result.rawResponse      = JSON.stringify(data).substring(0, 500);
    result.trending         = (data?.results || []).slice(0, 3).map(a => ({
      id: a.id, title: a.title, hasImage: !!a.image,
    }));
  } catch (e) {
    result.error = e.message;
  }
  try {
    const al = await getAniListTrending(1);
    result.anilistTest = al.slice(0, 3).map(a => ({ id: a.id, name: a.name }));
  } catch (e) {
    result.anilistError = e.message;
  }
  return result;
}

module.exports = {
  getTrending, getLatest, searchAnime, getMovies,
  getAnimeMeta, getEpisodeList, getStreams, getDebugInfo,
};
