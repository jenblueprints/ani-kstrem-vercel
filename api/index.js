// api/index.js — AnimeKai Stremio Addon v4 (AniList + AniWatch)

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
  console.log('[AnimeKai v4]', req.method, path);

  try {
    if (path === '/manifest.json' || path === '' || path === '/') {
      return res.status(200).json(manifest);
    }

    if (path === '/debug') {
      const info = await scraper.getDebugInfo();
      return res.status(200).json(info);
    }

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

      console.log('[Catalog] ' + catalogId + ' -> ' + metas.length + ' items');
      return res.status(200).json({ metas });
    }

    const metaMatch = path.match(/^\/meta\/([^/]+)\/([^/]+?)\.json$/);
    if (metaMatch) {
      const rawId = decodeURIComponent(metaMatch[2]).replace(/^animekai:/,'');
      const meta  = await scraper.getAnimeMeta(rawId);
      return res.status(200).json({ meta });
    }

    const streamMatch = path.match(/^\/stream\/([^/]+)\/([^/]+?)\.json$/);
    if (streamMatch) {
      const rawId   = decodeURIComponent(streamMatch[2]).replace(/^animekai:/,'');
      const parts   = rawId.split(':');
      const animeId = parts[0];
      const epNum   = parts[1] || '1';
      const streams = await scraper.getStreams(animeId, epNum);
      console.log('[Stream] ' + animeId + ' ep' + epNum + ' -> ' + streams.length + ' streams');
      return res.status(200).json({ streams });
    }

    res.status(404).json({ error: 'Not found', path });
  } catch (err) {
    console.error('[Error]', err.message);
    res.status(500).json({ error: err.message });
  }
};
