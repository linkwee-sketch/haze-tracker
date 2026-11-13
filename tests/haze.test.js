// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Haze = require('../haze.js');

const psiBody = (vals, ts = '2026-11-12T21:00:00+08:00') => ({
  code: 0,
  data: {
    regionMetadata: [],
    items: [{ timestamp: ts, readings: { psi_twenty_four_hourly: vals } }],
  },
  errorMsg: '',
});
const pmBody = (vals, ts = '2026-11-13T00:00:00+08:00') => ({
  code: 0,
  data: { regionMetadata: [], items: [{ timestamp: ts, readings: { pm25_one_hourly: vals } }] },
  errorMsg: '',
});

const fakeFetch = (map) => async (url) => {
  const r = map[url];
  if (r instanceof Error) throw r;
  return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
};

const PSI = { north: 61, south: 59, west: 62, east: 57, central: 62 };
const PM = { north: 28, south: 17, west: 28, east: 18, central: 20 };

test('bands match NEA thresholds', () => {
  assert.equal(Haze.band('psi24', 50).label, 'Good');
  assert.equal(Haze.band('psi24', 51).label, 'Moderate');
  assert.equal(Haze.band('psi24', 100).label, 'Moderate');
  assert.equal(Haze.band('psi24', 101).label, 'Unhealthy');
  assert.equal(Haze.band('psi24', 201).label, 'Very unhealthy');
  assert.equal(Haze.band('psi24', 301).label, 'Hazardous');
  assert.equal(Haze.band('pm25_1h', 55).label, 'Normal');
  assert.equal(Haze.band('pm25_1h', 56).label, 'Elevated');
  assert.equal(Haze.band('pm25_1h', 151).label, 'High');
  assert.equal(Haze.band('pm25_1h', 251).label, 'Very high');
  assert.equal(Haze.band('psi24', null).label, 'No data');
});

test('fetchLatest combines both datasets', async () => {
  const f = fakeFetch({
    [Haze.PSI_URL]: { body: psiBody(PSI) },
    [Haze.PM25_URL]: { body: pmBody(PM) },
  });
  const d = await Haze.fetchLatest(f);
  assert.deepEqual(d.psi, PSI);
  assert.deepEqual(d.pm25, PM);
  assert.equal(d.psiTimestamp, '2026-11-12T21:00:00+08:00');
  assert.deepEqual(d.errors, []);
});

test('fetchLatest picks the newest item', async () => {
  const body = psiBody(PSI);
  body.data.items.unshift({ timestamp: '2026-11-12T20:00:00+08:00', readings: { psi_twenty_four_hourly: { north: 1, south: 1, west: 1, east: 1, central: 1 } } });
  const f = fakeFetch({ [Haze.PSI_URL]: { body }, [Haze.PM25_URL]: { body: pmBody(PM) } });
  assert.deepEqual((await Haze.fetchLatest(f)).psi, PSI);
});

test('fetchLatest tolerates one failing dataset', async () => {
  const f = fakeFetch({ [Haze.PSI_URL]: { ok: false, status: 503, body: {} }, [Haze.PM25_URL]: { body: pmBody(PM) } });
  const d = await Haze.fetchLatest(f);
  assert.equal(d.psi, null);
  assert.deepEqual(d.pm25, PM);
  assert.match(d.errors[0], /PSI: HTTP 503/);
});

test('fetchLatest throws when both fail', async () => {
  const f = fakeFetch({ [Haze.PSI_URL]: new Error('offline'), [Haze.PM25_URL]: new Error('offline') });
  await assert.rejects(() => Haze.fetchLatest(f), /offline/);
});

test('fetchLatest rejects API-level errors', async () => {
  const f = fakeFetch({
    [Haze.PSI_URL]: { body: { code: 5, errorMsg: 'bad' } },
    [Haze.PM25_URL]: { body: { code: 5, errorMsg: 'bad' } },
  });
  await assert.rejects(() => Haze.fetchLatest(f), /bad/);
});

test('reading: specific region and any-region max', () => {
  const data = { psi: PSI, pm25: PM };
  assert.deepEqual(Haze.reading(data, 'psi24', 'east'), { value: 57, region: 'east' });
  const top = Haze.reading(data, 'psi24', 'any');
  assert.equal(top.value, 62);
  assert.ok(['west', 'central'].includes(top.region));
  assert.deepEqual(Haze.reading(data, 'pm25_1h', 'any'), { value: 28, region: 'north' });
  assert.equal(Haze.reading({ psi: null, pm25: PM }, 'psi24', 'north').value, null);
});

test('evaluate: notifies once on crossing, re-arms after dropping', () => {
  const s = { enabled: true, metric: 'psi24', region: 'west', threshold: 60 };
  const below = { psi: { ...PSI, west: 55 }, pm25: PM };
  const above = { psi: { ...PSI, west: 62 }, pm25: PM };

  let r = Haze.evaluate(s, below, null);
  assert.equal(r.shouldNotify, false);

  r = Haze.evaluate(s, above, r.state);
  assert.equal(r.shouldNotify, true, 'crossing up notifies');

  r = Haze.evaluate(s, above, r.state);
  assert.equal(r.shouldNotify, false, 'staying above does not repeat');

  r = Haze.evaluate(s, below, r.state);
  assert.equal(r.shouldNotify, false);
  assert.equal(r.above, false);

  r = Haze.evaluate(s, above, r.state);
  assert.equal(r.shouldNotify, true, 're-arms after dropping below');
});

test('evaluate: threshold is inclusive', () => {
  const s = { metric: 'psi24', region: 'west', threshold: 62 };
  assert.equal(Haze.evaluate(s, { psi: PSI }, null).shouldNotify, true);
});

test('evaluate: changing the rule resets state', () => {
  const data = { psi: PSI, pm25: PM };
  const a = Haze.evaluate({ metric: 'psi24', region: 'west', threshold: 60 }, data, null);
  assert.equal(a.shouldNotify, true);
  const b = Haze.evaluate({ metric: 'psi24', region: 'west', threshold: 61 }, data, a.state);
  assert.equal(b.shouldNotify, true, 'new threshold evaluates fresh');
});

test('evaluate: missing data keeps the previous state', () => {
  const s = { metric: 'psi24', region: 'west', threshold: 60 };
  const r1 = Haze.evaluate(s, { psi: PSI }, null);
  const r2 = Haze.evaluate(s, { psi: null, pm25: PM }, r1.state);
  assert.equal(r2.shouldNotify, false);
  assert.equal(r2.above, true);
  const r3 = Haze.evaluate(s, { psi: PSI }, r2.state);
  assert.equal(r3.shouldNotify, false, 'no duplicate alert after a data gap');
});

test('describeAlert wording', () => {
  const s = { metric: 'psi24', region: 'any', threshold: 100 };
  const data = { psi: { ...PSI, north: 112 }, psiTimestamp: '2026-11-12T21:00:00+08:00' };
  const res = Haze.evaluate(s, data, null);
  const msg = Haze.describeAlert(s, res, data);
  assert.equal(msg.title, 'Haze alert: PSI 112 in the North');
  assert.match(msg.body, /24-hr PSI is 112 \(Unhealthy\)/);
  assert.match(msg.body, /threshold of 100/);
});
