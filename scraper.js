// scraper.js v4 — AniList Primary + AniWatch Streams
// 
// DIAGNOSIS: api.consumet.org is DEAD (returns GitHub HTML page).
// SOLUTION:  Use AniList GraphQL for ALL catalog/meta (confirmed working).
//            Use AniWatch API for episode lists + streams.
//
// AniList GraphQL: https://graphql.anilist.co  ← FREE, no key, no bot block
// AniWatch API:    public instances             ← handles streams

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: 8000,
  headers: { 'User-Agent': UA, Accept: 'application/json' },
});

// ─── AniList GraphQL helper ───────────────────────────────────────────────────

async function anilist(query, variables = {}) {
  const res = await axios.post(
    'https://graphql.anilist.co',
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 8000,
    }
  );
  return res.data?.data;
}

// Convert AniList media object → Stremio MetaPreview
function alToMeta(m) {
  if (!m) return null;
  return {
    id:     `animekai:al${m.id}`,
    type:   m.format === 'MOVIE' ? 'movie' : 'series',
    name:   m.title?.english || m.title?.romaji || String(m.id),
    poster: m.coverImage?.extraLarge || m.coverImage?.large || '',
  };
}

// ─── AniWatch API instances (for streams) ─────────────────────────────────────
// These are open-source self-hosted instances of the AniWatch API
const ANIWATCH_INSTANCES = [
  'https://aniwatch-api-one.vercel.app',
  'https://api.aniwatchtv.to',
  'https://aniwatch.tuncay.be',
];

async function aniwatchGet(path) {
  const attempts = ANIWATCH_INSTANCES.map(base =>
    http.get(base + path).then(r => r.data)
  );
  try {
    return await Promise.any(attempts);
  } catch (_) {
    throw new Error('All AniWatch instances failed for: ' + path);
  }
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────

async function getTrending(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`
    query($page:Int) {
      Page(page:$page, perPage:20) {
        media(sort:TRENDING_DESC, type:ANIME, format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]) {
          id format
          title { english romaji }
          coverImage { large extraLarge }
        }
      }
    }`, { page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function getLatest(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`
    query($page:Int) {
      Page(page:$page, perPage:20) {
        media(sort:UPDATED_AT_DESC, type:ANIME, status:RELEASING, format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]) {
          id format
          title { english romaji }
          coverImage { large extraLarge }
        }
      }
    }`, { page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function searchAnime(query, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`
    query($q:String, $page:Int) {
      Page(page:$page, perPage:20) {
        media(search:$q, type:ANIME, format_not_in:[MUSIC,MANGA,NOVEL,ONE_SHOT]) {
          id format
          title { english romaji }
          coverImage { large extraLarge }
        }
      }
    }`, { q: query, page });
  return (data?.Page?.media || []).map(alToMeta).filter(Boolean);
}

async function getMovies(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const data = await anilist(`
    query($page:Int) {
      Page(page:$page, perPage:20) {
        media(sort:POPULARITY_DESC, type:ANIME, format:MOVIE) {
          id format
          title { english romaji }
          coverImage { large extraLarge }
        }
      }
    }`, { page });
  return (data?.Page?.media || []).map(m => ({ ...alToMeta(m), type: 'movie' })).filter(Boolean);
}

// ─── META ─────────────────────────────────────────────────────────────────────

async function getAnimeMeta(rawId) {
  // rawId is like "al12345"
  const alId = parseInt(rawId.replace(/^al/, ''), 10);
  if (!alId) return { id: `animekai:${rawId}`, type: 'series', name: rawId };

  const data = await anilist(`
    query($id:Int) {
      Media(id:$id, type:ANIME) {
        id format episodes
        title { english romaji }
        coverImage { large extraLarge }
        bannerImage
        description(asHtml:false)
        genres
        status
        startDate { year month day }
      }
    }`, { id: alId });

  const m = data?.Media;
  if (!m) return { id: `animekai:${rawId}`, type: 'series', name: rawId };

  const isMovie = m.format === 'MOVIE';
  const epCount = m.episodes || (isMovie ? 1 : 12);

  // Build video list from AniList episode count
  // We'll use AniWatch to get real episode IDs when streaming
  const videos = [];
  for (let i = 1; i <= Math.min(epCount, 500); i++) {
    videos.push({
      id:      `animekai:${rawId}:${i}`,
      title:   `Episode ${i}`,
      season:  1,
      episode: i,
    });
  }

  return {
    id:          `animekai:${rawId}`,
    type:        isMovie ? 'movie' : 'series',
    name:        m.title?.english || m.title?.romaji,
    description: m.description || undefined,
    poster:      m.coverImage?.extraLarge || m.coverImage?.large || undefined,
    background:  m.bannerImage || undefined,
    genres:      m.genres || undefined,
    videos,
  };
}

// ─── EPISODES via AniWatch ────────────────────────────────────────────────────

// Search AniWatch for an anime by title, get its episode list
async function findAniWatchId(title) {
  try {
    const data = await aniwatchGet(`/anime/search?q=${encodeURIComponent(title)}&page=1`);
    return data?.animes?.[0]?.id || null;
  } catch (_) {
    return null;
  }
}

async function getEpisodeList(rawId) {
  // rawId = "al12345"
  const alId = parseInt(rawId.replace(/^al/, ''), 10);
  if (!alId) return [];

  try {
    // Get title from AniList
    const data = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = data?.Media?.title?.english || data?.Media?.title?.romaji;
    if (!title) return [];

    // Find on AniWatch
    const awId = await findAniWatchId(title);
    if (!awId) return [];

    const epData = await aniwatchGet(`/anime/episodes/${encodeURIComponent(awId)}`);
    return (epData?.episodes || []).map(ep => ({
      id:     ep.episodeId,
      number: ep.number,
      title:  ep.title || `Episode ${ep.number}`,
    }));
  } catch (err) {
    console.error('[getEpisodeList]', err.message);
    return [];
  }
}

// ─── STREAMS ──────────────────────────────────────────────────────────────────

async function getStreams(rawAnimeId, episodeNum) {
  // rawAnimeId = "al12345", episodeNum = "1" (episode number from video ID)
  const alId = parseInt(rawAnimeId.replace(/^al/, ''), 10);
  if (!alId) return [];

  try {
    // Get anime title from AniList
    const data = await anilist(`query($id:Int){Media(id:$id){title{english romaji}}}`, { id: alId });
    const title = data?.Media?.title?.english || data?.Media?.title?.romaji;
    if (!title) return [];

    // Find on AniWatch
    const awId = await findAniWatchId(title);
    if (!awId) return [];

    // Get episodes and find the right one
    const epData = await aniwatchGet(`/anime/episodes/${encodeURIComponent(awId)}`);
    const episodes = epData?.episodes || [];
    const ep = episodes.find(e => String(e.number) === String(episodeNum))
            || episodes[parseInt(episodeNum, 10) - 1];

    if (!ep?.episodeId) return [];

    // Get sources for this episode
    const srcData = await aniwatchGet(`/anime/episode-srcs?id=${encodeURIComponent(ep.episodeId)}&server=vidstreaming&category=sub`);
    const sources = srcData?.sources || [];

    const streams = sources.slice(0, 4).map(s => ({
      url:   s.url,
      name:  `[SUB] ${s.quality || 'auto'}`,
      title: `[SUB] ${title} Ep${episodeNum} ${s.quality || ''}`.trim(),
      behaviorHints: {
        notWebReady: (s.url || '').includes('.m3u8'),
        headers: srcData?.headers || {},
      },
    }));

    // Also try dub
    try {
      const dubData = await aniwatchGet(`/anime/episode-srcs?id=${encodeURIComponent(ep.episodeId)}&server=vidstreaming&category=dub`);
      (dubData?.sources || []).slice(0, 2).forEach(s => {
        streams.push({
          url:   s.url,
          name:  `[DUB] ${s.quality || 'auto'}`,
          title: `[DUB] ${title} Ep${episodeNum} ${s.quality || ''}`.trim(),
          behaviorHints: {
            notWebReady: (s.url || '').includes('.m3u8'),
            headers: dubData?.headers || {},
          },
        });
      });
    } catch (_) {}

    return streams;
  } catch (err) {
    console.error('[getStreams]', err.message);
    return [];
  }
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

async function getDebugInfo() {
  const result = { anilist: null, aniwatch: null, errors: {} };

  try {
    const data = await getTrending(0);
    result.anilist = {
      working: true,
      count: data.length,
      sample: data.slice(0, 3).map(a => ({ id: a.id, name: a.name })),
    };
  } catch (e) {
    result.errors.anilist = e.message;
  }

  try {
    const data = await aniwatchGet('/anime/search?q=naruto&page=1');
    result.aniwatch = {
      working: true,
      instance: ANIWATCH_INSTANCES[0],
      count: data?.animes?.length || 0,
      sample: (data?.animes || []).slice(0, 2).map(a => ({ id: a.id, name: a.name })),
    };
  } catch (e) {
    result.errors.aniwatch = e.message;
  }

  return result;
}

module.exports = {
  getTrending, getLatest, searchAnime, getMovies,
  getAnimeMeta, getEpisodeList, getStreams, getDebugInfo,
};
