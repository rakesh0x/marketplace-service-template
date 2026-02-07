/**
 * ┌─────────────────────────────────────────────────┐
 * │    Google SERP + AI Search Scraper (Bounty #1)  │
 * │  Browser-first approach for reliable scraping   │
 * │  Handles AI Overview, Featured Snippets, PAA    │
 * └─────────────────────────────────────────────────┘
 */

import { Hono } from 'hono';
import { getProxy } from './proxy';
import { extractPayment, verifyPayment, build402Response } from './payment';

export const serviceRouter = new Hono();

// ─── SERVICE CONFIGURATION ─────────────────────────────
const SERVICE_NAME = 'google-serp-ai-scraper';
const PRICE_USDC = 0.01;  // $0.01 per query
const DESCRIPTION = 'Scrape Google SERPs with AI Overview, Featured Snippets, and People Also Ask using real browser rendering and mobile IPs.';

// Browser API configuration
const BROWSER_ENDPOINT = process.env.BROWSER_ENDPOINT || 'https://browser.proxies.sx';

const OUTPUT_SCHEMA = {
  input: {
    q: 'string — search query (required)',
    gl: 'string — country code (optional, e.g., US, GB, DE, default US)',
    hl: 'string — language code (optional, e.g., en, de, default en)',
    num: 'number — results per page (optional, default 10, max 20)',
  },
  output: {
    query: 'string — search query',
    country: 'string — country code used',
    results: {
      organic: 'array — [{position, title, url, snippet}]',
      aiOverview: 'object|null — {text, sources: [{title, url}]}',
      featuredSnippet: 'object|null — {text, source, url}',
      peopleAlsoAsk: 'array — list of questions',
      relatedSearches: 'array — list of related search terms',
    },
    proxy: '{ country: string, type: "mobile" }',
  },
};

// ─── TYPES ─────────────────────────────────────────────

interface OrganicResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
}

interface AiOverview {
  text: string;
  sources: Array<{ title: string; url: string }>;
}

interface FeaturedSnippet {
  text: string;
  source: string;
  url: string;
}

interface SerpResults {
  organic: OrganicResult[];
  aiOverview: AiOverview | null;
  featuredSnippet: FeaturedSnippet | null;
  peopleAlsoAsk: string[];
  relatedSearches: string[];
}

interface BrowserSession {
  sessionId: string;
  sessionToken: string;
}

// ─── BROWSER SESSION MANAGEMENT ─────────────────────────

async function createBrowserSession(
  country: string,
  proxy: { host: string; port: number; user: string; pass: string },
): Promise<BrowserSession | null> {
  const endpoint = BROWSER_ENDPOINT.replace(/\/$/, '');
  const internalKey = process.env.BROWSER_INTERNAL_KEY;

  if (!internalKey) {
    console.error('BROWSER_INTERNAL_KEY not set');
    return null;
  }

  const createRes = await fetch(`${endpoint}/v1/internal/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': internalKey,
    },
    body: JSON.stringify({
      durationMinutes: 10,
      country,
      proxy: {
        server: `${proxy.host}:${proxy.port}`,
        username: proxy.user,
        password: proxy.pass,
        type: 'http',
      },
    }),
  });

  if (!createRes.ok) {
    console.error('Failed to create browser session:', await createRes.text());
    return null;
  }

  const data = await createRes.json() as { session_id?: string; session_token?: string };
  if (!data.session_id || !data.session_token) return null;

  return {
    sessionId: data.session_id,
    sessionToken: data.session_token,
  };
}

async function browserCommand(
  sessionId: string,
  token: string,
  payload: Record<string, any>,
): Promise<any> {
  const endpoint = BROWSER_ENDPOINT.replace(/\/$/, '');

  const res = await fetch(`${endpoint}/v1/sessions/${sessionId}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Browser command failed:', text);
    return null;
  }

  return await res.json();
}

async function closeBrowserSession(sessionId: string): Promise<void> {
  const endpoint = BROWSER_ENDPOINT.replace(/\/$/, '');
  await fetch(`${endpoint}/v1/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => { });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CONSENT / CAPTCHA HANDLING ─────────────────────────

async function handleConsentAndCaptcha(
  sessionId: string,
  token: string,
): Promise<{ success: boolean; captchaDetected: boolean }> {
  // Check for consent screen (EU cookie consent)
  const acceptConsent = await browserCommand(sessionId, token, {
    action: 'click',
    selector: 'button#L2AGLb, button[aria-label*="Accept"], form[action*="consent"] button',
    timeout: 2000,
  });

  if (acceptConsent) {
    await sleep(1500);
  }

  // Check for CAPTCHA
  const contentRes = await browserCommand(sessionId, token, { action: 'content' });
  const html = typeof contentRes?.content === 'string' ? contentRes.content : '';

  const captchaIndicators = [
    'unusual traffic',
    'captcha',
    'recaptcha',
    'g-recaptcha',
    'not a robot',
    'automated queries',
  ];

  const captchaDetected = captchaIndicators.some(indicator =>
    html.toLowerCase().includes(indicator)
  );

  return { success: !captchaDetected, captchaDetected };
}

// ─── GOOGLE SEARCH & DOM EXTRACTION ─────────────────────

function buildGoogleUrl(
  query: string,
  num: number,
  gl: string,
  hl: string,
): string {
  const params = new URLSearchParams({
    q: query,
    num: String(num),
    gl,
    hl,
    pws: '0',
    safe: 'active',
  });
  return `https://www.google.com/search?${params.toString()}`;
}

async function extractSerpFromBrowser(
  sessionId: string,
  token: string,
): Promise<SerpResults> {
  const results: SerpResults = {
    organic: [],
    aiOverview: null,
    featuredSnippet: null,
    peopleAlsoAsk: [],
    relatedSearches: [],
  };

  // Extract organic results using JavaScript evaluation in browser
  const organicRes = await browserCommand(sessionId, token, {
    action: 'evaluate',
    script: `
      (() => {
        const results = [];
        // Multiple selectors for organic results (Google changes these)
        const containers = document.querySelectorAll('div.g, div[data-hveid] > div.g, div.MjjYud > div.g');
        let position = 1;
        
        containers.forEach(container => {
          const linkEl = container.querySelector('a[href^="http"]:not([href*="google.com"])');
          const titleEl = container.querySelector('h3');
          const snippetEl = container.querySelector('[data-sncf], [data-snf], .VwiC3b, .lEBKkf, span.aCOpRe');
          
          if (linkEl && titleEl) {
            const url = linkEl.href;
            const title = titleEl.textContent?.trim() || '';
            const snippet = snippetEl?.textContent?.trim() || '';
            
            // Skip if URL is google or already seen
            if (url && title && !url.includes('google.com/search')) {
              results.push({ position: position++, title, url, snippet });
            }
          }
        });
        
        return results.slice(0, 20);
      })()
    `,
  });

  if (organicRes?.result && Array.isArray(organicRes.result)) {
    results.organic = organicRes.result;
  }

  // Extract AI Overview
  const aiRes = await browserCommand(sessionId, token, {
    action: 'evaluate',
    script: `
      (() => {
        // Look for AI Overview container
        const aiContainer = document.querySelector('[data-attrid="ai_overview"]') ||
                           document.querySelector('div[data-sgrd]') ||
                           document.querySelector('.wDYxhc[data-md]');
        
        if (!aiContainer) return null;
        
        const text = aiContainer.textContent?.trim() || '';
        if (text.length < 50) return null;
        
        // Extract sources from AI Overview
        const sources = [];
        const sourceLinks = aiContainer.querySelectorAll('a[href^="http"]');
        sourceLinks.forEach(link => {
          const title = link.textContent?.trim() || '';
          const url = link.href;
          if (title && url && !url.includes('google.com')) {
            sources.push({ title: title.slice(0, 100), url });
          }
        });
        
        return {
          text: text.slice(0, 4000),
          sources: sources.slice(0, 5),
        };
      })()
    `,
  });

  if (aiRes?.result) {
    results.aiOverview = aiRes.result;
  }

  // Extract Featured Snippet
  const snippetRes = await browserCommand(sessionId, token, {
    action: 'evaluate',
    script: `
      (() => {
        // Featured snippet is usually in a block-component or xpdopen
        const snippetContainer = document.querySelector('.xpdopen .kno-rdesc, .xpdopen .ILfuVd, div.xpdopen span[data-ved], .co8aDb');
        const linkEl = snippetContainer?.closest('.xpdopen')?.querySelector('a[href^="http"]') ||
                       snippetContainer?.parentElement?.querySelector('a[href^="http"]');
        
        if (!snippetContainer) return null;
        
        const text = snippetContainer.textContent?.trim() || '';
        if (text.length < 20) return null;
        
        const url = linkEl?.href || '';
        const source = linkEl?.textContent?.trim() || new URL(url).hostname || '';
        
        return { text: text.slice(0, 1000), source, url };
      })()
    `,
  });

  if (snippetRes?.result) {
    results.featuredSnippet = snippetRes.result;
  }

  // Extract People Also Ask
  const paaRes = await browserCommand(sessionId, token, {
    action: 'evaluate',
    script: `
      (() => {
        const questions = [];
        // PAA questions are in expandable divs
        const paaItems = document.querySelectorAll('[data-sgrd="true"] [jsname], div.related-question-pair, div[data-q]');
        
        paaItems.forEach(item => {
          const text = item.getAttribute('data-q') || item.textContent?.trim() || '';
          if (text && text.length > 10 && text.length < 200) {
            questions.push(text);
          }
        });
        
        // Also check for accordion-style questions
        document.querySelectorAll('[role="button"][aria-expanded]').forEach(btn => {
          const text = btn.textContent?.trim() || '';
          if (text && text.endsWith('?') && text.length > 10 && text.length < 200) {
            if (!questions.includes(text)) {
              questions.push(text);
            }
          }
        });
        
        return [...new Set(questions)].slice(0, 10);
      })()
    `,
  });

  if (paaRes?.result && Array.isArray(paaRes.result)) {
    results.peopleAlsoAsk = paaRes.result;
  }

  // Extract Related Searches
  const relatedRes = await browserCommand(sessionId, token, {
    action: 'evaluate',
    script: `
      (() => {
        const searches = [];
        // Related searches at bottom of page
        const relatedItems = document.querySelectorAll('div.k8XOCe a, a.ZWRArf, div.s75CSd a, div.brs_col a');
        
        relatedItems.forEach(item => {
          const text = item.textContent?.trim() || '';
          if (text && text.length > 2 && text.length < 100) {
            searches.push(text);
          }
        });
        
        return [...new Set(searches)].slice(0, 8);
      })()
    `,
  });

  if (relatedRes?.result && Array.isArray(relatedRes.result)) {
    results.relatedSearches = relatedRes.result;
  }

  return results;
}

// ─── MAIN SCRAPING FUNCTION WITH RETRY ─────────────────

async function scrapeGoogleSerp(
  query: string,
  gl: string,
  hl: string,
  num: number,
  maxRetries: number = 2,
): Promise<{ success: boolean; results?: SerpResults; error?: string }> {
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let session: BrowserSession | null = null;

    try {
      const proxy = getProxy();
      session = await createBrowserSession(gl, proxy);

      if (!session) {
        lastError = 'Failed to create browser session';
        continue;
      }

      const { sessionId, sessionToken } = session;
      const searchUrl = buildGoogleUrl(query, num, gl, hl);

      // Navigate to Google
      await browserCommand(sessionId, sessionToken, {
        action: 'navigate',
        url: searchUrl,
      });

      // Wait for search results to load
      await browserCommand(sessionId, sessionToken, {
        action: 'wait',
        selector: '#search, #rso, div.g',
        timeout: 15000,
      });

      await sleep(1500);

      // Handle consent screens and check for CAPTCHA
      const { success, captchaDetected } = await handleConsentAndCaptcha(sessionId, sessionToken);

      if (captchaDetected) {
        lastError = 'CAPTCHA detected, retrying with new IP';
        await closeBrowserSession(sessionId);
        session = null;
        continue;
      }

      // If consent was handled, wait and reload if needed
      if (!success) {
        await browserCommand(sessionId, sessionToken, {
          action: 'navigate',
          url: searchUrl,
        });
        await sleep(2000);
      }

      // Extract all results from rendered DOM
      const results = await extractSerpFromBrowser(sessionId, sessionToken);

      // Validate we got meaningful results
      if (results.organic.length === 0) {
        // Try scrolling to load more content
        await browserCommand(sessionId, sessionToken, {
          action: 'evaluate',
          script: 'window.scrollTo(0, document.body.scrollHeight / 2);',
        });
        await sleep(1000);

        // Re-extract
        const retryResults = await extractSerpFromBrowser(sessionId, sessionToken);
        if (retryResults.organic.length === 0) {
          lastError = 'No organic results found - page may not have loaded correctly';
          continue;
        }
        return { success: true, results: retryResults };
      }

      return { success: true, results };
    } catch (err: any) {
      lastError = err.message || 'Unknown error';
    } finally {
      if (session) {
        await closeBrowserSession(session.sessionId);
      }
    }
  }

  return { success: false, error: lastError };
}

// ─── MAIN ENDPOINT ──────────────────────────────────

serviceRouter.get('/run', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  if (!process.env.BROWSER_INTERNAL_KEY) {
    return c.json({ error: 'Service misconfigured: BROWSER_INTERNAL_KEY not set' }, 500);
  }

  // ── Step 1: Check for payment ──
  const payment = extractPayment(c);

  if (!payment) {
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

  const gl = (c.req.query('gl') || 'US').toUpperCase();
  const hl = (c.req.query('hl') || 'en').toLowerCase();
  const numParam = parseInt(c.req.query('num') || '10', 10);
  const num = Number.isFinite(numParam) ? Math.min(Math.max(numParam, 1), 20) : 10;

  if (!/^[A-Z]{2}$/.test(gl)) {
    return c.json({ error: 'Invalid gl parameter. Use a 2-letter country code like US, GB, DE.' }, 400);
  }
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(hl)) {
    return c.json({ error: 'Invalid hl parameter. Use a language code like en or en-us.' }, 400);
  }

  // ── Step 4: Scrape Google with browser ──
  try {
    const proxy = getProxy();
    const scrapeResult = await scrapeGoogleSerp(query, gl, hl, num);

    if (!scrapeResult.success || !scrapeResult.results) {
      return c.json({
        error: 'Failed to scrape Google SERP',
        message: scrapeResult.error,
        hint: 'Google may be blocking requests. Try again with a different geo or query.',
      }, 502);
    }

    // Set payment confirmation headers
    c.header('X-Payment-Settled', 'true');
    c.header('X-Payment-TxHash', payment.txHash);

    return c.json({
      query,
      country: gl,
      results: scrapeResult.results,
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
      hint: 'Browser automation or proxy may be temporarily unavailable.',
    }, 502);
  }
});

// Also support GET for discovery (returns payment instructions)
serviceRouter.get('/discover', async (c) => {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) {
    return c.json({ error: 'Service misconfigured: WALLET_ADDRESS not set' }, 500);
  }

  const paymentInfo = build402Response('/api/run', DESCRIPTION, PRICE_USDC, walletAddress, OUTPUT_SCHEMA);
  return c.json({
    ...paymentInfo,
    service: SERVICE_NAME,
  });
});
