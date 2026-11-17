import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResults, searchWeb } from '../src/search.js';

test('parseResults turns the page into title, url and snippet rows', () => {
  const html = '<div class="result">'
    + '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example &amp; Co</a>'
    + '<a class="result__snippet" href="#">Some <b>snippet</b> text</a>'
    + '</div>'
    + '<div class="result">'
    + '<a class="result__a" href="https://plain.example/">Plain</a>'
    + '</div>';
  const rows = parseResults(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Example & Co');
  assert.equal(rows[0].url, 'https://example.com/a');
  assert.equal(rows[0].snippet, 'Some snippet text');
  assert.equal(rows[1].url, 'https://plain.example/');
});

test('searchWeb returns a bounded list, or a plain reason', async () => {
  const html = '<a class="result__a" href="https://a.example/">A</a>'
    + '<a class="result__snippet" href="#">a b c</a>'
    + '<a class="result__a" href="https://b.example/">B</a>'
    + '<a class="result__snippet" href="#">d e f</a>';
  const fetchImpl = async (url, opts) => {
    assert.ok(url.includes('q=monastery%20minsk'), 'the query is encoded');
    assert.ok(opts.signal, 'search is abortable');
    return { ok: true, text: async () => html };
  };
  const out = await searchWeb('monastery minsk', { fetchImpl });
  assert.ok(out.includes('1. A') && out.includes('https://a.example/'));
  assert.equal(await searchWeb('', { fetchImpl }), '(web search: empty query)');
  const failing = await searchWeb('x', {
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }),
  });
  assert.equal(failing, '(web search: http 403)');
  const refusing = await searchWeb('x', {
    fetchImpl: async () => { throw new Error('refused'); },
  });
  assert.equal(refusing, '(web search: network error)');
});
