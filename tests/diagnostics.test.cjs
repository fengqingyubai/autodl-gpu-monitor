const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticLogger, encodeDiagnosticExport, clean, KEY, bytes, MAX_BYTES } = require('../diagnostics.js');
function storage() {
  const data = { cloneMonitorJob: { phase: 'submitting', attemptId: 'keep-lock' } };
  return { data, get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)) };
}
test('UTF-8 byte limit evicts oldest records and keeps newest error across restart', async () => {
  const store = storage();
  const log = createDiagnosticLogger(store, '1.1.4', 4096);
  await Promise.all(Array.from({ length: 50 }, (_, round) => log.append('round', { round, message: '中文'.repeat(200) })));
  await log.append('page.error', { message: '最新错误', hourlyQuote: 2.19, maxPrice: 3 }, 'error');
  assert.ok(bytes({ [KEY]: store.data[KEY] }) <= 4096);
  const result = await createDiagnosticLogger(store, '1.1.4', 4096).read();
  assert.ok(result.dropped > 0);
  assert.equal(result.entries.at(-1).details.message, '最新错误');
  assert.equal(result.entries.at(-1).details.hourlyQuote, 2.19);
  assert.equal(result.entries.at(-1).version, '1.1.4');
  assert.equal(store.data.cloneMonitorJob.attemptId, 'keep-lock');
});
test('allowlist drops credential settings and redacts credential-like text', () => {
  const output = JSON.stringify(clean({ token: 'secretToken', password: 'secretPassword', cookies: ['cookie-secret'],
    serverChanSendKey: 'SCTnotification', emailjsPublicKey: 'notificationKey',
    message: 'token=abc123 password:"xyz789" contact me@example.com https://test.example/?token=qwer Bearer bearer123',
    models: ['RTX 4090'], hourlyQuote: 2.19, maxPrice: 3 }));
  for (const secret of ['secretToken', 'secretPassword', 'cookie-secret', 'SCTnotification', 'notificationKey', 'abc123', 'xyz789', 'me@example.com', 'qwer', 'bearer123']) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.ok(output.includes('RTX 4090'));
  assert.ok(output.includes('2.19'));
});
test('export is valid JSONL, includes provenance and stays under its byte budget', async () => {
  const store = storage();
  const logger = createDiagnosticLogger(store, '1.1.4', 4096);
  for (let i = 0; i < 40; i++) await logger.append('price.check', { round: i, message: '检查'.repeat(50), pageVersion: '1.1.2', hourlyQuote: 2.19 });
  const output = encodeDiagnosticExport({ log: await logger.read(), extensionVersion: '1.1.4',
    exportedAt: new Date().toISOString(), currentJob: { phase: 'error', message: '上一任务错误' } }, 4096);
  assert.ok(new TextEncoder().encode(output).length <= 4096);
  const rows = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].extensionVersion, '1.1.4');
  assert.equal(rows[0].currentJob.phase, 'error');
  assert.equal(rows.at(-1).details.pageVersion, '1.1.2');
  assert.equal(MAX_BYTES, 512 * 1024);
});
test('clear only removes diagnostics and never changes a pending submission', async () => {
  const store = storage();
  const log = createDiagnosticLogger(store, '1.1.4');
  await log.append('event', { message: 'test' });
  await log.clear();
  assert.equal((await log.read()).entries.length, 0);
  assert.equal(store.data.cloneMonitorJob.attemptId, 'keep-lock');
});
