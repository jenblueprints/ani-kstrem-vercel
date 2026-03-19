// scraper.js — AnimeKai Scraper
// Logic ported from aniyomi-en.animekai-v14.12.apk (DEX analysis)
//
// Key findings from APK:
//   Base domains  : animekai.to / .im / .la / .nl / .vc
//   User-Agent    : Mobile Chrome 135 (extracted from DEX)
//   Episode AJAX  : /ajax/episodes/list?ani_id=<id>
//   Links AJAX    : /ajax/links/list?token=<token>
//   Link view     : /ajax/links/view?id=<lid>
//   Decrypt API   : https://enc-dec.app/api/dec-kai  (POST {token})
//   MegaUp server : https://c-kai-8090.amarullz.com
//   CSS selectors : extracted verbatim from DEX strings

const axios = require('axios');
const cheerio = require('cheerio');

// ─── Constants (extracted from DEX) ──────────────────────────────────────────

const DOMAINS = [
  'https://animekai.to',
  'https://animekai.im',
  'https://animekai.la',
  'https://animekai.nl',
  'https://animekai.vc',
];

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36';

const DEC_KAI_URL   = 'https://enc-dec.app/api/dec-kai';
const DEC_MEGA_URL  = 'https://enc-dec.app/api/dec-mega';
const MEGAUP_SERVER = 'https://c-kai-8090.amarullz.com';

// Active base URL (tries domains in order)
let BASE_URL = DOMAINS[0];

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  },
});

async function getHtml(url, extraHeaders = {}) {
  const res = await http.get(url, { headers: extraHeaders });
  return res.data;
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await http.post(url, body, {
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  return res.data;
}

// Try each domain until one works (mirrors Aniyomi "preferred_domain" pref)
async function reliableGet(path, headers = {}) {
  for (const domain of DOMAINS) {
    try {
      const res = await http.get(domain + path, { headers });
      BASE_URL = domain; // cache the working domain
      return res.data;
    } catch (_) {
      // try next
    }
  }
  throw new Error(`All AnimeKai domains failed for: ${path}`);
}

// ─── Catalog helpers (CSS selectors extracted from DEX) ──────────────────────

/**
 * Parse an anime listing page (trending/search/latest).
 * Selectors from DEX:
 *   Item wrapper : "div.aitem-wrapper div.aitem"  OR  "div.aitem-col a.aitem"
 *   Poster img   : "a.poster img"
 *   Title        : "div.title"  (also "a.title" for some layouts)
 */
function parseAnimeList($) {
  const items = [];
  $('div.aitem-wrapper div.aitem, div.aitem-col a.aitem').each((_, el) => {
    const card  = $(el);
    const link  = card.is('a') ? card : card.find('a.aitem, a.poster').first();
    const href  = link.attr('href') || '';
    const animeId = extractAnimeId(href);
    if (!animeId) return;

    const poster = card.find('a.poster img, img').first().attr('data-src')
      || card.find('a.poster img, img').first().attr('src') || '';
    const title  = card.find('div.title, a.title').first().text().trim()
      || card.attr('title') || '';

    items.push({
      id:     `animekai:${animeId}`,
      type:   'series',
      name:   title,
      poster: poster.startsWith('http') ? poster : BASE_URL + poster,
    });
  });
  return items;
}

/** Extract the numeric/slug anime ID from a URL like /watch/name~ID or /anime/slug */
function extractAnimeId(href) {
  // Pattern 1: /watch/name~ID  (tilde separator)
  const m1 = href.match(/\/watch\/[^~]+~([A-Za-z0-9]+)/);
  if (m1) return m1[1];
  // Pattern 2: /anime/slug?id=ID
  const m2 = href.match(/[?&]id=([A-Za-z0-9]+)/);
  if (m2) return m2[1];
  // Pattern 3: last path segment that looks like an ID
  const m3 = href.match(/\/([A-Za-z0-9]{6,})(?:\/|$)/);
  if (m3) return m3[1];
  return null;
}

// ─── Catalog functions ───────────────────────────────────────────────────────

async function getTrending(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const html = await reliableGet(`/trending?page=${page}`);
  const $    = cheerio.load(html);
  return parseAnimeList($);
}

async function getLatest(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const html = await reliableGet(`/updates?page=${page}`);
  const $    = cheerio.load(html);
  return parseAnimeList($);
}

async function searchAnime(query, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  // AnimeKai search endpoint — /?s=query (standard WP-style search)
  const html = await reliableGet(
    `/?s=${encodeURIComponent(query)}&page=${page}`
  );
  const $ = cheerio.load(html);
  return parseAnimeList($);
}

async function getMovies(skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const html = await reliableGet(`/type/movie?page=${page}`);
  const $    = cheerio.load(html);
  return parseAnimeList($).map(m => ({ ...m, type: 'movie' }));
}

// ─── Meta (anime detail) ────────────────────────────────────────────────────

/**
 * Fetch and build a MetaDetail object for a single anime.
 * Selectors from DEX:
 *   Detail page wrapper : "div#main-entity"
 *   Genre list         : "div.detail span"   (each span is a genre)
 *   Description        : "div.detail"
 *   Rating             : "#anime-rating"
 *   Episodes list      : AJAX  /ajax/episodes/list?ani_id=<id>
 *   Episode selector   : "div.eplist a"
 */
async function getAnimeMeta(animeId) {
  // Try to find the watch page  — we may not have the slug, so search by id
  // AnimeKai stores the ID in the URL as /watch/name~ID
  // We'll first try to find the canonical URL via a dummy page hit
  const slug = await resolveSlug(animeId);
  const html  = await reliableGet(slug);
  const $     = cheerio.load(html);

  const main  = $('div#main-entity');
  const title = main.find('div.title, h1, h2').first().text().trim();
  const desc  = main.find('div.detail').text().trim();
  const poster = main.find('a.poster img, .poster img').first().attr('data-src')
    || main.find('a.poster img, .poster img').first().attr('src') || '';
  const rating = $('#anime-rating').text().trim();

  // Genres from DEX: "div.detail span"
  const genres = [];
  main.find('div.detail span').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 30) genres.push(t);
  });

  // Episodes via AJAX
  const episodes = await getEpisodeList(animeId);

  return {
    id:          `animekai:${animeId}`,
    type:        episodes.length === 1 ? 'movie' : 'series',
    name:        title || `Anime ${animeId}`,
    description: desc,
    poster:      poster.startsWith('http') ? poster : BASE_URL + poster,
    genres,
    rating:      rating || undefined,
    videos:      episodes.map((ep, idx) => ({
      id:       `animekai:${animeId}:${ep.token}`,
      title:    ep.title || `Episode ${ep.number}`,
      season:   1,
      episode:  ep.number,
      released: ep.date || undefined,
    })),
  };
}

/** Attempt to get a canonical watch-page path for an anime ID */
async function resolveSlug(animeId) {
  // Try /watch-by-id (common pattern) or embed it in a search
  // Fallback: hit /watch and rely on redirect, or try direct ID path
  return `/watch/${animeId}`;   // AnimeKai supports direct ID path
}

// ─── Episode list (AJAX) ─────────────────────────────────────────────────────

/**
 * /ajax/episodes/list?ani_id=<id>
 * Returns HTML with "div.eplist a" elements.
 * Each <a> has data-token and episode number in text or data-num.
 */
async function getEpisodeList(animeId) {
  try {
    const html = await reliableGet(`/ajax/episodes/list?ani_id=${animeId}`, {
      Referer: BASE_URL,
      'X-Requested-With': 'XMLHttpRequest',
    });
    const $ = cheerio.load(html);
    const episodes = [];

    $('div.eplist a').each((_, el) => {
      const a      = $(el);
      const token  = a.attr('data-token') || a.attr('data-id') || a.attr('href')?.split('/').pop();
      const numStr = a.attr('data-num') || a.text().replace(/[^0-9.]/g, '');
      const num    = parseFloat(numStr) || (episodes.length + 1);
      const title  = a.attr('title') || `Episode ${num}`;
      const date   = a.attr('data-date') || undefined;
      if (token) {
        episodes.push({ token, number: num, title, date });
      }
    });

    return episodes;
  } catch (err) {
    console.error('[AnimeKai] Episode list error:', err.message);
    return [];
  }
}

// ─── Stream extraction ───────────────────────────────────────────────────────

/**
 * Full streaming pipeline (matches APK's getVideoList flow):
 *   1. /ajax/links/list?token=<epToken>  →  server list  (div.server-items[data-id])
 *   2. /ajax/links/view?id=<lid>         →  IframeDto JSON  { result: { url } }
 *   3. POST enc-dec.app/api/dec-kai      →  real iframe URL
 *   4a. If c-kai-8090 URL → extract m3u8 directly from that page
 *   4b. If MegaUp        → POST dec-mega, get m3u8 from JSON response
 */
async function getStreams(animeId, episodeToken) {
  const streams = [];

  try {
    // Step 1 — server list
    const serversHtml = await reliableGet(
      `/ajax/links/list?token=${episodeToken}`,
      { Referer: BASE_URL, 'X-Requested-With': 'XMLHttpRequest' }
    );
    const $s = cheerio.load(serversHtml);

    // Servers: "div.server-items[data-id]" contains "span.server[data-lid]"
    const serverItems = [];
    $s('div.server-items[data-id]').each((_, wrapper) => {
      const type = $s(wrapper).attr('data-type') || 'sub'; // sub / dub / softsub
      $s(wrapper).find('span.server[data-lid]').each((_, span) => {
        const lid  = $s(span).attr('data-lid');
        const name = $s(span).text().trim() || 'Server';
        if (lid) serverItems.push({ lid, name, type });
      });
    });

    console.log(`[AnimeKai] Found ${serverItems.length} server(s) for token ${episodeToken}`);

    // Step 2-4 — resolve each server in parallel (max 4)
    const results = await Promise.allSettled(
      serverItems.slice(0, 4).map(server => resolveServer(server))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        streams.push(...r.value);
      }
    }
  } catch (err) {
    console.error('[AnimeKai] Stream error:', err.message);
  }

  return streams;
}

async function resolveServer({ lid, name, type }) {
  try {
    // Step 2 — get iframe DTO
    const viewData = await reliableGet(
      `/ajax/links/view?id=${lid}`,
      { Referer: BASE_URL, 'X-Requested-With': 'XMLHttpRequest' }
    );

    let iframeUrl = '';
    if (typeof viewData === 'object' && viewData.result) {
      iframeUrl = viewData.result.url || viewData.result;
    } else {
      // Sometimes returned as raw JSON string in HTML
      try {
        const parsed = JSON.parse(viewData);
        iframeUrl = parsed?.result?.url || parsed?.result || '';
      } catch (_) {
        iframeUrl = String(viewData).match(/["']url["']\s*:\s*["']([^"']+)["']/)?.[1] || '';
      }
    }

    if (!iframeUrl) return null;

    // Step 3 — decrypt the URL via enc-dec.app/api/dec-kai
    let realUrl = iframeUrl;
    if (!iframeUrl.startsWith('http')) {
      // Encrypted — send to dec-kai
      const decRes = await postJson(DEC_KAI_URL, { token: iframeUrl });
      realUrl = decRes?.url || decRes?.result || iframeUrl;
    }

    console.log(`[AnimeKai] Resolved URL for ${name}: ${realUrl.substring(0, 60)}...`);

    // Step 4 — extract video from the real URL
    if (realUrl.includes('c-kai-8090.amarullz.com') || realUrl.includes('animekai')) {
      return await extractKaiVideo(realUrl, name, type);
    }
    if (realUrl.includes('megaup')) {
      return await extractMegaUp(realUrl, name, type);
    }

    // Generic — try to find m3u8/mp4 directly
    return await extractGenericVideo(realUrl, name, type);
  } catch (err) {
    console.error(`[AnimeKai] Server ${name} failed:`, err.message);
    return null;
  }
}

/** Extract video from AnimeKai's own c-kai server */
async function extractKaiVideo(pageUrl, serverName, type) {
  try {
    const html = await http.get(pageUrl, {
      headers: { Referer: BASE_URL, 'User-Agent': USER_AGENT },
    });
    const body = html.data;

    // Look for m3u8 URL in page source
    const m3u8Match = body.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
    const mp4Match  = body.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/);

    const videoUrl = m3u8Match?.[1] || mp4Match?.[1];
    if (!videoUrl) return null;

    // Extract quality from URL or default
    const quality = extractQuality(videoUrl) || '720p';
    const label   = `[${type.toUpperCase()}] ${serverName} ${quality}`;

    return [{
      url:   videoUrl,
      name:  label,
      title: label,
      behaviorHints: {
        notWebReady: videoUrl.includes('.m3u8'),
        headers: {
          'Referer': pageUrl,
          'User-Agent': USER_AGENT,
          'Origin': new URL(pageUrl).origin,
        },
      },
    }];
  } catch (err) {
    console.error('[AnimeKai] Kai video extract error:', err.message);
    return null;
  }
}

/** Extract from MegaUp — uses dec-mega API + c-kai JSON response */
async function extractMegaUp(megaUrl, serverName, type) {
  try {
    // Get the page to find the token
    const html = await http.get(megaUrl, {
      headers: { Referer: BASE_URL, 'User-Agent': USER_AGENT },
    });
    const body = html.data;

    // Extract MegaUp token from page
    const tokenMatch = body.match(/token\s*[:=]\s*["']([A-Za-z0-9_\-]+)['"]/);
    if (!tokenMatch) return null;

    // Decrypt via dec-mega
    const decRes = await postJson(DEC_MEGA_URL, { token: tokenMatch[1] });
    const sources = decRes?.sources || decRes?.result?.sources || [];

    return sources.map(s => {
      const quality = extractQuality(s.file) || s.label || '720p';
      const label   = `[${type.toUpperCase()}] MegaUp ${quality}`;
      return {
        url:   s.file,
        name:  label,
        title: label,
        behaviorHints: {
          notWebReady: s.file.includes('.m3u8'),
          headers: {
            'Referer': megaUrl,
            'User-Agent': USER_AGENT,
          },
        },
      };
    }).filter(s => s.url);
  } catch (err) {
    console.error('[AnimeKai] MegaUp extract error:', err.message);
    return null;
  }
}

/** Generic video extraction — scan page for m3u8/mp4 links */
async function extractGenericVideo(pageUrl, serverName, type) {
  try {
    const html = await http.get(pageUrl, {
      headers: { Referer: BASE_URL, 'User-Agent': USER_AGENT },
    });
    const body = html.data;

    const m3u8s = [...body.matchAll(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,100})['"]/g)].map(m => m[1]);
    const mp4s  = [...body.matchAll(/["'](https?:\/\/[^"']+\.mp4[^"']{0,100})['"]/g)].map(m => m[1]);
    const urls  = [...new Set([...m3u8s, ...mp4s])];

    return urls.slice(0, 3).map((url, i) => {
      const quality = extractQuality(url) || '720p';
      const label   = `[${type.toUpperCase()}] ${serverName} ${quality}`;
      return {
        url,
        name:  label,
        title: label,
        behaviorHints: {
          notWebReady: url.includes('.m3u8'),
          headers: {
            'Referer': pageUrl,
            'User-Agent': USER_AGENT,
          },
        },
      };
    });
  } catch (err) {
    console.error('[AnimeKai] Generic extract error:', err.message);
    return null;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function extractQuality(url) {
  if (/1080/.test(url)) return '1080p';
  if (/720/.test(url))  return '720p';
  if (/480/.test(url))  return '480p';
  if (/360/.test(url))  return '360p';
  return null;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getTrending,
  getLatest,
  searchAnime,
  getMovies,
  getAnimeMeta,
  getEpisodeList,
  getStreams,
  extractAnimeId,
};
