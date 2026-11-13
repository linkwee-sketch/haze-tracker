# Haze Tracker SG

An installable web app (PWA) that shows Singapore's haze readings by region and can notify you when they reach a level you choose. It is plain HTML/CSS/JS with no build step and no backend.

## What it shows

Data comes from NEA's real-time datasets on [data.gov.sg](https://data.gov.sg):

| Shown in the app | API field | Endpoint |
|---|---|---|
| 24-hr PSI per region | `psi_twenty_four_hourly` | `/v2/real-time/api/psi` |
| 1-hr PM2.5 (µg/m³) per region | `pm25_one_hourly` | `/v2/real-time/api/pm25` |

NEA does not publish a "1-hour PSI". The hourly figure it publishes is PM2.5, so that is what the app labels as 1-hr. Regions are north, west, central, east and south.

## Alerts

Pick a measure (24-hr PSI or 1-hr PM2.5), a region (or "any region"), and a threshold. You get one notification when the reading reaches the threshold, and another only after it has dropped back below and crossed again. Saving a new rule re-evaluates it straight away, so if the level is already at or above your threshold you are told once.

Because there is no server, alerts only run where the browser can run code:

- **App open (all browsers):** checked every 5 minutes and when you return to the app.
- **App closed, Chrome on Android with the app installed:** the browser may run periodic background checks. Chrome decides when, usually hours apart for a rarely used app.
- **iPhone/iPad:** no background checks. Notifications need iOS 16.4+ and the app added to the Home Screen.

Reliable alerts while the app is closed would need a small server that polls NEA and sends Web Push messages.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/haze.test.js
```

Service workers and notifications need HTTPS or `localhost`.

## Install on a phone

Host the folder over HTTPS (for example GitHub Pages: Settings → Pages → deploy from the `main` branch, root). Then:

- **Android/Chrome:** open the site, tap **Install app** in the page or Menu → Add to Home screen.
- **iPhone/Safari:** Share → Add to Home Screen.

## Files

- `index.html`, `styles.css`, `app.js`: the interface
- `haze.js`: fetching, bands, alert logic and storage, shared by the page and the service worker
- `sw.js`: offline app shell, background checks, notification clicks
- `manifest.webmanifest`, `icons/`: install metadata and the app icon (SVG sources plus PNGs)
- `tests/haze.test.js`: unit tests for parsing and alert logic

Contains information from the Real-time PSI and PM2.5 datasets accessed via the data.gov.sg API, made available under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence).
