/*
 * Haze Tracker core logic. Loaded by the page (<script>) and by the service
 * worker (importScripts), so it must not touch the DOM.
 *
 * Data source: NEA real-time datasets on data.gov.sg
 *   - PSI  -> readings.psi_twenty_four_hourly   (24-hour PSI per region)
 *   - PM2.5 -> readings.pm25_one_hourly         (1-hour PM2.5, ug/m3 per region)
 * NEA does not publish a "1-hour PSI"; the 1-hour figure it publishes is PM2.5.
 */
(function (root) {
  'use strict';

  const PSI_URL = 'https://api-open.data.gov.sg/v2/real-time/api/psi';
  const PM25_URL = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';
  const REGIONS = ['north', 'west', 'central', 'east', 'south'];

  const METRICS = {
    psi24: { id: 'psi24', label: '24-hr PSI', short: 'PSI', unit: '', defaultThreshold: 100 },
    pm25_1h: { id: 'pm25_1h', label: '1-hr PM2.5', short: 'PM2.5', unit: ' µg/m³', defaultThreshold: 56 },
  };

  // Band colours are dark enough for white text (WCAG AA).
  const PSI_BANDS = [
    { max: 50, label: 'Good', color: '#1f7a46', range: '0–50' },
    { max: 100, label: 'Moderate', color: '#1f64b5', range: '51–100' },
    { max: 200, label: 'Unhealthy', color: '#a85f00', range: '101–200' },
    { max: 300, label: 'Very unhealthy', color: '#c22f23', range: '201–300' },
    { max: Infinity, label: 'Hazardous', color: '#7a1733', range: '301+' },
  ];
  const PM25_BANDS = [
    { max: 55, label: 'Normal', color: '#1f7a46', range: '0–55' },
    { max: 150, label: 'Elevated', color: '#a85f00', range: '56–150' },
    { max: 250, label: 'High', color: '#c22f23', range: '151–250' },
    { max: Infinity, label: 'Very high', color: '#7a1733', range: '251+' },
  ];

  function bands(metric) {
    return metric === 'pm25_1h' ? PM25_BANDS : PSI_BANDS;
  }

  function band(metric, value) {
    if (value == null || Number.isNaN(Number(value))) {
      return { label: 'No data', color: '#4a5568', range: '' };
    }
    return bands(metric).find((b) => value <= b.max);
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  function formatTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // ---------- fetching ----------

  async function getJson(url, fetchImpl) {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json && json.code !== undefined && json.code !== 0) {
      throw new Error(json.errorMsg || 'API error ' + json.code);
    }
    return json;
  }

  function latestItem(json) {
    const items = json && json.data && json.data.items;
    if (!items || !items.length) throw new Error('No readings in response');
    return items.reduce((a, b) => (new Date(b.timestamp) > new Date(a.timestamp) ? b : a));
  }

  async function loadMetric(url, key, fetchImpl) {
    const item = latestItem(await getJson(url, fetchImpl));
    const values = item.readings && item.readings[key];
    if (!values) throw new Error('Missing ' + key);
    return { values, timestamp: item.timestamp };
  }

  /** Fetch both datasets. Succeeds if at least one of them works. */
  async function fetchLatest(fetchImpl) {
    const f = fetchImpl || ((u, o) => root.fetch(u, o));
    const [psi, pm] = await Promise.allSettled([
      loadMetric(PSI_URL, 'psi_twenty_four_hourly', f),
      loadMetric(PM25_URL, 'pm25_one_hourly', f),
    ]);
    const out = {
      psi: null,
      psiTimestamp: null,
      pm25: null,
      pm25Timestamp: null,
      fetchedAt: Date.now(),
      errors: [],
    };
    if (psi.status === 'fulfilled') {
      out.psi = psi.value.values;
      out.psiTimestamp = psi.value.timestamp;
    } else {
      out.errors.push('PSI: ' + psi.reason.message);
    }
    if (pm.status === 'fulfilled') {
      out.pm25 = pm.value.values;
      out.pm25Timestamp = pm.value.timestamp;
    } else {
      out.errors.push('PM2.5: ' + pm.reason.message);
    }
    if (!out.psi && !out.pm25) throw new Error(out.errors.join('; ') || 'No data');
    return out;
  }

  // ---------- alert logic (pure, unit-tested) ----------

  /** Value and region for the user's chosen metric/region. 'any' = highest region. */
  function reading(data, metric, region) {
    const src = data && (metric === 'pm25_1h' ? data.pm25 : data.psi);
    if (!src) return { value: null, region: region };
    if (region === 'any') {
      let best = null;
      for (const r of REGIONS) {
        const v = Number(src[r]);
        if (Number.isFinite(v) && (best === null || v > best.value)) best = { value: v, region: r };
      }
      return best || { value: null, region: region };
    }
    const v = Number(src[region]);
    return { value: Number.isFinite(v) ? v : null, region: region };
  }

  /**
   * Decide whether to notify. Fires once when the value reaches the threshold
   * and re-arms after it drops back below, so users aren't re-alerted every poll.
   */
  function evaluate(settings, data, prev, now) {
    const r = reading(data, settings.metric, settings.region);
    const key = [settings.metric, settings.region, settings.threshold].join('|');
    const sameConfig = !!prev && prev.key === key;
    const wasAbove = sameConfig && !!prev.above;
    const above = r.value == null ? wasAbove : r.value >= settings.threshold;
    return {
      value: r.value,
      region: r.region,
      above,
      shouldNotify: r.value != null && above && !wasAbove,
      state: { key, above, value: r.value, at: now || Date.now() },
    };
  }

  function describeAlert(settings, result, data) {
    const m = METRICS[settings.metric];
    const b = band(settings.metric, result.value);
    const ts = settings.metric === 'pm25_1h' ? data.pm25Timestamp : data.psiTimestamp;
    return {
      title: 'Haze alert: ' + m.short + ' ' + result.value + m.unit + ' in the ' + cap(result.region),
      body:
        m.label + ' is ' + result.value + m.unit + ' (' + b.label + '), at or above your threshold of ' +
        settings.threshold + '. Updated ' + formatTime(ts) + '.',
    };
  }

  // ---------- storage (IndexedDB so the service worker can read it too) ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = root.indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getKV(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function setKV(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- notifications ----------

  async function notify(title, options) {
    const opts = Object.assign(
      { icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'haze-alert', renotify: true },
      options
    );
    const reg = root.registration || (await root.navigator.serviceWorker.ready);
    return reg.showNotification(title, opts);
  }

  /** Fetch (or reuse) data, evaluate the saved alert, and notify if it just crossed. */
  async function checkAndNotify(preloaded) {
    const settings = await getKV('settings');
    if (!settings || !settings.enabled) return { skipped: 'disabled' };
    const data = preloaded || (await fetchLatest());
    await setKV('lastData', data);
    const prev = await getKV('alertState');
    const res = evaluate(settings, data, prev);
    await setKV('alertState', res.state);
    if (!res.shouldNotify) return Object.assign({ notified: false }, res);
    if (typeof root.Notification === 'undefined' || root.Notification.permission !== 'granted') {
      return Object.assign({ notified: false, skipped: 'no-permission' }, res);
    }
    const msg = describeAlert(settings, res, data);
    await notify(msg.title, { body: msg.body, data: { url: './' } });
    return Object.assign({ notified: true }, res);
  }

  const Haze = {
    PSI_URL, PM25_URL, REGIONS, METRICS, bands, band, cap, formatTime,
    fetchLatest, reading, evaluate, describeAlert,
    getKV, setKV, notify, checkAndNotify,
  };

  root.Haze = Haze;
  if (typeof module !== 'undefined' && module.exports) module.exports = Haze;
})(typeof self !== 'undefined' ? self : globalThis);
