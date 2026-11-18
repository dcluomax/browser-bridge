import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REDACTED,
  assertAllowedByLists,
  detectBotChallenge,
  isUrlAllowed,
  normalizeAllowedOrigins,
  redactBodyText,
  redactHeaders,
  redactUrl,
} from '../src/background/allowlist.ts';

test('allowedOrigins matches exact origins, bare hosts, and wildcard subdomains without prefix spoofing', () => {
  const list = normalizeAllowedOrigins(['https://app.diagrams.net', '*.github.com', 'localhost:3000']);
  assert.deepEqual(list, ['https://app.diagrams.net', '*.github.com', 'localhost:3000']);
  assert.equal(isUrlAllowed('about:blank', list), true);
  assert.equal(isUrlAllowed('https://app.diagrams.net/?splash=0#', list), true);
  assert.equal(isUrlAllowed('http://app.diagrams.net/', list), false);
  assert.equal(isUrlAllowed('https://github.com/anomalyco/browse', list), true);
  assert.equal(isUrlAllowed('https://gist.github.com/user/1', list), true);
  assert.equal(isUrlAllowed('https://evil-github.com/', list), false);
  assert.equal(isUrlAllowed('http://localhost:3000/api', list), true);
  assert.equal(isUrlAllowed('http://localhost:4000/api', list), false);
  assert.throws(() => assertAllowedByLists('https://attacker.example/', list, undefined), /origin_blocked|allowlist/);
});

test('credential redaction scrubs headers, query tokens, JSON secrets, form passwords, and JWTs', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlMTIzNDU2'].join('.');
  const cleanUrl = redactUrl(`https://api.example.com/v1/items?page=2&api_key=sk-secret&jwt=${jwt}`);
  assert.equal(cleanUrl, `https://api.example.com/v1/items?page=2&api_key=${REDACTED}&jwt=${REDACTED}`);

  const headers = redactHeaders([
    { name: 'Authorization', value: 'Bearer top-secret-token-value' },
    { name: 'Cookie', value: 'sid=abc123' },
    { name: 'Content-Type', value: 'application/json' },
  ]);
  assert.equal(headers.authorization, REDACTED);
  assert.equal(headers.cookie, REDACTED);
  assert.equal(headers['content-type'], 'application/json');

  const jsonBody = redactBodyText(JSON.stringify({ username: 'max', password: 'pw', nested: { access_token: 'tok' } }));
  assert.equal(jsonBody, JSON.stringify({ username: 'max', password: REDACTED, nested: { access_token: REDACTED } }));

  const formBody = redactBodyText('email=max%40example.com&otp=928374&keep=1');
  assert.equal(formBody, `email=max%40example.com&otp=${REDACTED}&keep=1`);
});

test('bot challenge detector flags Cloudflare, CAPTCHAs, and HTTP 403/429 walls', () => {
  const cf = detectBotChallenge({ status: 403, title: 'Just a moment...', url: 'https://site.test/' });
  assert.equal(cf?.kind, 'cloudflare');
  assert.equal(cf?.suggestHandoff, true);

  const cap = detectBotChallenge({ status: 200, title: 'Checkout', markers: ['hcaptcha'] });
  assert.equal(cap?.kind, 'captcha');

  const normal404 = detectBotChallenge({ status: 404, title: 'Not Found', textSample: 'Page missing' });
  assert.equal(normal404, null);
});
