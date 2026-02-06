/**
 * ┌─────────────────────────────────────────────────┐
 * │         ✏️  EDIT THIS FILE                       │
 * │  This is the ONLY file you need to change.      │
 * │  Everything else works out of the box.           │
 * └─────────────────────────────────────────────────┘
 *
 * Steps:
 *  1. Change SERVICE_NAME, PRICE_USDC, and DESCRIPTION
 *  2. Update the outputSchema to match your API contract
 *  3. Replace the logic inside the /run handler
 *  4. That's it. Deploy.
 */

import { Hono } from 'hono';
import { proxyFetch, getProxy } from './proxy';
import { extractPayment, verifyPayment, build402Response } from './payment';

export const serviceRouter = new Hono();

// ─── YOUR CONFIGURATION ─────────────────────────────
// Change these three values to match your service.

const SERVICE_NAME = 'google-serp-ai-scraper';
const PRICE_USDC = 0.02;  // $0.02 per request
const DESCRIPTION = 'Scrape Google SERPs with AI Overview text using real mobile IPs.';

// Describes what your API accepts and returns.
// AI agents use this to understand your service contract.
const OUTPUT_SCHEMA = {
  input: {
    q: 'string — search query (required)',
    pages: 'number — number of result pages to fetch (optional, default 1, max 5)',
    num: 'number — results per page (optional, default 10, max 20)',
    start: 'number — offset for first page (optional, default 0)',
    gl: 'string — country code (optional, e.g., US, GB, DE)',
    hl: 'string — language code (optional, e.g., en, de)',
    lr: 'string — language restrict (optional, e.g., lang_en)',
    ai: 'string — ai overview source: "browser" or "html" (optional, default html)',
  },
  output: {
    query: 'string — search query',
    results: 'array — list of results with title, url, snippet, position, page',
    aiOverview: 'object|null — { text, source, page }',
    pages: 'array — per-page metadata and ai overview if found',
    proxy: '{ country: string, type: "mobile" }',
  },
};

// ─── YOUR ENDPOINT ──────────────────────────────────
// This is where your service logic lives.

serviceRouter.get('/run', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  // ── Step 1: Check for payment ──
  const payment = extractPayment(c);

  if (!payment) {
    // No payment header → return 402 with full payment instructions.
    // AI agents parse this JSON to know what to pay and where.
    return c.json(
      build402Response('/api/run', DESCRIPTION, PRICE_USDC, walletAddress, OUTPUT_SCHEMA),
      402,
    );
  }

  // ── Step 2: Verify payment on-chain ──
  const verification = await verifyPayment(payment, walletAddress, PRICE_USDC);

  if (!verification.valid) {
    return c.json({
      error: 'Payment verification failed',
      reason: verification.error,
      hint: 'Ensure the transaction is confirmed and sends the correct USDC amount to the recipient wallet.',
    }, 402);
  }

  // ── Step 3: Validate input ──
  const query = c.req.query('q');
  if (!query) {
    return c.json({ error: 'Missing required parameter: ?q=<search_query>' }, 400);
  }

  const pagesParam = parseInt(c.req.query('pages') || '1', 10);
  const numParam = parseInt(c.req.query('num') || '10', 10);
  const startParam = parseInt(c.req.query('start') || '0', 10);
  const gl = (c.req.query('gl') || 'US').toUpperCase();
  const hl = (c.req.query('hl') || 'en').toLowerCase();
  const lr = c.req.query('lr');
  const aiMode = (c.req.query('ai') || 'html').toLowerCase();

  const pages = Number.isFinite(pagesParam) ? Math.min(Math.max(pagesParam, 1), 5) : 1;
  const num = Number.isFinite(numParam) ? Math.min(Math.max(numParam, 1), 20) : 10;
  const start = Number.isFinite(startParam) ? Math.max(startParam, 0) : 0;

  if (!/^[A-Z]{2}$/.test(gl)) {
    return c.json({ error: 'Invalid gl parameter. Use a 2-letter country code like US.' }, 400);
  }
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(hl)) {
    return c.json({ error: 'Invalid hl parameter. Use a language code like en or en-us.' }, 400);
  }
  if (lr && !/^lang_[a-z]{2}$/i.test(lr)) {
    return c.json({ error: 'Invalid lr parameter. Use format lang_en.' }, 400);
  }
  if (aiMode !== 'html' && aiMode !== 'browser') {
    return c.json({ error: 'Invalid ai parameter. Use "html" or "browser".' }, 400);
  }
  if (aiMode === 'browser' && !process.env.BROWSER_INTERNAL_KEY) {
    return c.json({ error: 'Browser mode requires BROWSER_INTERNAL_KEY to be set.' }, 400);
  }

  // ── Step 4: Your logic — fetch URL through mobile proxy ──
  try {
    const proxy = getProxy();
    const pageResults: Array<{ page: number; start: number; results: any[]; aiOverview: any | null }>
      = [];
    const allResults: Array<{ title: string; url: string; snippet: string; position: number; page: number }>
      = [];

    let aiOverview: { text: string; source: string; page: number } | null = null;

    for (let i = 0; i < pages; i++) {
      const pageStart = start + i * num;
      const searchUrl = buildGoogleUrl(query, num, pageStart, gl, hl, lr || undefined);
      const response = await proxyFetch(searchUrl);
      const html = await response.text();

      const results = extractSerpResults(html, pageStart, i + 1);
      allResults.push(...results);

      let pageAiOverview: { text: string; source: string; page: number } | null = null;

      if (aiMode === 'browser' && !aiOverview) {
        const browserText = await fetchAiOverviewViaBrowser(searchUrl, gl, proxy);
        if (browserText) {
          pageAiOverview = { text: browserText, source: 'browser', page: i + 1 };
          aiOverview = pageAiOverview;
        }
      }

      if (!pageAiOverview) {
        const htmlText = extractAiOverviewFromHtml(html);
        if (htmlText) {
          pageAiOverview = { text: htmlText, source: 'html', page: i + 1 };
          if (!aiOverview) aiOverview = pageAiOverview;
        }
      }

      pageResults.push({ page: i + 1, start: pageStart, results, aiOverview: pageAiOverview });
    }

    // Set payment confirmation headers
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      query,
      params: { pages, num, start, gl, hl, lr: lr || null, ai: aiMode },
      results: allResults,
      aiOverview,
      pages: pageResults,
      proxy: { country: proxy.country, type: 'mobile' },
      payment: {
        txHash: payment.txHash,
        network: payment.network,
        amount: verification.amount,
        settled: true,
      },
    });
  } catch (err: any) {
    return c.json({
      error: 'Service execution failed',
      message: err.message,
      hint: 'Google may be rate limiting or the proxy may be temporarily unavailable.',
    }, 502);
  }
});

function buildGoogleUrl(
  query: string,
  num: number,
  start: number,
  gl: string,
  hl: string,
  lr?: string,
): string {
  const params = new URLSearchParams({
    q: query,
    num: String(num),
    start: String(start),
    gl,
    hl,
    pws: '0',
    safe: 'active',
  });
  if (lr) params.set('lr', lr);
  return `https://www.google.com/search?${params.toString()}`;
}

function extractSerpResults(
  html: string,
  start: number,
  page: number,
): Array<{ title: string; url: string; snippet: string; position: number; page: number }> {
  const results: Array<{ title: string; url: string; snippet: string; position: number; page: number }> = [];
  const seen = new Set<string>();

  const linkRegex = /<a[^>]+href="\/url\?q=([^"&]+)[^\"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = decodeHtml(match[1] || '').replace(/&amp;/g, '&');
    const url = safeDecodeURIComponent(href);
    const anchorHtml = match[2] || '';
    const titleMatch = anchorHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!titleMatch) continue;

    const title = cleanText(titleMatch[1]);
    const key = `${title}|${url}`;
    if (!title || !url || seen.has(key)) continue;

    const afterAnchor = html.slice(match.index, match.index + 2000);
    const snippet = extractSnippet(afterAnchor);

    results.push({
      title,
      url,
      snippet,
      position: start + results.length + 1,
      page,
    });
    seen.add(key);
  }

  return results;
}

function extractSnippet(segment: string): string {
  const snippetRegex = /class="(?:VwiC3b|aCOpRe|s3v9rd|BNeawe s3v9rd AP7Wnd)[^"]*">([\s\S]*?)<\/div>/i;
  const match = segment.match(snippetRegex);
  if (!match) return '';
  return cleanText(match[1]);
}

function extractAiOverviewFromHtml(html: string): string | null {
  const attrIndex = html.indexOf('data-attrid="ai_overview"');
  if (attrIndex === -1) return null;

  const window = html.slice(attrIndex, attrIndex + 12000);
  const text = cleanText(window);
  if (text.length < 40) return null;
  return text.slice(0, 4000);
}

async function fetchAiOverviewViaBrowser(
  url: string,
  gl: string,
  proxy: { host: string; port: number; user: string; pass: string },
): Promise<string | null> {
  const endpoint = (process.env.BROWSER_ENDPOINT || 'https://browser.proxies.sx').replace(/\/$/, '');
  const internalKey = process.env.BROWSER_INTERNAL_KEY;
  if (!internalKey) return null;

  const createRes = await fetch(`${endpoint}/v1/internal/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': internalKey,
    },
    body: JSON.stringify({
      durationMinutes: 15,
      country: gl,
      proxy: {
        server: `${proxy.host}:${proxy.port}`,
        username: proxy.user,
        password: proxy.pass,
        type: 'http',
      },
    }),
  });

  if (!createRes.ok) return null;
  const createData = await createRes.json() as { session_id?: string; session_token?: string };
  const sessionId = createData.session_id;
  const sessionToken = createData.session_token;
  if (!sessionId || !sessionToken) return null;

  try {
    await browserCommand(endpoint, sessionId, sessionToken, { action: 'navigate', url });
    await browserCommand(endpoint, sessionId, sessionToken, { action: 'wait', selector: '#search', timeout: 20000 });
    const contentRes = await browserCommand(endpoint, sessionId, sessionToken, { action: 'content' });
    const html = typeof contentRes?.content === 'string' ? contentRes.content : '';
    return extractAiOverviewFromHtml(html);
  } finally {
    await fetch(`${endpoint}/v1/sessions/${sessionId}`, { method: 'DELETE' });
  }
}

async function browserCommand(
  endpoint: string,
  sessionId: string,
  token: string,
  payload: Record<string, any>,
): Promise<any> {
  const res = await fetch(`${endpoint}/v1/sessions/${sessionId}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    return null;
  }

  return await res.json();
}

function cleanText(value: string): string {
  const noTags = value.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtml(noTags).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
