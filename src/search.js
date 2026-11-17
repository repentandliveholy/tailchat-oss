// The web, without a browser: DuckDuckGo's plain HTML endpoint is scraped into
// a short list of titles, URLs and snippets. A fixed read-only GET, so it is a
// built-in tool like the version history — no shell, no approval — and the
// query is URL-encoded, so nothing the model writes can reach beyond the query.
const ENDPOINT = 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Pure split of the results page into { title, url, snippet } rows.
export function parseResults(html) {
  const anchors = [...String(html ?? '').matchAll(
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  )];
  const snippets = [...String(html ?? '').matchAll(
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  )];
  return anchors.map(([, href, titleHtml], i) => ({
    title: clean(titleHtml),
    url: cleanUrl(href),
    snippet: clean(snippets[i]?.[1] ?? ''),
  }));
}

// What the model gets for a `!search <query>` line: a bounded list of rows.
export async function searchWeb(query, {
  fetchImpl = globalThis.fetch, maxResults = 8, maxChars = 6000, signal = null,
} = {}) {
  const q = String(query ?? '').trim();
  if (q === '') return '(web search: empty query)';

  // /stop can interrupt the search the same way it interrupts the model call.
  const controller = new AbortController();
  let stopped = false;
  const onAbort = () => { stopped = true; controller.abort(); };
  if (signal) {
    if (signal.aborted) { stopped = true; controller.abort(); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 15_000);

  let response;
  try {
    response = await fetchImpl(`${ENDPOINT}?q=${encodeURIComponent(q)}`, {
      headers: { 'user-agent': UA, 'accept-language': 'en' },
      signal: controller.signal,
    });
  } catch {
    return stopped ? '(web search: stopped)' : '(web search: network error)';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (!response.ok) return `(web search: http ${response.status})`;
  const html = await response.text().catch(() => '');
  const results = parseResults(html).slice(0, maxResults);
  if (results.length === 0) return '(web search: no results)';
  const body = results
    .map((row, i) => `${i + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`)
    .join('\n');
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

function clean(text) {
  return decodeEntities(String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

// DuckDuckGo wraps real addresses in a redirect: unwrap it, keep the rest.
function cleanUrl(href) {
  const h = String(href ?? '').trim();
  const redirect = /^\/\/duckduckgo\.com\/l\/\?uddg=([^&]+)/i.exec(h);
  if (redirect) {
    try {
      return decodeURIComponent(redirect[1]);
    } catch { /* keep the redirect address as-is */ }
  }
  if (h.startsWith('//')) return `https:${h}`;
  return h;
}
