import assert from 'node:assert/strict';

const locator = (selector) => ({ steps: [{ kind: 'css', value: selector }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDebugChecks(client, { base, instance, kind, check, createClient, env }) {
  async function tool(name, args = {}, selectedClient = client) {
    const result = await selectedClient.call(name, { ...args, browser: instance });
    if (result.isError) throw new Error(`${name}: ${result.text}`);
    return result;
  }
  async function structured(name, args = {}, selectedClient = client) {
    const result = await tool(name, args, selectedClient);
    const data = result.result.structuredContent;
    assert.ok(data && typeof data === 'object' && !Array.isArray(data), `${name} must return structuredContent`);
    return data;
  }
  const target = locator('#debug-target');
  await tool('browser_navigate', { url: `${base}/debug.html` });
  const initial = await structured('browser_styles', { locator: target, properties: ['color', 'padding-left'] });
  check('computed style evidence has exact rendered values', initial.properties.color === 'rgb(20, 30, 40)' && initial.properties['padding-left'] === '8px' && initial.complete, JSON.stringify(initial));
  const context = await structured('browser_styles', { action: 'context', locator: target });
  check('stylesheet context describes the selected element', context.element.ref === initial.element.ref && JSON.stringify(context).includes('#debug-target'), JSON.stringify(context));

  const box = await structured('browser_layout', { locator: locator('#point-target') });
  check('box model measures content, padding and borders in CSS pixels',
    box.coordinateSpace === 'viewport-css-pixels' && box.boundingRect.width === 180 && box.boundingRect.height === 80 &&
    box.padding.left === 8 && box.border.left === 2, JSON.stringify(box));
  const hit = await structured('browser_layout', {
    action: 'hitTest', x: box.boundingRect.left + box.boundingRect.width / 2, y: box.boundingRect.top + box.boundingRect.height / 2,
  });
  check('hit test reports the actual covering element without input', hit.top?.text === 'Point cover' && hit.stack[0].relationship === 'top' && hit.complete, JSON.stringify(hit));

  const baseline = await structured('browser_dom_baseline', { locator: target });
  const before = await structured('browser_dom_baseline', { action: 'compare', id: baseline.id });
  check('complete scoped baseline proves initial equality', before.complete && before.unchanged === true && before.totals.total === 0, JSON.stringify(before));
  const patch = await structured('browser_patch', {
    action: 'apply',
    changes: [{ target: { locator: target }, text: 'Patched heading', styles: { color: 'rgb(0, 128, 0)' }, attributes: { title: 'Temporary probe' } }],
  });
  const during = await structured('browser_styles', { locator: target, properties: ['color'] });
  const changed = await structured('browser_dom_baseline', { action: 'compare', id: baseline.id });
  check('temporary patch changes actual style and semantic DOM evidence',
    during.properties.color === 'rgb(0, 128, 0)' && changed.complete && changed.unchanged === false &&
    changed.changes.some((change) => change.after?.text === 'Patched heading' && change.before?.text === 'Baseline heading'), JSON.stringify(changed));
  await structured('browser_patch', { action: 'rollback', id: patch.id });
  const restored = await structured('browser_dom_baseline', { action: 'compare', id: baseline.id });
  const restoredStyle = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('rollback restores both rendered style and semantic baseline',
    restored.unchanged === true && restoredStyle.properties.color === 'rgb(20, 30, 40)' &&
    (await structured('browser_patch')).patches.length === 0, JSON.stringify(restored));

  const partial = await structured('browser_dom_baseline', { locator: locator('#debug-root'), maxNodes: 1 });
  const partialDiff = await structured('browser_dom_baseline', { action: 'compare', id: partial.id });
  check('one-node capture cannot claim full scoped equality',
    partial.capture.complete === false && partialDiff.complete === false && partialDiff.unchanged === null && partialDiff.totalsExact === false, JSON.stringify(partialDiff));
  await structured('browser_dom_baseline', { action: 'release', id: partial.id });
  await structured('browser_dom_baseline', { action: 'release', id: baseline.id });

  const privateBaseline = await structured('browser_dom_baseline', { locator: locator('#debug-root') });
  await tool('browser_type', { locator: locator('input[type="password"]'), text: 'changed-fixture-password', clear: true });
  const privateDiff = await structured('browser_dom_baseline', { action: 'compare', id: privateBaseline.id });
  check('sensitive control values stay outside sanitized baseline evidence',
    !JSON.stringify(privateDiff).includes('changed-fixture-password') && privateDiff.before.omissions.formControls >= 2, JSON.stringify(privateDiff.before));
  await structured('browser_dom_baseline', { action: 'release', id: privateBaseline.id });

  const routine = {
    name: 'verify_debug_patch',
    description: 'Create fresh evidence, prove a leaf-text patch, and restore the document.',
    readOnly: false,
    params: { selector: { type: 'string', default: '#debug-target' } },
    steps: [
      { op: 'domBaseline', params: { action: 'create', locator: locator('{{selector}}') }, saveAs: 'baseline' },
      { op: 'patch', params: { action: 'apply', changes: [{ target: { locator: locator('{{selector}}') }, text: 'Routine heading' }] }, saveAs: 'patch' },
      { op: 'domBaseline', params: { action: 'compare', id: '{{baseline.id}}' }, saveAs: 'changed' },
      { op: 'patch', params: { action: 'rollback', id: '{{patch.id}}' } },
      { op: 'domBaseline', params: { action: 'compare', id: '{{baseline.id}}' }, saveAs: 'restored' },
      { op: 'domBaseline', params: { action: 'release', id: '{{baseline.id}}' } },
    ],
  };
  await tool('browser_routine_save', { domain: '127.0.0.1', routine });
  const firstRun = JSON.parse((await tool('browser_routine_run', { domain: '127.0.0.1', name: routine.name })).text);
  check('diagnostic Routine creates handles and verifies restoration in one execution',
    firstRun.outputs.changed.unchanged === false && firstRun.outputs.restored.unchanged === true, JSON.stringify(firstRun));
  const catalog = await tool('browser_routine_list', { domain: '127.0.0.1', includeTrace: false });
  check('site memory keeps runtime bindings instead of live document handles', !catalog.text.includes(firstRun.outputs.baseline.id) && catalog.text.includes('{{baseline.id}}'));

  const second = createClient(env);
  try {
    await second.initialize();
    await tool('browser_tabs', { action: 'new', url: `${base}/debug.html` }, second);
    const reuse = await second.call('browser_dom_baseline', { browser: instance, action: 'compare', id: firstRun.outputs.baseline.id });
    check('a new session cannot reuse another document baseline handle', reuse.isError, reuse.text);
    const secondRun = JSON.parse((await tool('browser_routine_run', { domain: '127.0.0.1', name: routine.name }, second)).text);
    check('saved diagnostic Routine works in a new session with fresh handles',
      secondRun.outputs.baseline.id !== firstRun.outputs.baseline.id && secondRun.outputs.restored.unchanged === true, JSON.stringify(secondRun));
    await tool('browser_tabs', { action: 'close' }, second);
  } finally {
    second.close();
  }

  const ttlPatch = await structured('browser_patch', {
    action: 'apply', ttlMs: 1000, changes: [{ target: { locator: target }, styles: { color: 'rgb(90, 80, 70)' } }],
  });
  const ttlDuring = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('short-lived patch really applies before expiry', ttlDuring.properties.color === 'rgb(90, 80, 70)', JSON.stringify(ttlPatch));
  const deadline = Date.now() + 5000;
  let expiredStyle;
  do {
    await sleep(100);
    expiredStyle = await structured('browser_styles', { locator: target, properties: ['color'] });
  } while (expiredStyle.properties.color !== 'rgb(20, 30, 40)' && Date.now() < deadline);
  check('TTL expiry rolls back actual Firefox/Chromium DOM styles',
    expiredStyle.properties.color === 'rgb(20, 30, 40)' && (await structured('browser_patch')).patches.length === 0);

  const commitPatch = await structured('browser_patch', {
    action: 'apply', changes: [{ target: { locator: target }, styles: { color: 'rgb(70, 80, 90)' } }],
  });
  const committed = await structured('browser_patch', { action: 'commit', id: commitPatch.id });
  const committedStyle = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('commit keeps live DOM and removes rollback history without changing source',
    committed.sourceChanged === false && committedStyle.properties.color === 'rgb(70, 80, 90)' &&
    (await structured('browser_patch')).patches.length === 0, JSON.stringify(committed));
  await tool('browser_navigate', { url: `${base}/debug.html` });
  const sourceStyle = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('committed live patch does not survive source reload', sourceStyle.properties.color === 'rgb(20, 30, 40)');

  const staleBaseline = await structured('browser_dom_baseline', { locator: target });
  const conflictPatch = await structured('browser_patch', {
    action: 'apply', changes: [{ target: { locator: target }, styles: { color: 'rgb(0, 128, 0)' } }],
  });
  await tool('browser_click', { locator: locator('#app-change') });
  await tool('browser_wait_for', { text: 'App changed the color', timeoutSeconds: 5 });
  const conflict = await client.call('browser_patch', { browser: instance, action: 'rollback', id: conflictPatch.id });
  const appStyle = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('rollback conflict does not overwrite an application change', conflict.isError && appStyle.properties.color === 'rgb(11, 22, 33)', conflict.text);
  await tool('browser_navigate', { url: `${base}/debug.html` });
  const stale = await client.call('browser_dom_baseline', { browser: instance, action: 'compare', id: staleBaseline.id });
  const fresh = await structured('browser_styles', { locator: target, properties: ['color'] });
  check('same-URL navigation invalidates document handles without replay', stale.isError && fresh.documentId !== staleBaseline.documentId && fresh.properties.color === 'rgb(20, 30, 40)', stale.text);

  const noCapture = await client.call('browser_har', { browser: instance });
  check('HAR refuses to invent an unarmed capture', noCapture.isError && noCapture.text.includes('capture_required'), noCapture.text);
  await tool('browser_network', { action: 'start', urlInclude: '/debug-api', maxEntries: 10 });
  await tool('browser_click', { locator: locator('#request') });
  await tool('browser_wait_for', { text: '200: Original response', timeoutSeconds: 5 });
  const har = await structured('browser_har');
  const exchange = har.log.entries.find((entry) => entry.request.url === `${base}/debug-api`);
  check('HAR exports observed real HTTP metadata and strips private payloads',
    har.log.version === '1.2' && exchange?.request.method === 'POST' && exchange.response.status === 200 &&
    exchange._durationObserved && exchange.request.headers.length === 0 && exchange.response.cookies.length === 0 &&
    !JSON.stringify(har).includes('fixture-private-value'), JSON.stringify(har));
  await tool('browser_network', { action: 'stop' });
  const performance = await structured('browser_performance', { includeResources: true, maxEntries: 100 });
  check('performance evidence contains actual navigation and sanitized resource entries',
    performance.source === 'browser-performance-api' && performance.navigation !== null &&
    performance.resources.some((entry) => entry.url === `${base}/debug-api`) &&
    !JSON.stringify(performance).includes('fixture-private-value'), JSON.stringify(performance));

  if (kind === 'firefox') {
    const debuggerResult = await client.call('browser_debugger', { browser: instance });
    const interceptResult = await client.call('browser_intercept', { browser: instance, action: 'set', rules: [{ urlPattern: `${base}/debug-api*`, action: 'block' }] });
    check('Firefox rejects Chromium-only debugger features explicitly', debuggerResult.isError && interceptResult.isError &&
      debuggerResult.text.includes('unsupported') && interceptResult.text.includes('unsupported'), `${debuggerResult.text}\n${interceptResult.text}`);
  } else {
    const metrics = await structured('browser_debugger');
    check('Chromium debugger returns actual node counters', metrics.metrics.some((entry) => entry.name === 'Nodes' && entry.value > 0), JSON.stringify(metrics));
    await structured('browser_intercept', { action: 'set', rules: [{ urlPattern: `${base}/debug-api*`, action: 'fulfill', status: 202, body: '{"message":"Mock response"}' }] });
    await tool('browser_click', { locator: locator('#request') });
    await tool('browser_wait_for', { text: '202: Mock response', timeoutSeconds: 5 });
    const mocked = await structured('browser_intercept');
    check('request mock changes the response accepted by the application', mocked.handledRequests >= 1 && mocked.rules[0].body === undefined, JSON.stringify(mocked));
    await structured('browser_intercept', { action: 'clear' });
    await tool('browser_click', { locator: locator('#request') });
    await tool('browser_wait_for', { text: '200: Original response', timeoutSeconds: 5 });
    check('clearing request mocks restores the server response', true);
    await structured('browser_intercept', { action: 'set', rules: [{ urlPattern: `${base}/debug-api*`, action: 'block' }] });
    await tool('browser_click', { locator: locator('#request') });
    await tool('browser_wait_for', { text: 'Request failed:', timeoutSeconds: 5 });
    const blocked = await structured('browser_intercept');
    check('request block produces an observed application failure', blocked.handledRequests >= 1, JSON.stringify(blocked));
    await structured('browser_intercept', { action: 'clear' });
  }
}
