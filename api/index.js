// api/index.js — AnimeKai Stremio Addon (Vercel Serverless v2)
// Includes /debug endpoint so you can diagnose scraping issues in browser.

const manifest = require('../manifest');
const scraper  = require('../scraper');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
}

function parseExtra(str) {
  if (!str) return {};
  const out = {};
  try {
    decodeURIComponent(str).split('&').forEach(p => {
      const [k, v] = p.split('=');
      if (k) out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    });
  } catch (_) {}
  return out;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const path = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/';
  console.log('[AnimeKai]', req.method, path);

  try {

    // ── /manifest.json ────────────────────────────────────────────────────────
    if (path === '/manifest.json' || path === '' || path === '/') {
      return res.status(200).json(manifest);
    }

    // ── /debug — shows scraper status and raw HTML (open in browser) ──────────
    if (path === '/debug') {
      const info = await scraper.getDebugInfo();
      return res.status(200).json(info);
    }

    // ── /catalog/:type/:id.json  or  /catalog/:type/:id/:extra.json ──────────
    const catMatch = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (catMatch) {
      const [, , catalogId, extraStr] = catMatch;
      const extra = parseExtra(extraStr);
      const skip  = parseInt(extra.skip || '0', 10);
      const query = extra.search || '';
      let metas   = [];

      if      (catalogId === 'animekai-trending') metas = await scraper.getTrending(skip);
      else if (catalogId === 'animekai-latest')   metas = await scraper.getLatest(skip);
      else if (catalogId === 'animekai-search')   metas = await scraper.searchAnime(query, skip);
      else if (catalogId === 'animekai-movies')   metas = await scraper.getMovies(skip);

      console.log(`[Catalog] ${catalogId} → ${metas.length} items`);
      return res.status(200).json({ metas });
    }

    // ── /meta/:type/:id.json ──────────────────────────────────────────────────
    const metaMatch = path.match(/^\/meta\/([^/]+)\/([^/]+?)\.json$/);
    if (metaMatch) {
      const animeId = metaMatch[2].replace('animekai%3A', '').replace('animekai:', '');
      const meta    = await scraper.getAnimeMeta(animeId);
      return res.status(200).json({ meta });
    }

    // ── /stream/:type/:id.json ────────────────────────────────────────────────
    const streamMatch = path.match(/^\/stream\/([^/]+)\/([^/]+?)\.json$/);
    if (streamMatch) {
      const rawId        = decodeURIComponent(streamMatch[2]);
      const parts        = rawId.split(':');
      const animeId      = parts[1];
      let   episodeToken = parts[2];

      if (!episodeToken) {
        const eps  = await scraper.getEpisodeList(animeId);
        episodeToken = eps?.[0]?.token;
      }

      const streams = episodeToken
        ? await scraper.getStreams(animeId, episodeToken)
        : [];

      console.log(`[Stream] ${animeId} → ${streams.length} streams`);
      return res.status(200).json({ streams });
    }

    res.status(404).json({ error: 'Not found', path });

  } catch (err) {
    console.error('[Error]', err.message);
    res.status(500).json({ error: err.message });
  }
};
