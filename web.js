/**
 * NEXUS — tools/web.js
 * Live web access. No external AI. No headless browser.
 * Clean text extraction. Smart crawling. Cached with TTL.
 */

'use strict';

const https    = require('https');
const http     = require('http');
const url      = require('url');
const zlib     = require('zlib');
const { performance } = require('perf_hooks');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT   = 8000;
const MAX_BODY_SIZE     = 5 * 1024 * 1024; // 5MB max response
const MAX_REDIRECTS     = 5;
const CACHE_TTL_MS      = 5 * 60 * 1000;   // 5 minutes
const USER_AGENT        = 'Mozilla/5.0 (compatible; NEXUS/1.0; +https://nexus.ai/bot)';

// Simple in-process response cache
const responseCache = new Map();

// ─── Core Fetch ───────────────────────────────────────────────────────────────

function fetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method     = 'GET',
      headers    = {},
      timeout    = DEFAULT_TIMEOUT,
      maxRedirects = MAX_REDIRECTS,
      body       = null,
      redirectCount = 0,
    } = options;

    // Check cache
    const cacheKey = `${method}:${targetUrl}`;
    if (method === 'GET' && responseCache.has(cacheKey)) {
      const cached = responseCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return resolve({ ...cached, fromCache: true });
      }
      responseCache.delete(cacheKey);
    }

    const parsedUrl = url.parse(targetUrl);
    const isHttps   = parsedUrl.protocol === 'https:';
    const lib       = isHttps ? https : http;

    const reqOptions = {
      hostname:  parsedUrl.hostname,
      port:      parsedUrl.port || (isHttps ? 443 : 80),
      path:      parsedUrl.path || '/',
      method,
      headers: {
        'User-Agent':      USER_AGENT,
        'Accept':          'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection':      'keep-alive',
        ...headers,
      },
    };

    const req = lib.request(reqOptions, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (redirectCount >= maxRedirects) {
          return reject(new Error(`Too many redirects (${maxRedirects})`));
        }
        const redirectUrl = res.headers.location;
        if (!redirectUrl) return reject(new Error('Redirect with no Location header'));

        // Resolve relative redirects
        const resolved = url.resolve(targetUrl, redirectUrl);
        return fetch(resolved, { ...options, redirectCount: redirectCount + 1 })
          .then(resolve)
          .catch(reject);
      }

      const chunks = [];
      let totalSize = 0;

      // Handle compression
      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      if (encoding === 'br')      stream = res.pipe(zlib.createBrotliDecompress());

      stream.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const bodyBuffer   = Buffer.concat(chunks);
        const contentType  = res.headers['content-type'] || '';
        const isText       = contentType.includes('text') || contentType.includes('json') || contentType.includes('xml');
        const body         = isText ? bodyBuffer.toString('utf8') : bodyBuffer;

        const result = {
          status:      res.statusCode,
          headers:     res.headers,
          contentType,
          body,
          bodySize:    totalSize,
          url:         targetUrl,
          timestamp:   Date.now(),
          fromCache:   false,
        };

        // Cache successful GET responses
        if (method === 'GET' && res.statusCode === 200) {
          responseCache.set(cacheKey, result);
        }

        resolve(result);
      });

      stream.on('error', reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

// ─── HTML → Clean Text ────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';

  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Preserve semantic newlines for block elements
  text = text.replace(/<(\/?(p|div|section|article|h[1-6]|li|blockquote|pre|br|tr|td|th))[^>]*>/gi, '\n');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, ' ');

  // Clean whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

// ─── Smart Content Extraction ─────────────────────────────────────────────────
// Targets <main>, <article>, role="main" — skips nav/ads/footer

function extractMainContent(html) {
  // Priority order: main > article > role=main > #content > #main > body
  const patterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /role=["']main["'][^>]*>([\s\S]*?)<\//i,
    /id=["']content["'][^>]*>([\s\S]*?)<\/\w+>/i,
    /id=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1].length > 200) {
      return htmlToText(match[1]);
    }
  }

  return htmlToText(html);
}

// ─── Title + Meta Extraction ──────────────────────────────────────────────────

function extractMeta(html) {
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const desc  = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';
  const og    = {
    title: (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)   || [])[1] || '',
    desc:  (html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '',
  };

  return {
    title: og.title || title.trim(),
    description: og.desc || desc.trim(),
  };
}

// ─── Search (DuckDuckGo HTML scrape) ─────────────────────────────────────────
// No API key. No authentication. Just the open web.

async function search(query, maxResults = 8) {
  const t0  = performance.now();
  const encoded = encodeURIComponent(query);

  // Use DuckDuckGo HTML endpoint (no JS required, no rate limiting on HTML)
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}&kl=us-en`;

  let response;
  try {
    response = await fetch(searchUrl, {
      headers: { 'Accept': 'text/html' },
      timeout: 6000,
    });
  } catch (e) {
    throw new Error(`Search fetch failed: ${e.message}`);
  }

  if (response.status !== 200) {
    throw new Error(`Search returned status ${response.status}`);
  }

  const html    = response.body;
  const results = [];

  // Parse DDG HTML results
  const resultPattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

  const urlMatches     = [...html.matchAll(resultPattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];

  for (let i = 0; i < Math.min(urlMatches.length, maxResults); i++) {
    const rawUrl = urlMatches[i][1];
    const title  = htmlToText(urlMatches[i][2]).trim();

    // DDG wraps URLs — extract the actual URL
    const uddg    = rawUrl.match(/uddg=([^&]+)/);
    const realUrl = uddg ? decodeURIComponent(uddg[1]) : rawUrl;

    if (!realUrl.startsWith('http')) continue;

    results.push({
      rank:    i + 1,
      url:     realUrl,
      title,
      snippet: snippetMatches[i] ? htmlToText(snippetMatches[i][1]).trim() : '',
    });
  }

  return {
    query,
    results,
    count:    results.length,
    elapsed:  (performance.now() - t0).toFixed(0) + 'ms',
    source:   'duckduckgo-html',
  };
}

// ─── Fetch + Extract (Smart Page Read) ────────────────────────────────────────

async function readPage(targetUrl, options = {}) {
  const t0       = performance.now();
  const response = await fetch(targetUrl, options);

  if (response.status !== 200) {
    return {
      url:     targetUrl,
      status:  response.status,
      content: null,
      error:   `HTTP ${response.status}`,
    };
  }

  const isHTML = response.contentType.includes('text/html');
  const isJSON = response.contentType.includes('json');

  let content, meta;

  if (isJSON) {
    try {
      content = JSON.parse(response.body);
      meta    = { title: targetUrl, description: '' };
    } catch {
      content = response.body;
      meta    = { title: targetUrl, description: '' };
    }
  } else if (isHTML) {
    content = extractMainContent(response.body);
    meta    = extractMeta(response.body);
  } else {
    content = typeof response.body === 'string' ? response.body : '[binary content]';
    meta    = { title: targetUrl, description: '' };
  }

  return {
    url:         targetUrl,
    status:      response.status,
    title:       meta?.title || '',
    description: meta?.description || '',
    content,
    contentType: response.contentType,
    bodySize:    response.bodySize,
    fromCache:   response.fromCache,
    elapsed:     (performance.now() - t0).toFixed(0) + 'ms',
  };
}

// ─── Search + Synthesize ──────────────────────────────────────────────────────
// Searches, fetches top N results, extracts content, returns synthesis material

async function searchAndRead(query, options = {}) {
  const { maxResults = 5, readTopN = 3 } = options;
  const t0 = performance.now();

  // Step 1: Search
  const searchResult = await search(query, maxResults);
  const topResults   = searchResult.results.slice(0, readTopN);

  // Step 2: Fetch pages in parallel
  const pageReads = await Promise.allSettled(
    topResults.map(r => readPage(r.url).catch(e => ({ url: r.url, error: e.message })))
  );

  const pages = pageReads.map((r, i) => ({
    ...topResults[i],
    ...(r.status === 'fulfilled' ? r.value : { content: null, error: r.reason?.message }),
  }));

  return {
    query,
    searchResults: searchResult.results,
    pages,
    elapsed: (performance.now() - t0).toFixed(0) + 'ms',
    readCount: pages.filter(p => p.content).length,
  };
}

// ─── Clear Cache ──────────────────────────────────────────────────────────────

function clearCache() {
  const size = responseCache.size;
  responseCache.clear();
  return { cleared: size };
}

function cacheStats() {
  return { entries: responseCache.size };
}

module.exports = {
  fetch,
  search,
  readPage,
  searchAndRead,
  htmlToText,
  extractMainContent,
  clearCache,
  cacheStats,
};
