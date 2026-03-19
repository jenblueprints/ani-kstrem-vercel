# Anime Stremio Addon — Vercel Edition

**100% Free. No credit card. No sign-up payment. Works on every device.**

## Files in this package

```
animekai-vercel/
├── api/
│   └── index.js      ← Vercel serverless entry point (replaces server.js)
├── manifest.js       ← Addon metadata
├── scraper.js        ← All AnimeKai scraping logic
├── package.json      ← Dependencies
└── vercel.json       ← Vercel routing config (required!)
```

## How to deploy (full guide in the chat above)

1. Upload ALL these files to a GitHub repo
2. Go to vercel.com → sign up with GitHub (free, no card)
3. Import your GitHub repo
4. Click Deploy — done in 60 seconds
5. Your URL: `https://your-project.vercel.app/manifest.json`

## What changed from the original?

- `server.js` is replaced by `api/index.js` — same logic, exports a serverless handler
- `vercel.json` added — tells Vercel how to route requests
- Everything else (scraper.js, manifest.js) is unchanged
