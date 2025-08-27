import { Dropbox } from "dropbox";
import fs from "fs/promises";
import fetch from "node-fetch";

// ---------- ENV ----------
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_SHARED_URL = process.env.DROPBOX_SHARED_URL;
const ENABLE_NOMINATIN = process.env.ENABLE_NOMINATIM === "1";

if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!DROPBOX_SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

// ---------- Dropbox SDK ----------
const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

// ---------- Helpers ----------
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name = "") {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some(ext => n.endsWith(ext));
}
const norm = s => (s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, ""); // strip diacritics

// ---------- Mini Romania gazetteer (extend anytime) ----------
// Stored as [lon, lat]. Keys are normalized (lowercase, no diacritics).
const GAZ = {
  "breb": [23.9049, 47.7485],
  "barsana": [24.0425, 47.7367],
  "brateiu": [24.3826, 46.1491],
  "bethlen cris": [24.6710, 46.1932],
  "cris": [24.6710, 46.1932],
  "bistrita": [24.5, 47.133],
  "bnr": [26.0986, 44.4305], // BNR Bucharest approx
  "ateneu": [26.0980, 44.4412], // Romanian Athenaeum
  "cheile bicazului": [25.8241, 46.8121],
  "bicaz": [26.0901, 46.9133], // lake/dam
  "bigar": [22.3514, 45.0039],
  "praid": [25.1358, 46.5534],
  "sasca": [21.7577, 44.8803], // Nera gorge near Sasca Montană
  "sucevita": [25.7206, 47.7814],
  "sapanta": [23.6932, 47.9682],
  "viscri": [25.0918, 46.0558],
  "tihuta": [24.8058, 47.3147], // Pasul Tihuța
  "bazias": [21.4300, 44.7840],
  "vodita": [22.4160, 44.6730],
  "zimbri hateg": [22.9538, 45.6117], // Rezervatia de zimbri Hateg
  "vanatori neamt": [26.2340, 47.2190],
  "lazarea": [25.5169, 46.7770],
  "en isala": [28.8382, 44.8864], // Enisala; accept split in names
  "enisala": [28.8382, 44.8864],
  "feldioara": [25.5862, 45.8282],
  "poienile izei": [24.1160, 47.6940],
  "maramures": [23.9, 47.7], // broad; prefer specific villages if present
  "oravita": [21.6911, 45.0391],
  "anina": [21.8583, 45.0839],
  "capidava": [28.0800, 44.5100],
  "cernavoda": [28.0333, 44.3333],
  "harsova": [27.9533, 44.6833],
  "rasova": [27.9344, 44.2458],
  "seimeni": [28.0713, 44.3932],
  "izvoarele": [28.1650, 44.3920], // Constanța county
  "topalu": [28.0110, 44.5310],
  "ghindaresti": [28.0160, 44.3240],
  "ogra": [24.2890, 46.4640],
  "haller": [24.2890, 46.4640], // Castel Haller, Ogra
  "dupus": [24.2164, 46.2178] // Dupuș (Sibiu)
};

// Prefer the *longest* matching key so "cheile bicazului" beats "bicaz".
function guessFromFilename(name = "") {
  const text = norm(name);
  const candidates = Object.keys(GAZ)
    .filter(k => text.includes(k))
    .sort((a, b) => b.length - a.length);
  return candidates.length ? GAZ[candidates[0]] : null;
}

async function geocodeNominatim(q) {
  if (!ENABLE_NOMINATIN) return null;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": "RealRomania-PhotoLocations/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data) && data.length) {
    return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
  }
  return null;
}

async function listAll(sharedUrl) {
  const shared_link = { url: sharedUrl };
  const files = [];
  const queue = [""];

  while (queue.length) {
    const folder = queue.shift();
    let res = await dbx.filesListFolder({
      path: folder,
      shared_link,
      include_media_info: true
    });
    let data = res.result;

    for (const e of data.entries) {
      if (e[".tag"] === "folder") queue.push(e.path_lower);
      else if (e[".tag"] === "file" && isImage(e.name)) files.push(e);
    }

    while (data.has_more) {
      const more = await dbx.filesListFolderContinue({ cursor: data.cursor });
      const md = more.result;
      for (const e of md.entries) {
        if (e[".tag"] === "folder") queue.push(e.path_lower);
        else if (e[".tag"] === "file" && isImage(e.name)) files.push(e);
      }
      data = md;
    }
  }
  return files;
}

function htmlTemplate({ dataUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Photo Map • Proof</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  .popup { width: 280px; }
  .title { font: 600 14px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin-top: 6px; }
  .meta { opacity:.7; font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .leaflet-container { background: #f5f7f9; }
</style>
</head>
<body>
<div id="map"></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
const map = L.map('map', { preferCanvas:true }).setView([45.94, 25.00], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, attribution: '&copy; OpenStreetMap'
}).addTo(map);
const clusters = L.markerClusterGroup({ disableClusteringAtZoom: 12 });

fetch('${dataUrl}?ts=' + Date.now())
  .then(r => r.json())
  .then(geo => {
    const markers = L.geoJSON(geo, {
      pointToLayer: (feat, latlng) => L.marker(latlng),
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const html = '<div class="popup">'
          + '<div class="title">' + (p.title || '') + '</div>'
          + (p.taken_at ? '<div class="meta">' + p.taken_at + '</div>' : '')
          + (p.source ? '<div class="meta">source: ' + p.source + '</div>' : '')
          + '</div>';
        layer.bindPopup(html, { maxWidth: 320 });
      }
    });
    clusters.addLayer(markers);
    map.addLayer(clusters);
    try { const b = markers.getBounds(); if (b.isValid()) map.fitBounds(b.pad(0.15)); } catch(e){}
  })
  .catch(err => console.error('Failed to load locations.json', err));
</script>
</body>
</html>`;
}

(async () => {
  console.log("Listing Dropbox shared folder…");
  const entries = await listAll(DROPBOX_SHARED_URL);
  console.log(`Found ${entries.length} images.`);

  let usedMedia = 0, usedGuess = 0, usedNom = 0, skipped = 0;
  const features = [];

  for (const f of entries) {
    let lon = null, lat = null, when = null, source = null;

    // 1) Dropbox media_info
    const media = f.media_info?.metadata;
    if (media?.location) {
      lat = media.location?.latitude ?? null;
      lon = media.location?.longitude ?? null;
      when = media.time_taken || null;
      if (lat != null && lon != null) { usedMedia++; source = "media_info"; }
    }

    // 2) Filename gazetteer
    if (lat == null || lon == null) {
      const g = guessFromFilename(f.name);
      if (g) { [lon, lat] = g; usedGuess++; source = "filename"; }
    }

    // 3) Optional Nominatim (explicit opt-in)
    if ((lat == null || lon == null) && ENABLE_NOMINATIN) {
      const name = f.name.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").trim();
      const g = await geocodeNominatim(name);
      if (g) { [lon, lat] = g; usedNom++; source = "nominatim"; }
    }

    if (lat == null || lon == null) { skipped++; continue; }

    features.push({
      type: "Feature",
      properties: { title: f.name, path: f.path_display, taken_at: when, source },
      geometry: { type: "Point", coordinates: [lon, lat] }
    });
  }

  const geo = { type: "FeatureCollection", features };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/locations.json", JSON.stringify(geo, null, 2), "utf8");

  // Write the proof page that consumes locations.json
  const html = htmlTemplate({ dataUrl: "locations.json" });
  await fs.writeFile("public/index.html", html, "utf8");
  await fs.writeFile("public/200.html", html, "utf8"); // handy fallback

  console.log(`Wrote ${features.length} features → public/locations.json`);
  console.log(`  via media_info: ${usedMedia}`);
  console.log(`  via filename gazetteer: ${usedGuess}`);
  if (ENABLE_NOMINATIN) console.log(`  via Nominatim: ${usedNom}`);
  console.log(`  skipped (no coords): ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
