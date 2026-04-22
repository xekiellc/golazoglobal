// scripts/fetch-soccer-news.js
// GolazoGlobal content pipeline. Runs 4× daily via GitHub Actions.
// Writes: data/news.json, data/scores.json, data/standings.json, data/transfers.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

if (!NEWS_API_KEY) { console.error('FATAL: NEWS_API_KEY not set'); process.exit(1); }
if (!CLAUDE_API_KEY) { console.error('FATAL: CLAUDE_API_KEY not set'); process.exit(1); }
if (!FOOTBALL_DATA_KEY) { console.warn('WARN: FOOTBALL_DATA_KEY not set — standings & live scores will be empty'); }

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Football-Data.org competition codes — free tier covers these
const LEAGUE_CODES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
const LEAGUE_LABELS = {
  'PL': 'Premier League', 'PD': 'La Liga', 'SA': 'Serie A',
  'BL1': 'Bundesliga', 'FL1': 'Ligue 1', 'CL': 'Champions League'
};

// NewsAPI queries — keep focused to stay under free-tier 100/day limit
const NEWS_QUERIES = [
  { q: 'premier league', league: 'Premier League' },
  { q: 'la liga', league: 'La Liga' },
  { q: 'serie a football', league: 'Serie A' },
  { q: 'bundesliga', league: 'Bundesliga' },
  { q: 'ligue 1', league: 'Ligue 1' },
  { q: 'champions league', league: 'Champions League' },
  { q: 'MLS soccer', league: 'MLS' },
  { q: 'liga mx', league: 'Liga MX' },
  { q: 'NWSL', league: 'NWSL' },
  { q: 'football transfer', league: 'Transfers' },
  { q: 'world cup 2026', league: 'World Cup' },
  { q: 'soccer', league: 'Football' }
];

// ============ HTTP HELPER ============
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ============ NEWS FETCH ============
async function fetchNews() {
  console.log('Fetching news from NewsAPI...');
  const all = [];
  const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString().split('T')[0]; // last 48h
  for (const { q, league } of NEWS_QUERIES) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&from=${from}&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_API_KEY}`;
      const res = await request(url, { headers: { 'User-Agent': 'GolazoGlobal/1.0' } });
      if (res.status !== 'ok') { console.warn(`  ${q}: ${res.message || 'failed'}`); continue; }
      const articles = (res.articles || [])
        .filter(a => a.title && a.url && !a.title.includes('[Removed]'))
        .map(a => ({
          title: a.title,
          description: a.description || '',
          url: a.url,
          source: a.source?.name || '',
          publishedAt: a.publishedAt,
          league
        }));
      all.push(...articles);
      console.log(`  ${q}: ${articles.length} articles`);
    } catch (e) {
      console.warn(`  ${q}: error — ${e.message}`);
    }
  }

  // Dedupe by URL
  const seen = new Set();
  const deduped = all.filter(a => seen.has(a.url) ? false : (seen.add(a.url), true));
  console.log(`Total: ${all.length} raw → ${deduped.length} deduped`);

  if (deduped.length === 0) {
    console.error('NewsAPI returned 0 usable articles. Check API key and rate limits.');
    return { articles: [] };
  }

  // Curate with Claude
  const curated = await curateWithClaude(deduped);
  return { articles: curated, generatedAt: new Date().toISOString() };
}

// ============ CLAUDE CURATION ============
async function curateWithClaude(articles) {
  console.log(`Curating ${articles.length} articles with Claude...`);
  const input = articles.slice(0, 120).map((a, i) => ({
    idx: i, title: a.title, description: (a.description || '').slice(0, 160), source: a.source, league: a.league
  }));

  const prompt = `You are the editor of GolazoGlobal, a global soccer news hub. From the list below, select the top 20 most newsworthy, globally relevant articles from the last 48 hours. Prioritize: match results, transfer news, tactical analysis, major-player stories, and World Cup 2026 build-up. Avoid: clickbait, pure rumor aggregation, betting content, content that reads like promotional filler.

Return STRICT JSON only — no prose, no markdown fences. Schema:
{"selected": [<idx>, <idx>, ...]}

Articles:
${JSON.stringify(input)}`;

  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const res = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body
    });
    const text = res.content?.[0]?.text || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const indices = parsed.selected || [];
    const picked = indices.map(i => articles[i]).filter(Boolean);
    console.log(`Claude selected ${picked.length} articles`);
    return picked.length ? picked : articles.slice(0, 20);
  } catch (e) {
    console.warn('Claude curation failed, using publishedAt sort fallback:', e.message);
    return articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 20);
  }
}

// ============ FOOTBALL-DATA: SCORES ============
async function fetchScores() {
  if (!FOOTBALL_DATA_KEY) return { matches: [], generatedAt: new Date().toISOString() };
  console.log('Fetching live + recent matches from Football-Data.org...');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const all = [];
  for (const code of LEAGUE_CODES) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${yesterday}&dateTo=${today}`;
      const res = await request(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } });
      const matches = (res.matches || []).map(m => ({
        league: code,
        homeTeam: m.homeTeam?.shortName || m.homeTeam?.name,
        awayTeam: m.awayTeam?.shortName || m.awayTeam?.name,
        homeScore: m.score?.fullTime?.home,
        awayScore: m.score?.fullTime?.away,
        status: m.status,
        minute: m.minute,
        utcDate: m.utcDate,
        venue: m.venue
      }));
      all.push(...matches);
      console.log(`  ${code}: ${matches.length} matches`);
    } catch (e) {
      console.warn(`  ${code}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 6500)); // free tier = 10/min, space calls
  }
  // Sort: LIVE first, then FINISHED by most recent
  const order = { 'IN_PLAY': 0, 'LIVE': 0, 'PAUSED': 1, 'FINISHED': 2, 'SCHEDULED': 3 };
  all.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return { matches: all, generatedAt: new Date().toISOString() };
}

// ============ FOOTBALL-DATA: STANDINGS ============
async function fetchStandings() {
  if (!FOOTBALL_DATA_KEY) return { leagues: {}, generatedAt: new Date().toISOString() };
  console.log('Fetching standings from Football-Data.org...');
  const leagues = {};
  // UCL doesn't have a traditional table — skip
  for (const code of ['PL', 'PD', 'SA', 'BL1', 'FL1']) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${code}/standings`;
      const res = await request(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } });
      const table = res.standings?.find(s => s.type === 'TOTAL')?.table || [];
      leagues[code] = table.map(r => ({
        position: r.position,
        team: r.team?.shortName || r.team?.name,
        played: r.playedGames,
        won: r.won,
        drawn: r.draw,
        lost: r.lost,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        goalDifference: r.goalDifference,
        points: r.points,
        form: r.form ? r.form.replace(/,/g, '').slice(-5) : ''
      }));
      console.log(`  ${code}: ${leagues[code].length} teams`);
    } catch (e) {
      console.warn(`  ${code}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 6500));
  }
  return { leagues, generatedAt: new Date().toISOString() };
}

// ============ TRANSFERS (derived from news) ============
function extractTransfers(articles) {
  // Filter news items in the Transfers bucket — keep it simple at launch
  const transferNews = articles.filter(a => a.league === 'Transfers').slice(0, 8);
  return {
    transfers: transferNews.map(a => ({
      player: a.title.split(/[—:–\-]/)[0].trim().slice(0, 40),
      from: '—',
      to: '—',
      fee: '',
      status: 'Rumour',
      source: a.source,
      url: a.url,
      publishedAt: a.publishedAt
    })),
    generatedAt: new Date().toISOString(),
    note: 'At launch, transfers are derived from news headlines. Replace with dedicated transfer API post-launch.'
  };
}

// ============ MAIN ============
(async function main() {
  console.log('=== GolazoGlobal pipeline starting ===');
  console.log('Time:', new Date().toISOString());

  const news = await fetchNews();
  fs.writeFileSync(path.join(DATA_DIR, 'news.json'), JSON.stringify(news, null, 2));
  console.log(`✓ news.json — ${news.articles.length} articles`);

  const transfers = extractTransfers(news.articles);
  fs.writeFileSync(path.join(DATA_DIR, 'transfers.json'), JSON.stringify(transfers, null, 2));
  console.log(`✓ transfers.json — ${transfers.transfers.length} entries`);

  const scores = await fetchScores();
  fs.writeFileSync(path.join(DATA_DIR, 'scores.json'), JSON.stringify(scores, null, 2));
  console.log(`✓ scores.json — ${scores.matches.length} matches`);

  const standings = await fetchStandings();
  fs.writeFileSync(path.join(DATA_DIR, 'standings.json'), JSON.stringify(standings, null, 2));
  console.log(`✓ standings.json — ${Object.keys(standings.leagues).length} leagues`);

  console.log('=== pipeline complete ===');
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
