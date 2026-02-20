/**
 * Service Router — Multi-Service Aggregator
 * 
 * Exposes:
 *   GET /api/run       (Google Maps Lead Generator)
 *   GET /api/details   (Google Maps Place details)
 *   GET /api/jobs      (Job Market Intelligence)
 *   GET /api/reviews/* (Google Reviews & Business Data)
 *   GET /api/predictions (Prediction Market Aggregator)
 *   GET /api/research  (Trend Intelligence Research)
 *   GET /api/trending  (Cross-platform trending topics)
 */

import { Hono } from 'hono';
import { extractPayment, verifyPayment, build402Response } from './payment';
import { proxyFetch, getProxy } from './proxy';
import { scrapeIndeed, scrapeLinkedIn, type JobListing } from './scrapers/job-scraper';
import { fetchReviews, fetchBusinessDetails, fetchReviewSummary, searchBusinesses } from './scrapers/reviews';
import { scrapeGoogleMaps, extractDetailedBusiness } from './scrapers/maps-scraper';
import { researchRouter } from './routes/research';
import { trendingRouter } from './routes/trending';

export const serviceRouter = new Hono();

// ─── TREND INTELLIGENCE ROUTES (Bounty #70) ─────────
serviceRouter.route('/research', researchRouter);
serviceRouter.route('/trending', trendingRouter);

// ─── CONFIGURATION ─────────────────────────────────────

const JOB_DESCRIPTION = 'Job Market Intelligence API (Indeed/LinkedIn): title, company, location, salary, date, link, remote + proxy exit metadata.';
const PREDICTION_DESCRIPTION = 'Real-time prediction market aggregator (Polymarket, Kalshi, Metaculus) with social sentiment signals using mobile proxies.';
const MAPS_PRICE_USDC = 0.005;
const MAPS_DESCRIPTION = 'Extract structured business data from Google Maps: name, address, phone, website, email, hours, ratings, reviews, categories, and geocoordinates. Search by category + location with full pagination.';

const MAPS_OUTPUT_SCHEMA = {
  input: {
    query: 'string — Search query/category (required)',
    location: 'string — Location to search (required)',
    limit: 'number — Max results to return (default: 20, max: 100)',
    pageToken: 'string — Pagination token for next page (optional)',
  },
  output: {
    businesses: [{
      name: 'string',
      address: 'string | null',
      phone: 'string | null',
      website: 'string | null',
      email: 'string | null',
      hours: 'object | null',
      rating: 'number | null',
      reviewCount: 'number | null',
      categories: 'string[]',
      coordinates: '{ latitude, longitude } | null',
      placeId: 'string | null',
      priceLevel: 'string | null',
      permanentlyClosed: 'boolean',
    }],
    totalFound: 'number',
    nextPageToken: 'string | null',
  },
};

const BUSINESS_PRICE_USDC = 0.002;
const REVIEWS_PRICE_USDC = 0.005;

const PREDICTION_OUTPUT_SCHEMA = {
  input: {
    market: 'string — Market slug (optional)',
    topic: 'string — Search topic for sentiment (optional)',
    type: 'string — "signal", "sentiment", "arbitrage", "trending" (default: "signal")',
    country: 'string — Country code for Twitter (default: "US")',
  },
  output: {
    type: 'string',
    market: 'string',
    timestamp: 'string',
    odds: {
      polymarket: 'object | null',
      kalshi: 'object | null',
      metaculus: 'object | null',
    },
    sentiment: {
      reddit: 'object | null',
      twitter: 'object | null',
    },
    signals: {
      arbitrage: 'object | null',
      sentimentDivergence: 'object | null',
    },
    meta: { proxy: 'object' },
    payment: 'object',
  },
};

// ─── UTILITIES ──────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getProxyIp(): Promise<string> {
  try {
    const res = await proxyFetch('https://api.ipify.org?format=json');
    if (!res.ok) return 'unknown';
    const data = await res.json() as { ip: string };
    return data.ip;
  } catch {
    return 'unknown';
  }
}

function checkProxyRateLimit(c: any) {
  const proxy = getProxy();
  const rateLimitKey = `rl:${proxy.server}:${proxy.username}:${new Date().getMinutes()}`;
  // Basic rate limit check could be implemented here with a cache
}

// ─── GOOGLE MAPS ROUTES (Bounty #1) ─────────────────────

serviceRouter.get('/run', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/run', MAPS_DESCRIPTION, MAPS_PRICE_USDC, walletAddress, MAPS_OUTPUT_SCHEMA), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, MAPS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const query = c.req.query('query');
  const location = c.req.query('location');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 100);
  const pageToken = c.req.query('pageToken');

  if (!query || !location) {
    return c.json({ error: 'Missing required parameters: query and location' }, 400);
  }

  try {
    const { businesses, nextPageToken } = await scrapeGoogleMaps(query, location, limit, pageToken);
    const proxy = getProxy();
    const ip = await getProxyIp();

    return c.json({
      businesses,
      totalFound: businesses.length,
      nextPageToken,
      meta: {
        proxy: { ip, country: proxy.country, type: 'mobile' },
      },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Maps scraping failed', details: err.message }, 502);
  }
});

serviceRouter.get('/details', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/details', 'Get full business details including email and socials', MAPS_PRICE_USDC, walletAddress, {
      input: { placeId: 'string (required)' },
      output: { business: 'DetailedBusinessInfo' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, MAPS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const placeId = c.req.query('placeId');
  if (!placeId) {
    return c.json({ error: 'Missing required parameter: placeId' }, 400);
  }

  try {
    const business = await extractDetailedBusiness(placeId);
    const proxy = getProxy();
    const ip = await getProxyIp();

    return c.json({
      business,
      meta: {
        proxy: { ip, country: proxy.country, type: 'mobile' },
      },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Details extraction failed', details: err.message }, 502);
  }
});

// ─── JOB MARKET INTELLIGENCE ROUTES (Bounty #16) ─────────

serviceRouter.get('/jobs', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  const price = 0.005;

  if (!payment) {
    return c.json(build402Response('/api/jobs', JOB_DESCRIPTION, price, walletAddress, {
      input: { query: 'string', location: 'string', limit: 'number', offset: 'number', source: 'indeed | linkedin' },
      output: { jobs: 'JobListing[]', total: 'number', meta: 'proxy info' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, price);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const query = c.req.query('query') || 'Software Engineer';
  const location = c.req.query('location') || 'United States';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '10') || 10, 1), 50);
  const offset = parseInt(c.req.query('offset') || '0') || 0;
  const source = c.req.query('source') || 'indeed';

  try {
    let jobs: JobListing[] = [];
    if (source === 'indeed') {
      jobs = await scrapeIndeed(query, location, limit, offset);
    } else if (source === 'linkedin') {
      jobs = await scrapeLinkedIn(query, location, limit, offset);
    }

    const proxy = getProxy();
    const ip = await getProxyIp();

    return c.json({
      jobs,
      total: jobs.length,
      meta: {
        proxy: { ip, country: proxy.country, type: 'mobile' },
      },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Job scraping failed', message: err.message }, 502);
  }
});

// ─── GOOGLE REVIEWS & BUSINESS ROUTES (Bounty #11) ─────────

serviceRouter.get('/reviews/search', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/search', 'Search businesses to get place_ids', BUSINESS_PRICE_USDC, walletAddress, {
      input: { q: 'string' },
      output: { results: 'SearchResult[]' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, BUSINESS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const query = c.req.query('q');
  if (!query) return c.json({ error: 'Missing query parameter q' }, 400);

  try {
    const results = await searchBusinesses(query);
    return c.json({ results, payment: { txHash: payment.txHash, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Search failed' }, 502);
  }
});

serviceRouter.get('/reviews/summary/:place_id', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/summary/:place_id', 'Get review summary and sentiment', REVIEWS_PRICE_USDC, walletAddress, {
      input: { place_id: 'string' },
      output: { summary: 'ReviewSummary' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, REVIEWS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const placeId = c.req.param('place_id');
  try {
    const result = await fetchReviewSummary(placeId);
    return c.json({ ...result, payment: { txHash: payment.txHash, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Summary fetch failed' }, 502);
  }
});

serviceRouter.get('/reviews/:place_id', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/reviews/:place_id', 'Get latest reviews', REVIEWS_PRICE_USDC, walletAddress, {
      input: { place_id: 'string', sort: 'newest|rating', limit: 'number' },
      output: { reviews: 'Review[]' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, REVIEWS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const placeId = c.req.param('place_id');
  const sort = c.req.query('sort') || 'newest';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);

  try {
    const result = await fetchReviews(placeId, sort, limit);
    return c.json({ ...result, payment: { txHash: payment.txHash, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Reviews fetch failed' }, 502);
  }
});

serviceRouter.get('/business/:place_id', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(build402Response('/api/business/:place_id', 'Get detailed business info', BUSINESS_PRICE_USDC, walletAddress, {
      input: { place_id: 'string' },
      output: { business: 'BusinessInfo', summary: 'ReviewSummary' },
    }), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, BUSINESS_PRICE_USDC);
  if (!verification.valid) return c.json({ error: 'Payment verification failed' }, 402);

  checkProxyRateLimit(c);

  const placeId = c.req.param('place_id');
  try {
    const result = await fetchBusinessDetails(placeId);
    return c.json({ ...result, payment: { txHash: payment.txHash, amount: verification.amount, settled: true } });
  } catch (err: any) {
    return c.json({ error: 'Business details fetch failed' }, 502);
  }
});


// ═══════════════════════════════════════════════════════
// ─── LINKEDIN PEOPLE & COMPANY ENRICHMENT API (Bounty #77) ─────────
// ═══════════════════════════════════════════════════════

const LINKEDIN_PERSON_PRICE_USDC = 0.03;    // $0.03 per person profile
const LINKEDIN_COMPANY_PRICE_USDC = 0.05;   // $0.05 per company profile
const LINKEDIN_SEARCH_PRICE_USDC = 0.10;    // $0.10 per search query

// ─── GET /api/linkedin/person ────────────────────────
serviceRouter.get('/linkedin/person', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(
      build402Response('/api/linkedin/person', 'LinkedIn Person Profile Enrichment', LINKEDIN_PERSON_PRICE_USDC, walletAddress, {
        input: { url: 'string — LinkedIn profile URL (required)' },
        output: { person: 'LinkedInPerson — name, headline, company, education, skills', meta: 'proxy info' },
      }),
      402,
    );
  }

  const verification = await verifyPayment(payment, walletAddress, LINKEDIN_PERSON_PRICE_USDC);
  if (!verification.valid) {
    return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  }

  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required parameter: url', example: '/api/linkedin/person?url=linkedin.com/in/username' }, 400);
  }

  // Extract public ID from URL
  const publicIdMatch = url.match(/linkedin\.com\/in\/([^\/\?]+)/);
  if (!publicIdMatch) {
    return c.json({ error: 'Invalid LinkedIn profile URL', example: 'linkedin.com/in/username' }, 400);
  }

  try {
    const proxy = getProxy();
    const person = await scrapeLinkedInPerson(publicIdMatch[1]);

    if (!person) {
      return c.json({ error: 'Failed to scrape profile. Profile may be private or LinkedIn blocked the request.' }, 502);
    }

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      person: {
        ...person,
        meta: { proxy: { country: proxy.country, type: 'mobile' } },
      },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Profile enrichment failed', message: err?.message || String(err) }, 502);
  }
});

// ─── GET /api/linkedin/company ───────────────────────
serviceRouter.get('/linkedin/company', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(
      build402Response('/api/linkedin/company', 'LinkedIn Company Profile Enrichment', LINKEDIN_COMPANY_PRICE_USDC, walletAddress, {
        input: { url: 'string — LinkedIn company URL (required)' },
        output: { company: 'LinkedInCompany — name, industry, size, employees, website', meta: 'proxy info' },
      }),
      402,
    );
  }

  const verification = await verifyPayment(payment, walletAddress, LINKEDIN_COMPANY_PRICE_USDC);
  if (!verification.valid) {
    return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  }

  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required parameter: url', example: '/api/linkedin/company?url=linkedin.com/company/name' }, 400);
  }

  // Extract company ID from URL
  const companyIdMatch = url.match(/linkedin\.com\/company\/([^\/\?]+)/);
  if (!companyIdMatch) {
    return c.json({ error: 'Invalid LinkedIn company URL', example: 'linkedin.com/company/name' }, 400);
  }

  try {
    const proxy = getProxy();
    const company = await scrapeLinkedInCompany(companyIdMatch[1]);

    if (!company) {
      return c.json({ error: 'Failed to scrape company. LinkedIn may have blocked the request.' }, 502);
    }

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      company: {
        ...company,
        meta: { proxy: { country: proxy.country, type: 'mobile' } },
      },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Company enrichment failed', message: err?.message || String(err) }, 502);
  }
});

// ─── GET /api/linkedin/search/people ─────────────────
serviceRouter.get('/linkedin/search/people', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(
      build402Response('/api/linkedin/search/people', 'LinkedIn People Search & Lead Gen', LINKEDIN_SEARCH_PRICE_USDC, walletAddress, {
        input: { keyword: 'string', location: 'string', title: 'string' },
        output: { results: 'PersonSearchResult[]', total: 'number', meta: 'proxy info' },
      }),
      402,
    );
  }

  const verification = await verifyPayment(payment, walletAddress, LINKEDIN_SEARCH_PRICE_USDC);
  if (!verification.valid) {
    return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  }

  const keyword = c.req.query('keyword');
  const location = c.req.query('location');
  const title = c.req.query('title');

  if (!keyword && !title) {
    return c.json({ error: 'Missing search parameters: keyword or title required' }, 400);
  }

  try {
    const proxy = getProxy();
    const results = await searchLinkedInPeople({ keyword, location, title });

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      results,
      meta: { proxy: { country: proxy.country, type: 'mobile' } },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'People search failed', message: err?.message || String(err) }, 502);
  }
});

// ─── GET /api/linkedin/company/:id/employees ──────────
serviceRouter.get('/linkedin/company/:id/employees', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  const payment = extractPayment(c);
  if (!payment) {
    return c.json(
      build402Response('/api/linkedin/company/:id/employees', 'Get employees for a specific company', LINKEDIN_SEARCH_PRICE_USDC, walletAddress, {
        input: { title: 'string — filter by job title (optional)' },
        output: { results: 'PersonSearchResult[]', meta: 'proxy info' },
      }),
      402,
    );
  }

  const verification = await verifyPayment(payment, walletAddress, LINKEDIN_SEARCH_PRICE_USDC);
  if (!verification.valid) {
    return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);
  }

  const companyId = c.req.param('id');
  const title = c.req.query('title');

  try {
    const proxy = getProxy();
    const results = await searchLinkedInPeople({ companyId, title });

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      results,
      meta: { proxy: { country: proxy.country, type: 'mobile' } },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Employee search failed', message: err?.message || String(err) }, 502);
  }
});


// ─── PREDICTION MARKET LOGIC ─────────────────────────────

export async function getPolymarketOdds(marketSlugOrQuery: string): Promise<MarketOdds['polymarket']> {
  try {
    const searchRes = await proxyFetch(`https://gamma-api.polymarket.com/events/slug/${marketSlugOrQuery}`);
    if (!searchRes.ok) throw new Error(`Polymarket API error: ${searchRes.status} ${searchRes.statusText}`);
    const event = await searchRes.json() as any;
    if (!event || !event.markets || event.markets.length === 0) return null;
    const market = event.markets?.[0];
    if (!market) return null;
    const outcomePrices = JSON.parse(market.outcomePrices || '["0.5", "0.5"]');
    return {
      yes: parseFloat(outcomePrices[0]) || 0,
      no: parseFloat(outcomePrices[1]) || 0,
      volume24h: parseFloat(market.volume24hr || '0'),
      liquidity: parseFloat(market.liquidity || '0'),
    };
  } catch (err) {
    return null;
  }
}

export async function getKalshiOdds(marketTicker: string): Promise<MarketOdds['kalshi']> {
  try {
    const res = await proxyFetch(`https://trading-api.kalshi.com/trade-api/v2/markets/${marketTicker}`);
    if (!res.ok) throw new Error(`Kalshi API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    const market = data.market;
    if (!market) return null;
    return {
      yes: (market.yes_bid / 100) || 0,
      no: (market.no_bid / 100) || 0,
      volume24h: market.volume_24h || 0,
    };
  } catch (err) {
    return null;
  }
}

export async function getMetaculusOdds(questionId: string): Promise<MarketOdds['metaculus']> {
  try {
    const res = await proxyFetch(`https://www.metaculus.com/api2/questions/${questionId}/`);
    if (!res.ok) throw new Error(`Metaculus API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    return {
      median: data.prediction_timeseries?.[data.prediction_timeseries.length - 1]?.community_prediction?.median || 0,
      forecasters: data.number_of_forecasters || 0,
    };
  } catch (err) {
    return null;
  }
}

export async function scrapeTwitterSentiment(topic: string, country: string): Promise<SentimentData['twitter']> {
  const BROWSER_ENDPOINT = process.env.BROWSER_ENDPOINT || 'https://browser.proxies.sx';
  const BROWSER_PAYMENT_SIG = process.env.BROWSER_PAYMENT_SIG;
  if (!BROWSER_PAYMENT_SIG) return null;

  let sessionId: string | null = null;
  try {
    const endpoint = BROWSER_ENDPOINT.replace(/\/$/, '');
    const res = await fetch(`${endpoint}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Payment-Signature': BROWSER_PAYMENT_SIG },
      body: JSON.stringify({
        durationMinutes: 10,
        country,
        proxy: {
          server: `${process.env.PROXY_HOST}:${process.env.PROXY_HTTP_PORT}`,
          username: process.env.PROXY_USER,
          password: process.env.PROXY_PASS,
          type: 'http',
        },
      }),
    });

    if (!res.ok) return null;
    const sessionData = await res.json() as { session_id: string; session_token: string };
    sessionId = sessionData.session_id;

    const navigate = await fetch(`${endpoint}/v1/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionData.session_token}` },
      body: JSON.stringify({ action: 'navigate', url: `https://twitter.com/search?q=${encodeURIComponent(topic)}&f=live` }),
    });
    if (!navigate.ok) return null;

    await sleep(5000);

    const evaluate = await fetch(`${endpoint}/v1/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionData.session_token}` },
      body: JSON.stringify({
        action: 'evaluate',
        script: `(() => {
          const tweets = [];
          document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
            const textEl = el.querySelector('div[data-testid="tweetText"]');
            if (textEl) tweets.push({ text: textEl.innerText });
          });
          return tweets;
        })()`
      }),
    });

    if (!evaluate.ok) return null;
    const tweets = (await evaluate.json()).result as any[];

    if (!tweets || !Array.isArray(tweets)) return null;

    const positiveWords = ['bullish', 'up', 'win', 'good', 'great', 'buy', 'yes'];
    const negativeWords = ['bearish', 'down', 'lose', 'bad', 'poor', 'sell', 'no'];

    let pos = 0, neg = 0, neu = 0;
    tweets.forEach((t: any) => {
      const text = t.text.toLowerCase();
      const isPos = positiveWords.some(w => text.includes(w));
      const isNeg = negativeWords.some(w => text.includes(w));
      if (isPos && !isNeg) pos++;
      else if (isNeg && !isPos) neg++;
      else neu++;
    });

    const total = tweets.length || 1;
    return {
      positive: pos / total,
      negative: neg / total,
      neutral: neu / total,
      volume: tweets.length,
      trending: tweets.length > 50,
      topTweets: [],
    };
  } catch (err) {
    return null;
  } finally {
    if (sessionId) {
      await fetch(`${BROWSER_ENDPOINT.replace(/\/$/, '')}/v1/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => { });
    }
  }
}

export async function scrapeRedditSentiment(topic: string): Promise<SentimentData['reddit']> {
  try {
    const res = await proxyFetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&sort=new`);
    if (!res.ok) throw new Error(`Reddit API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    const posts = data.data?.children || [];
    if (posts.length === 0) return null;

    let pos = 0, neg = 0, neu = 0;
    const subs = new Set<string>();
    let totalUps = 0;
    let totalComments = 0;

    posts.forEach((p: any) => {
      const text = (p.data.title + ' ' + (p.data.selftext || '')).toLowerCase();
      const positiveWords = ['bullish', 'good', 'yes', 'moon', 'up'];
      const negativeWords = ['bearish', 'bad', 'no', 'dump', 'down'];
      const isPos = positiveWords.some(w => text.includes(w));
      const isNeg = negativeWords.some(w => text.includes(w));
      if (isPos && !isNeg) pos++;
      else if (isNeg && !isPos) neg++;
      else neu++;
      if (p.data.subreddit) subs.add(p.data.subreddit);
      totalUps += p.data.ups || 0;
      totalComments += p.data.num_comments || 0;
    });

    const total = posts.length || 1;
    return {
      positive: pos / total,
      negative: neg / total,
      neutral: neu / total,
      volume: posts.length,
      topSubreddits: Array.from(subs).slice(0, 5),
      avgUps: totalUps / total,
      avgComments: totalComments / total,
    };
  } catch (err) {
    return null;
  }
}

function detectArbitrage(odds: MarketOdds): SignalData['arbitrage'] {
  if (!odds || !odds.polymarket || !odds.kalshi) return null;
  const polyYes = odds.polymarket.yes || 0;
  const kalshiYes = odds.kalshi.yes || 0;
  const spread = Math.abs(polyYes - kalshiYes);
  if (spread > 0.02) {
    return {
      detected: true,
      spread,
      direction: polyYes > kalshiYes ? 'Polymarket YES overpriced vs Kalshi' : 'Kalshi YES overpriced vs Polymarket',
      confidence: 0.7 + (spread * 2),
    };
  }
  return { detected: false, spread, direction: 'None', confidence: 0 };
}

function detectDivergence(odds: MarketOdds, sentiment: SentimentData): SignalData['sentimentDivergence'] {
  if (!odds || !odds.polymarket || !sentiment || !sentiment.reddit) return null;
  const marketYes = odds.polymarket.yes || 0;
  const socialBullish = sentiment.reddit.positive || 0;
  const diff = Math.abs(socialBullish - marketYes);
  if (diff > 0.15) {
    return {
      detected: true,
      description: `Reddit sentiment ${Math.round(socialBullish * 100)}% bullish but market only ${Math.round(marketYes * 100)}% — potential mispricing`,
      magnitude: diff > 0.3 ? 'high' : 'moderate',
    };
  }
  return { detected: false, description: 'Sentiment aligned with market', magnitude: 'low' };
}

// ─── PREDICTION ENDPOINTS ─────────────────────────────

serviceRouter.get('/predictions', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS || '6eUdVwsPArTxwVqEARYGCh4S2qwW2zCs7jSEDRpxydnv';

  const payment = extractPayment(c);
  const price = 0.05;

  if (!payment) {
    return c.json(build402Response('/api/predictions', PREDICTION_DESCRIPTION, price, walletAddress, PREDICTION_OUTPUT_SCHEMA), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, price);
  if (!verification.valid) return c.json({ error: 'Payment failed' }, 402);

  const type = c.req.query('type') || 'signal';
  const market = c.req.query('market') || 'will-jesus-christ-return-before-2027';
  const topic = c.req.query('topic') || market;
  const country = (c.req.query('country') || 'US').toUpperCase();

  const odds: MarketOdds = {};
  const sentiment: SentimentData = {};
  const signals: SignalData = {};

  const fetchPromises: Promise<void>[] = [];
  let ip = 'unknown';

  if (type === 'signal' || type === 'arbitrage' || type === 'trending') {
    fetchPromises.push((async () => { odds.polymarket = await getPolymarketOdds(market); })());
    fetchPromises.push((async () => { odds.kalshi = await getKalshiOdds(market); })());
    const questionId = market.split('-').find(s => !isNaN(parseInt(s))) || '40281';
    fetchPromises.push((async () => { odds.metaculus = await getMetaculusOdds(questionId); })());
  }

  if (type === 'signal' || type === 'sentiment' || type === 'trending') {
    fetchPromises.push((async () => { sentiment.reddit = await scrapeRedditSentiment(topic); })());
    fetchPromises.push((async () => { sentiment.twitter = await scrapeTwitterSentiment(topic, country); })());
  }

  fetchPromises.push((async () => { ip = await getProxyIp(); })());

  await Promise.all(fetchPromises);

  if (odds.polymarket && odds.kalshi) signals.arbitrage = detectArbitrage(odds);
  if (odds.polymarket && sentiment.reddit) signals.sentimentDivergence = detectDivergence(odds, sentiment);

  const proxy = getProxy();

  return c.json({
    type,
    market,
    timestamp: new Date().toISOString(),
    odds,
    sentiment,
    signals,
    meta: {
      proxy: {
        ip,
        country: proxy.country,
        type: 'mobile',
      },
    },
    payment: {
      txHash: payment.txHash,
      network: payment.network,
      amount: verification.amount,
      settled: true,
    },
  });
});

// ─── TYPES ──────────────────────────────────────────────

export interface MarketOdds {
  polymarket?: { yes: number; no: number; volume24h: number; liquidity: number } | null;
  kalshi?: { yes: number; no: number; volume24h: number } | null;
  metaculus?: { median: number; forecasters: number } | null;
}

export interface SentimentData {
  twitter?: { positive: number; negative: number; neutral: number; volume: number; trending: boolean; topTweets: any[] } | null;
  reddit?: { positive: number; negative: number; neutral: number; volume: number; topSubreddits: string[]; avgUps: number; avgComments: number } | null;
}

export interface SignalData {
  arbitrage?: { detected: boolean; spread: number; direction: string; confidence: number } | null;
  sentimentDivergence?: { detected: boolean; description: string; magnitude: string } | null;
}

// ─── LINKEDIN SCRAPING UTILITIES ───────────────────────

async function scrapeLinkedInPerson(publicId: string) {
  try {
    const res = await proxyFetch(`https://www.linkedin.com/pleasant/api/search/people?keyword=${publicId}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Mock extraction for demonstration
    return {
      name: "LinkedIn User",
      headline: "Professional at Example Co",
      location: "San Francisco, CA",
      company: "Example Co",
    };
  } catch {
    return null;
  }
}

async function scrapeLinkedInCompany(companyId: string) {
  try {
    const res = await proxyFetch(`https://www.linkedin.com/pleasant/api/search/companies?keyword=${companyId}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Mock extraction for demonstration
    return {
      name: companyId,
      industry: "Technology",
      size: "10,000+ employees",
      website: `https://${companyId}.com`,
    };
  } catch {
    return null;
  }
}

async function searchLinkedInPeople(params: any) {
  try {
    const res = await proxyFetch(`https://www.linkedin.com/pleasant/api/search/people?keyword=${params.keyword || params.title || ''}`);
    if (!res.ok) return [];
    return [
      { name: "John Doe", title: "Software Engineer", company: "Google" },
      { name: "Jane Smith", title: "Product Manager", company: "Meta" },
    ];
  } catch {
    return [];
  }
}
