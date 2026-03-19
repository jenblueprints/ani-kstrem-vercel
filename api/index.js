// api/index.js — Vercel Serverless Entry Point for AnimeKai Stremio Addon
// This replaces server.js for Vercel deployment.
// Vercel runs this as a serverless function — no persistent server needed.

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const manifest = require('../manifest');
const scraper  = require('../scraper');

// ─── Build the addon ──────────────────────────────────────────────────────────

const builder = new addonBuilder(manifest);

// ── Catalog handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[Catalog] type=${type} id=${id}`, extra);
  try {
    const skip  = parseInt(extra?.skip || '0', 10);
    const query = extra?.search || '';
    let metas   = [];

    if      (id === 'animekai-trending') metas = await scraper.getTrending(skip);
    else if (id === 'animekai-latest')   metas = await scraper.getLatest(skip);
    else if (id === 'animekai-search')   metas = await scraper.searchAnime(query, skip);
    else if (id === 'animekai-movies')   metas = await scraper.getMovies(skip);

    return { metas };
  } catch (err) {
    console.error('[Catalog] Error:', err.message);
    return { metas: [] };
  }
});

// ── Meta handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[Meta] type=${type} id=${id}`);
  try {
    const animeId = id.replace('animekai:', '');
    const meta    = await scraper.getAnimeMeta(animeId);
    return { meta };
  } catch (err) {
    console.error('[Meta] Error:', err.message);
    return { meta: null };
  }
});

// ── Stream handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stream] type=${type} id=${id}`);
  try {
    const parts        = id.split(':');
    const animeId      = parts[1];
    let   episodeToken = parts[2];

    if (!episodeToken) {
      const episodes = await scraper.getEpisodeList(animeId);
      if (!episodes.length) return { streams: [] };
      episodeToken = episodes[0].token;
    }

    const streams = await scraper.getStreams(animeId, episodeToken);
    return { streams };
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    return { streams: [] };
  }
});

// ─── Export as Vercel serverless handler ─────────────────────────────────────
// getRouter() returns an Express-compatible router that Vercel can use directly.
const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
  // Allow CORS for all Stremio clients (web, desktop, mobile)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  router(req, res, () => {
    res.status(404).json({ error: 'Not found' });
  });
};
