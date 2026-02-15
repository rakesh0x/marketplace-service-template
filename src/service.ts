/**
 * Service Router — Multi-Service Aggregator
 * 
 * Exposes:
 *   GET /api/jobs (Job Market Intelligence)
 *   GET /api/run  (Prediction Market Aggregator)
 *   GET /api/test (Prediction Market Diagnostics)
 */

import { Hono } from 'hono';
import { extractPayment, verifyPayment, build402Response } from './payment';
import { proxyFetch, getProxy } from './proxy';
import { scrapeIndeed, scrapeLinkedIn, type JobListing } from './scrapers/job-scraper';

export const serviceRouter = new Hono();

// ─── CONFIGURATION ─────────────────────────────────────

const JOB_DESCRIPTION = 'Job Market Intelligence API (Indeed/LinkedIn): title, company, location, salary, date, link, remote + proxy exit metadata.';
const PREDICTION_DESCRIPTION = 'Real-time prediction market aggregator (Polymarket, Kalshi, Metaculus) with social sentiment signals using mobile proxies.';

const PREDICTION_OUTPUT_SCHEMA = {
  input: {
    type: 'string — "signal", "arbitrage", "sentiment", "trending" (required)',
    market: 'string — market slug or query for "signal"',
    topic: 'string — topic for "sentiment"',
    country: 'string — country code for sentiment (default US)',
  },
  output: {
    type: 'string',
    market: 'string',
    timestamp: 'string',
    odds: {
      polymarket: '{yes, no, volume24h, liquidity}',
      kalshi: '{yes, no, volume24h}',
      metaculus: '{median, forecasters}',
    },
    sentiment: {
      twitter: '{positive, negative, neutral, volume, trending, topTweets}',
      reddit: '{positive, negative, neutral, volume, topSubreddits, avgUps, avgComments}',
      tiktok: '{relatedVideos, totalViews, sentiment}',
    },
    signals: {
      arbitrage: '{detected, spread, direction, confidence}',
      sentimentDivergence: '{detected, description, magnitude}',
      volumeSpike: '{detected}',
    },
    proxy: '{country, ip, type:"mobile"}',
    payment: '{txHash, amount, verified}',
  },
};

// ─── TYPES ─────────────────────────────────────────────

interface MarketOdds {
  polymarket?: { yes: number; no: number; volume24h: number; liquidity: number };
  kalshi?: { yes: number; no: number; volume24h: number };
  metaculus?: { median: number; forecasters: number };
}

interface SentimentData {
  twitter?: {
    positive: number; negative: number; neutral: number; volume: number; trending: boolean;
    topTweets: Array<{ text: string; likes: number; retweets: number; author: string; timestamp: string }>;
  };
  reddit?: {
    positive: number; negative: number; neutral: number; volume: number;
    topSubreddits: string[];
    avgUps: number;
    avgComments: number;
  };
  tiktok?: { relatedVideos: number; totalViews: number; sentiment: string };
}

interface SignalData {
  arbitrage?: { detected: boolean; spread: number; direction: string; confidence: number };
  sentimentDivergence?: { detected: boolean; description: string; magnitude: string };
  volumeSpike?: { detected: boolean };
}

interface BrowserSession {
  sessionId: string;
  sessionToken: string;
}

// ─── UTILS ──────────────────────────────────────────────

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── JOB SCRAPER LOGIC ─────────────────────────────────

serviceRouter.get('/jobs', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);

  const payment = extractPayment(c);
  const price = 0.005;

  if (!payment) {
    return c.json(
      build402Response(
        '/api/jobs',
        JOB_DESCRIPTION,
        price,
        walletAddress,
        {
          input: {
            query: 'string (required) — job title / keywords (e.g., "Software Engineer")',
            location: 'string (optional, default: "Remote")',
            platform: '"indeed" | "linkedin" | "both" (optional, default: "indeed")',
            limit: 'number (optional, default: 20, max: 50)'
          },
          output: {
            results: 'JobListing[]',
            meta: {
              proxy: '{ ip, country, host, type:"mobile" }',
              platform: 'indeed|linkedin|both',
              limit: 'number'
            },
          },
        },
      ),
      402,
    );
  }

  const verification = await verifyPayment(payment, walletAddress, price);
  if (!verification.valid) return c.json({ error: 'Payment verification failed', reason: verification.error }, 402);

  const query = c.req.query('query') || 'Software Engineer';
  const location = c.req.query('location') || 'Remote';
  const platform = (c.req.query('platform') || 'indeed').toLowerCase();
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);

  try {
    const proxy = getProxy();
    const ip = await getProxyIp();

    let results: JobListing[] = [];
    if (platform === 'both') {
      const [a, b] = await Promise.all([
        scrapeIndeed(query, location, limit),
        scrapeLinkedIn(query, location, limit),
      ]);
      results = [...a, ...b];
    } else if (platform === 'linkedin') {
      results = await scrapeLinkedIn(query, location, limit);
    } else {
      results = await scrapeIndeed(query, location, limit);
    }

    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      results,
      meta: {
        platform,
        limit,
        proxy: {
          ip,
          country: proxy.country,
          host: proxy.host,
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
  } catch (err: any) {
    return c.json({ error: 'Scrape failed', message: err?.message || String(err) }, 502);
  }
});

// ─── PREDICTION MARKET DATA ────────────────────────────

async function getPolymarketOdds(marketSlugOrQuery: string): Promise<MarketOdds['polymarket']> {
  try {
    const searchRes = await proxyFetch(`https://gamma-api.polymarket.com/events?slug=${marketSlugOrQuery}`);
    if (!searchRes.ok) return undefined;
    const events = await searchRes.json() as any[];
    if (!events || events.length === 0) return undefined;
    const event = events[0];
    const market = event.markets?.[0];
    if (!market) return undefined;
    const outcomePrices = JSON.parse(market.outcomePrices || '["0.5", "0.5"]');
    return {
      yes: parseFloat(outcomePrices[0]),
      no: parseFloat(outcomePrices[1]),
      volume24h: parseFloat(market.volume24hr || '0'),
      liquidity: parseFloat(market.liquidity || '0'),
    };
  } catch (err) {
    return undefined;
  }
}

async function getKalshiOdds(marketTicker: string): Promise<MarketOdds['kalshi']> {
  try {
    const res = await proxyFetch(`https://trading-api.kalshi.com/trade-api/v2/markets/${marketTicker}`);
    if (!res.ok) return undefined;
    const data = await res.json() as any;
    const market = data.market;
    if (!market) return undefined;
    return {
      yes: market.yes_bid / 100,
      no: market.no_bid / 100,
      volume24h: market.volume_24h || 0,
    };
  } catch (err) {
    return undefined;
  }
}

async function getMetaculusOdds(questionId: string): Promise<MarketOdds['metaculus']> {
  try {
    const res = await proxyFetch(`https://www.metaculus.com/api2/questions/${questionId}/`);
    if (!res.ok) return undefined;
    const data = await res.json() as any;
    return {
      median: data.prediction_timeseries?.[data.prediction_timeseries.length - 1]?.community_prediction?.median || 0,
      forecasters: data.number_of_forecasters || 0,
    };
  } catch (err) {
    return undefined;
  }
}

// ─── SENTIMENT SCRAPERS ───────────────────────────────

async function scrapeTwitterSentiment(topic: string, country: string): Promise<SentimentData['twitter']> {
  const BROWSER_ENDPOINT = process.env.BROWSER_ENDPOINT || 'https://browser.proxies.sx';
  const BROWSER_PAYMENT_SIG = process.env.BROWSER_PAYMENT_SIG;
  if (!BROWSER_PAYMENT_SIG) return undefined;

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

    if (!res.ok) return undefined;
    const sessionData = await res.json() as { session_id: string; session_token: string };
    sessionId = sessionData.session_id;

    const navigate = await fetch(`${endpoint}/v1/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionData.session_token}` },
      body: JSON.stringify({ action: 'navigate', url: `https://twitter.com/search?q=${encodeURIComponent(topic)}&f=live` }),
    });
    if (!navigate.ok) return undefined;

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

    if (!evaluate.ok) return undefined;
    const tweets = (await evaluate.json()).result as any[];

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
    return undefined;
  } finally {
    if (sessionId) {
      await fetch(`${BROWSER_ENDPOINT.replace(/\/$/, '')}/v1/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => { });
    }
  }
}

async function scrapeRedditSentiment(topic: string): Promise<SentimentData['reddit']> {
  try {
    const res = await proxyFetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&sort=new`);
    if (!res.ok) return undefined;
    const data = await res.json() as any;
    const posts = data.data?.children || [];
    if (posts.length === 0) return undefined;

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
    return undefined;
  }
}

// ─── SIGNAL ANALYTICS ──────────────────────────────────

function detectArbitrage(odds: MarketOdds): SignalData['arbitrage'] {
  if (!odds.polymarket || !odds.kalshi) return undefined;
  const polyYes = odds.polymarket.yes;
  const kalshiYes = odds.kalshi.yes;
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
  if (!odds.polymarket || !sentiment.reddit) return undefined;
  const marketYes = odds.polymarket.yes;
  const socialBullish = sentiment.reddit.positive;
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

serviceRouter.get('/run', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) return c.json({ error: 'WALLET_ADDRESS not set' }, 500);

  const payment = extractPayment(c);
  const price = 0.05;

  if (!payment) {
    return c.json(build402Response('/api/run', PREDICTION_DESCRIPTION, price, walletAddress, PREDICTION_OUTPUT_SCHEMA), 402);
  }

  const verification = await verifyPayment(payment, walletAddress, price);
  if (!verification.valid) return c.json({ error: 'Payment failed' }, 402);

  const type = c.req.query('type') || 'signal';
  const market = c.req.query('market') || 'us-presidential-election-2028';
  const topic = c.req.query('topic') || market;
  const country = (c.req.query('country') || 'US').toUpperCase();

  const odds: MarketOdds = {};
  const sentiment: SentimentData = {};
  const signals: SignalData = {};

  if (type === 'signal' || type === 'arbitrage' || type === 'trending') {
    odds.polymarket = await getPolymarketOdds(market);
    odds.kalshi = await getKalshiOdds(market);
    odds.metaculus = await getMetaculusOdds('1234');
  }

  if (type === 'signal' || type === 'sentiment' || type === 'trending') {
    sentiment.reddit = await scrapeRedditSentiment(topic);
    // Twitter scraper is complex/slow, optional for basic signal
    // sentiment.twitter = await scrapeTwitterSentiment(topic, country);
  }

  if (odds.polymarket && odds.kalshi) signals.arbitrage = detectArbitrage(odds);
  if (odds.polymarket && sentiment.reddit) signals.sentimentDivergence = detectDivergence(odds, sentiment);

  const ip = await getProxyIp();

  return c.json({
    type,
    market,
    timestamp: new Date().toISOString(),
    odds,
    sentiment,
    signals,
    proxy: { country, type: 'mobile', ip },
    payment: { txHash: payment.txHash, amount: price, verified: true },
  });
});

serviceRouter.get('/test', async (c) => {
  const type = c.req.query('type') || 'signal';
  const market = c.req.query('market') || 'us-presidential-election-2028';
  const topic = c.req.query('topic') || market;

  const odds: MarketOdds = {};
  const sentiment: SentimentData = {};
  const signals: SignalData = {};

  if (type === 'signal' || type === 'arbitrage' || type === 'trending') {
    odds.polymarket = await getPolymarketOdds(market);
    odds.kalshi = await getKalshiOdds(market);
  }

  if (type === 'signal' || type === 'sentiment' || type === 'trending') {
    sentiment.reddit = await scrapeRedditSentiment(topic);
  }

  if (odds.polymarket && odds.kalshi) signals.arbitrage = detectArbitrage(odds);
  if (odds.polymarket && sentiment.reddit) signals.sentimentDivergence = detectDivergence(odds, sentiment);

  const ip = await getProxyIp();

  return c.json({
    type,
    market,
    topic,
    odds,
    sentiment,
    signals,
    proxy: { ip },
    _test: true,
    _timestamp: new Date().toISOString(),
  });
});
