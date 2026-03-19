// manifest.js — AnimeKai Stremio Addon Manifest
// Ported from aniyomi-en.animekai-v14.12.apk

module.exports = {
  id: 'com.animekai.stremio',
  version: '1.0.0',
  name: 'AnimeKai',
  description: 'Anime streaming from AnimeKai — Sub & Dub, 1080p/720p/480p',
  logo: 'https://animekai.to/favicon.ico',
  background: 'https://animekai.to/favicon.ico',
  types: ['series', 'movie'],

  // ---- Catalogs ----
  catalogs: [
    {
      type: 'series',
      id: 'animekai-trending',
      name: 'AnimeKai — Trending',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'animekai-latest',
      name: 'AnimeKai — Latest',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'animekai-search',
      name: 'AnimeKai — Search',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      type: 'movie',
      id: 'animekai-movies',
      name: 'AnimeKai — Movies',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],

  // ---- Resources ----
  resources: ['catalog', 'meta', 'stream'],

  // ---- Behaviours ----
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: false,
  },
};
