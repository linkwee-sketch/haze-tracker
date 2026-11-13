(() => {
  'use strict';

  const { REGIONS, METRICS, band, bands, cap, formatTime } = Haze;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5 * 60 * 1000;
  const DEFAULTS = { enabled: false, metric: 'psi24', region: 'any', threshold: 100 };

  let refreshing = false;
  let lastFetch = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function pill(metric, value) {
    const b = band(metric, value);
    const p = el('span', 'pill', b.label);
    p.style.background = b.color;
    return p;
  }

  // ---------- rendering ----------

  function render(data, cached) {
    const grid = $('regions');
    grid.replaceChildren();

    for (const r of REGIONS) {
      const psi = data.psi ? data.psi[r] : null;
      const pm = data.pm25 ? data.pm25[r] : null;

      const card = el('article', 'region');
      card.append(el('h3', '', cap(r)));

      const row = el('div', 'psi');
      row.append(el('span', 'num', psi == null ? '–' : String(psi)), el('span', 'unit', '24-hr PSI'));
      card.append(row, pill('psi24', psi));

      const pmBox = el('div', 'pm');
      const line = el('span');
      line.append('1-hr PM2.5: ', el('strong', '', pm == null ? '–' : String(pm)), pm == null ? '' : ' µg/m³');
      pmBox.append(line, pill('pm25_1h', pm));
      card.append(pmBox);

      card.setAttribute('aria-label',
        cap(r) + ': 24-hour PSI ' + (psi == null ? 'unavailable' : psi + ', ' + band('psi24', psi).label) +
        '; 1-hour PM2.5 ' + (pm == null ? 'unavailable' : pm + ', ' + band('pm25_1h', pm).label));
      grid.append(card);
    }

    // Overall = highest regional 24-hr PSI (how NEA reports the national PSI).
    const overall = $('overall');
    const top = Haze.reading(data, 'psi24', 'any');
    if (top.value != null) {
      overall.replaceChildren();
      const left = el('div');
      left.append(el('div', 'label', 'Overall 24-hr PSI (highest region: ' + cap(top.region) + ')'), el('div', 'num', String(top.value)));
      overall.append(left, pill('psi24', top.value));
      overall.hidden = false;
    } else {
      overall.hidden = true;
    }

    const parts = [];
    if (data.psiTimestamp) parts.push('PSI as of ' + formatTime(data.psiTimestamp));
    if (data.pm25Timestamp) parts.push('PM2.5 as of ' + formatTime(data.pm25Timestamp));
    let msg = parts.join(' · ') + ' (SGT)';
    if (cached) msg = 'Offline: showing saved readings. ' + msg;
    if (data.errors && data.errors.length) msg += ' · Partial data: ' + data.errors.join('; ');
    setStatus(msg, !!cached || (data.errors && data.errors.length > 0));
  }

  function setStatus(text, isError) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
  }

  // ---------- refresh ----------

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    $('refresh').classList.add('spin');
    try {
      const data = await Haze.fetchLatest();
      lastFetch = Date.now();
      await Haze.setKV('lastData', data).catch(() => {});
      render(data, false);
      await Haze.checkAndNotify(data).catch((e) => console.warn('Alert check failed', e));
    } catch (err) {
      const cached = await Haze.getKV('lastData').catch(() => null);
      if (cached) render(cached, true);
      else setStatus('Could not load readings (' + err.message + '). Check your connection and tap ↻.', true);
    } finally {
      refreshing = false;
      $('refresh').classList.remove('spin');
    }
  }

  // ---------- alert settings ----------

  function readForm() {
    return {
      enabled: $('enabled').checked,
      metric: $('metric').value,
      region: $('region').value,
      threshold: Math.round(Number($('threshold').value)),
    };
  }

  function writeForm(s) {
    $('enabled').checked = !!s.enabled;
    $('metric').value = s.metric;
    $('region').value = s.region;
    $('threshold').value = s.threshold;
    updateHint();
  }

  function updateHint() {
    const m = $('metric').value;
    const list = bands(m).map((b) => b.label + ' ' + b.range).join(' · ');
    $('bands-hint').textContent = 'NEA bands: ' + list;
  }

  function formMsg(text) { $('form-msg').textContent = text; }

  async function ensurePermission() {
    if (!('Notification' in window)) {
      formMsg('This browser does not support notifications here. On iPhone/iPad, add the app to your Home Screen first (iOS 16.4+).');
      return false;
    }
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') {
      formMsg('Notifications are blocked. Allow them for this site in your browser or phone settings, then try again.');
      return false;
    }
    return true;
  }

  async function syncBackground(enabled) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return false;
      if (!enabled) { await reg.periodicSync.unregister('haze-check'); return false; }
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perm.state !== 'granted') return false;
      await reg.periodicSync.register('haze-check', { minInterval: 15 * 60 * 1000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const s = readForm();
    if (!Number.isFinite(s.threshold) || s.threshold < 1) {
      formMsg('Enter a threshold of 1 or more.');
      $('threshold').focus();
      return;
    }
    if (s.enabled && !(await ensurePermission())) {
      s.enabled = false;
      $('enabled').checked = false;
    }
    await Haze.setKV('settings', s);
    await Haze.setKV('alertState', null); // new rule: evaluate from scratch
    if (!s.enabled) {
      await syncBackground(false);
      if (typeof Notification === 'undefined' || Notification.permission !== 'denied') formMsg('Saved. Alerts are off.');
      return;
    }
    const bg = await syncBackground(true);
    formMsg('Saved. You will be notified when ' + METRICS[s.metric].label + ' in ' +
      (s.region === 'any' ? 'any region' : 'the ' + cap(s.region)) + ' reaches ' + s.threshold + '.' +
      (bg ? ' Background checks are on.' : ' Keep the app open for checks (see "How alerts work").'));
    refresh();
  }

  async function onTest() {
    if (!(await ensurePermission())) return;
    try {
      await Haze.notify('Haze Tracker test', { body: 'Notifications are working.', tag: 'haze-test' });
      formMsg('Test notification sent.');
    } catch (e) {
      formMsg('Could not show a notification: ' + e.message);
    }
  }

  // ---------- install ----------

  let deferredPrompt = null;

  function setupInstall() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) return;
    const box = $('install');
    const text = $('install-text');
    const btn = $('install-btn');
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (ios) {
      text.textContent = 'In Safari, tap the Share button, then "Add to Home Screen". Notifications on iPhone need iOS 16.4 or later and the installed app.';
      box.hidden = false;
    }
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      deferredPrompt = ev;
      text.textContent = 'Install Haze Tracker to open it from your home screen like an app.';
      btn.hidden = false;
      box.hidden = false;
    });
    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      box.hidden = true;
    });
    window.addEventListener('appinstalled', () => { box.hidden = true; });
  }

  // ---------- start ----------

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    }

    $('refresh').addEventListener('click', refresh);
    $('alert-form').addEventListener('submit', onSubmit);
    $('test-notif').addEventListener('click', onTest);
    $('metric').addEventListener('change', () => {
      const t = $('threshold');
      const other = Object.values(METRICS).map((m) => String(m.defaultThreshold));
      if (other.includes(t.value)) t.value = METRICS[$('metric').value].defaultThreshold; // untouched default
      updateHint();
    });

    const saved = await Haze.getKV('settings').catch(() => null);
    writeForm(Object.assign({}, DEFAULTS, saved));

    const cached = await Haze.getKV('lastData').catch(() => null);
    if (cached) render(cached, false);

    setupInstall();
    refresh();

    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastFetch > 2 * 60 * 1000) refresh();
    });
  }

  init();
})();
