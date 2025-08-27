import { Dropbox } from "dropbox";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import Jimp from "jimp";

/* ========= ENV ========= */
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_SHARED_URL = process.env.DROPBOX_SHARED_URL;
const THUMB_MAX_WIDTH = parseInt(process.env.THUMB_MAX_WIDTH || "1024", 10);
if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!DROPBOX_SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

/* ========= SDK ========= */
const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

/* ========= Helpers ========= */
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name = "") {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some(ext => n.endsWith(ext));
}
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function safeFileName(n = "") { return n.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); }
function baseNoExt(n=""){ return n.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g," ").trim(); }
function toRaw(u){ const url=new URL(u); url.searchParams.set("raw","1"); url.searchParams.delete("dl"); return url.toString(); }

/* --- mini Romania gazetteer (extend anytime) [lon,lat] --- */
const GAZ = {
  "breb": [23.9049, 47.7485],
  "barsana": [24.0425, 47.7367],
  "bethlen cris": [24.6710, 46.1932],
  "cris": [24.6710, 46.1932],
  "brateiu": [24.3826, 46.1491],
  "bistrita": [24.5, 47.133],
  "bnr": [26.0986, 44.4305],
  "ateneu": [26.0980, 44.4412],
  "cheile bicazului": [25.8241, 46.8121],
  "bicaz": [26.0901, 46.9133],
  "bigar": [22.3514, 45.0039],
  "praid": [25.1358, 46.5534],
  "sasca": [21.7577, 44.8803],
  "sucevita": [25.7206, 47.7814],
  "sapanta": [23.6932, 47.9682],
  "viscri": [25.0918, 46.0558],
  "tihuta": [24.8058, 47.3147],
  "bazias": [21.4300, 44.7840],
  "vodita": [22.4160, 44.6730],
  "zimbri hateg": [22.9538, 45.6117],
  "vanatori neamt": [26.2340, 47.2190],
  "lazarea": [25.5169, 46.7770],
  "enisala": [28.8382, 44.8864],
  "feldioara": [25.5862, 45.8282],
  "poienile izei": [24.1160, 47.6940],
  "oravita": [21.6911, 45.0391],
  "anina": [21.8583, 45.0839],
  "capidava": [28.0800, 44.5100],
  "cernavoda": [28.0333, 44.3333],
  "harsova": [27.9533, 44.6833],
  "rasova": [27.9344, 44.2458],
  "seimeni": [28.0713, 44.3932],
  "izvoarele": [28.1650, 44.3920],
  "topalu": [28.0110, 44.5310],
  "ogra": [24.2890, 46.4640],
  "haller": [24.2890, 46.4640],
  "dupus": [24.2164, 46.2178]
};
function guessFromFilename(name=""){
  const t = norm(name);
  const keys = Object.keys(GAZ).filter(k => t.includes(k)).sort((a,b)=>b.length-a.length);
  return keys.length ? GAZ[keys[0]] : null;
}

/* --- list everything via shared link --- */
async function listAll(sharedUrl){
  const shared_link = { url: sharedUrl };
  const files = [], queue = [""];
  while(queue.length){
    const folder = queue.shift();
    let res = await dbx.filesListFolder({ path: folder, shared_link, include_media_info: true });
    let data = res.result;
    for(const e of data.entries){
      if(e[".tag"]==="folder") queue.push(e.path_lower);
      else if(e[".tag"]==="file" && isImage(e.name)) files.push(e);
    }
    while(data.has_more){
      const more = await dbx.filesListFolderContinue({ cursor: data.cursor });
      data = more.result;
      for(const e of data.entries){
        if(e[".tag"]==="folder") queue.push(e.path_lower);
        else if(e[".tag"]==="file" && isImage(e.name)) files.push(e);
      }
    }
  }
  return files;
}

/* --- get a per-file public link, then download bytes via HTTP --- */
async function getRawUrlFromFolderLink(sharedFolderUrl, subpathLower){
  const m = await dbx.sharingGetSharedLinkMetadata({ url: sharedFolderUrl, path: subpathLower });
  const url = m.result?.url;
  if(!url) throw new Error("no per-file url");
  return toRaw(url); // adds raw=1
}
async function fetchBytes(url){
  const r = await fetch(url, { redirect: "follow" });
  if(!r.ok) throw new Error(`http ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/* --- write minimal Leaflet page that shows images --- */
function htmlTemplate({ dataUrl }){
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
  .popup img { width: 100%; height: auto; display:block; border-radius:8px; }
  .title { font: 600 14px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 8px 0 0; }
  .meta { opacity:.7; font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
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
        const img = p.thumb ? '<img loading="lazy" src="'+p.thumb+'" alt="'+(p.title||'')+'"/>' : '';
        const link = p.original ? '<div class="meta"><a href="'+p.original+'" target="_blank" rel="noopener">Open on Dropbox</a></div>' : '';
        const html = '<div class="popup">'+ img +
          '<div class="title">'+(p.title||'')+'</div>' +
          (p.taken_at ? '<div class="meta">'+p.taken_at+'</div>' : '') +
          link + '</div>';
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

/* ========= BUILD ========= */
(async () => {
  console.log("Listing Dropbox shared folder…");
  const entries = await listAll(DROPBOX_SHARED_URL);
  console.log(`Found ${entries.length} images.`);

  await fs.mkdir("public", { recursive: true });
  await fs.mkdir("public/thumbs", { recursive: true });

  let usedMedia=0, usedGuess=0, usedThumb=0, skipped=0;
  const features = [];

  for(const f of entries){
    try{
      let lon=null, lat=null, when=null, source=null;

      // GPS from Dropbox media_info
      const media = f.media_info?.metadata;
      if (media?.location){
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media.time_taken || null;
        if (lat!=null && lon!=null){ usedMedia++; source="media_info"; }
      }

      // filename guess
      if (lat==null || lon==null){
        const g = guessFromFilename(f.name);
        if (g){ [lon,lat] = g; usedGuess++; source = source || "filename"; }
      }

      if (lat==null || lon==null){ skipped++; continue; }

      // Per-file public link → download → thumbnail
      let thumbUrl = null, original = null;
      try{
        const rawUrl = await getRawUrlFromFolderLink(DROPBOX_SHARED_URL, f.path_lower);
        original = rawUrl.replace(/([?&])raw=1/, "$1dl=0"); // nicer link for opening
        const buf = await fetchBytes(rawUrl);
        // Jimp can't read HEIC; catch & continue without thumb
        const img = await Jimp.read(buf);
        if (img.getWidth() > THUMB_MAX_WIDTH) img.resize({ w: THUMB_MAX_WIDTH });
        const thumbName = safeFileName(baseNoExt(f.name)) + ".jpg";
        const thumbPath = path.join("public/thumbs", thumbName);
        await img.quality(82).writeAsync(thumbPath);
        thumbUrl = "/thumbs/" + thumbName;
        usedThumb++;
      } catch(e){
        // no thumbnail, but keep the point
        // console.warn("No thumb:", f.name, e.message);
      }

      features.push({
        type: "Feature",
        properties: {
          title: f.name,
          path: f.path_display,
          taken_at: when,
          source,
          thumb: thumbUrl,
          original
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });
    }catch(err){
      console.warn("Skip due to error:", f?.name, err?.message);
      skipped++;
    }
  }

  const geo = { type: "FeatureCollection", features };
  await fs.writeFile("public/locations.json", JSON.stringify(geo, null, 2), "utf8");
  const html = htmlTemplate({ dataUrl: "locations.json" });
  await fs.writeFile("public/index.html", html, "utf8");
  await fs.writeFile("public/200.html", html, "utf8");

  console.log(`Wrote ${features.length} features → public/locations.json`);
  console.log(`  via media_info: ${usedMedia}`);
  console.log(`  via filename: ${usedGuess}`);
  console.log(`  with thumbnails: ${usedThumb}`);
  console.log(`  skipped (no coords or fatal): ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
