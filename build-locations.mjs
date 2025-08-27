import { Dropbox } from "dropbox";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import crypto from "node:crypto";

/* ===== ENV ===== */
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_SHARED_URL = process.env.DROPBOX_SHARED_URL;
if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!DROPBOX_SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

/* ===== SDK ===== */
const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

/* ===== Helpers ===== */
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name=""){ const n=name.toLowerCase(); return IMAGE_EXTS.some(ext=>n.endsWith(ext)); }
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
function baseNoExt(n=""){ return n.replace(/\.[^.]+$/,"").replace(/[_\-.]+/g," ").trim(); }
function md5(s){ return crypto.createHash("md5").update(s).digest("hex"); }
function toRaw(u){ const url=new URL(u); url.searchParams.set("raw","1"); url.searchParams.delete("dl"); return url.toString(); }

/* Gazetteer fallback [lon,lat] — extend anytime */
const GAZ = {
  "breb":[23.9049,47.7485],"barsana":[24.0425,47.7367],"bethlen cris":[24.671,46.1932],
  "cris":[24.671,46.1932],"brateiu":[24.3826,46.1491],"bistrita":[24.5,47.133],
  "bnr":[26.0986,44.4305],"ateneu":[26.098,44.4412],"cheile bicazului":[25.8241,46.8121],
  "bicaz":[26.0901,46.9133],"bigar":[22.3514,45.0039],"praid":[25.1358,46.5534],
  "sasca":[21.7577,44.8803],"sucevita":[25.7206,47.7814],"sapanta":[23.6932,47.9682],
  "viscri":[25.0918,46.0558],"tihuta":[24.8058,47.3147],"bazias":[21.43,44.784],
  "vodita":[22.416,44.673],"zimbri hateg":[22.9538,45.6117],"vanatori neamt":[26.234,47.219],
  "lazarea":[25.5169,46.777],"enisala":[28.8382,44.8864],"feldioara":[25.5862,45.8282],
  "poienile izei":[24.116,47.694],"oravita":[21.6911,45.0391],"anina":[21.8583,45.0839],
  "capidava":[28.08,44.51],"cernavoda":[28.0333,44.3333],"harsova":[27.9533,44.6833],
  "rasova":[27.9344,44.2458],"seimeni":[28.0713,44.3932],"izvoarele":[28.165,44.392],
  "topalu":[28.011,44.531],"ogra":[24.289,46.464],"haller":[24.289,46.464],"dupus":[24.2164,46.2178]
};
function guessFromFilename(name=""){
  const t = norm(name);
  const keys = Object.keys(GAZ).filter(k=>t.includes(k)).sort((a,b)=>b.length-a.length);
  return keys.length ? GAZ[keys[0]] : null;
}

/* List all images recursively from the shared link */
async function listAll(sharedUrl){
  const shared_link = { url: sharedUrl };
  const files = [], queue = [""];
  while (queue.length){
    const folder = queue.shift();
    let res = await dbx.filesListFolder({ path: folder, shared_link, include_media_info: true });
    let data = res.result;

    for (const e of data.entries){
      if (e[".tag"]==="folder") queue.push(e.path_lower);
      else if (e[".tag"]==="file" && isImage(e.name)) files.push(e);
    }

    while (data.has_more){
      const more = await dbx.filesListFolderContinue({ cursor: data.cursor });
      data = more.result;
      for (const e of data.entries){
        if (e[".tag"]==="folder") queue.push(e.path_lower);
        else if (e[".tag"]==="file" && isImage(e.name)) files.push(e);
      }
    }
  }
  return files;
}

/* File page + raw URLs via shared link (no new link creation) */
async function getFileLinks(sharedFolderUrl, subpathLower){
  try{
    const meta = await dbx.sharingGetSharedLinkMetadata({ url: sharedFolderUrl, path: subpathLower });
    const page = meta.result?.url;
    if (!page) return { pageUrl: null, rawUrl: null };
    return { pageUrl: page.replace(/([?&])raw=1/, "$1dl=0"), rawUrl: toRaw(page) };
  }catch{
    return { pageUrl: null, rawUrl: null };
  }
}

/* Thumbnails via the Content API (works with shared link) */
async function fetchThumbnail(sharedFolderUrl, subpathLower){
  const api = "https://content.dropboxapi.com/2/files/get_thumbnail_v2";
  const arg = {
    resource: { ".tag":"shared_link", url: sharedFolderUrl, path: subpathLower },
    format:   { ".tag":"jpeg" },
    mode:     { ".tag":"fitone_bestfit" },
    size:     { ".tag":"w1024h768" }
  };
  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Dropbox-API-Arg": JSON.stringify(arg),
      "Content-Type": "application/octet-stream"
    },
    body: "" // empty body per API
  });
  if (!r.ok) throw new Error(`thumb ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/* HTML with CORRECT cluster script + graceful fallback */
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
  .popup { width: 320px; }
  .popup img { width: 100%; height: auto; display:block; border-radius:8px; }
  .title { font: 600 14px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 8px 0 0; }
  .meta { opacity:.7; font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
</style>
</head>
<body>
<div id="map"></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<!-- ✅ correct file name -->
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
const map = L.map('map', { preferCanvas:true }).setView([45.94, 25.00], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);

// If markercluster failed to load, fallback to a simple LayerGroup
const hasCluster = typeof L.markerClusterGroup === 'function';
const group = hasCluster ? L.markerClusterGroup({ disableClusteringAtZoom: 12 }) : L.layerGroup();

fetch('${dataUrl}?ts=' + Date.now())
  .then(r => r.json())
  .then(geo => {
    const markers = L.geoJSON(geo, {
      pointToLayer: (f, latlng) => L.marker(latlng),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        const imgSrc = p.thumb || p.original_raw;
        const linkTo = p.original_page || p.original_raw || p.thumb;
        const img = imgSrc ? '<a href="'+(linkTo||'#')+'" target="_blank" rel="noopener"><img loading="lazy" src="'+imgSrc+'" alt="'+(p.title||'')+'"/></a>' : '';
        const html = '<div class="popup">'+ img +
          '<div class="title">'+(p.title||'')+'</div>' +
          (p.taken_at ? '<div class="meta">'+p.taken_at+'</div>' : '') +
          '</div>';
        layer.bindPopup(html, { maxWidth: 360 });
      }
    });
    group.addLayer(markers);
    group.addTo(map);
    try { const b = markers.getBounds(); if (b.isValid()) map.fitBounds(b.pad(0.15)); } catch(e){}
  })
  .catch(err => console.error('Failed to load locations.json', err));
</script>
</body>
</html>`;
}

/* ===== BUILD ===== */
(async () => {
  console.log("Listing Dropbox shared folder…");
  const entries = await listAll(DROPBOX_SHARED_URL);
  console.log(`Found ${entries.length} images.`);

  await fs.mkdir("public", { recursive: true });
  await fs.mkdir("public/thumbs", { recursive: true });

  let viaMedia=0, viaGuess=0, thumbs=0, raws=0, skipped=0;
  const features = [];

  for (const f of entries) {
    try {
      let lon=null, lat=null, when=null, source=null;

      // GPS via media_info
      const media = f.media_info?.metadata;
      if (media?.location){
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media.time_taken || null;
        if (lat!=null && lon!=null){ viaMedia++; source="media_info"; }
      }

      // Filename guess fallback
      if (lat==null || lon==null){
        const g = guessFromFilename(f.name);
        if (g){ [lon,lat] = g; viaGuess++; source = source || "filename"; }
      }

      if (lat==null || lon==null){ skipped++; continue; }

      // File links (for click-through / raw fallback)
      let original_raw = null, original_page = null;
      const links = await getFileLinks(DROPBOX_SHARED_URL, f.path_lower);
      original_raw = links.rawUrl;
      original_page = links.pageUrl;
      if (original_raw) raws++;

      // Thumbnail from Content API (guaranteed popup image when succeeds)
      let thumb = null;
      try {
        const buf = await fetchThumbnail(DROPBOX_SHARED_URL, f.path_lower);
        const name = "t-" + md5(f.path_lower) + ".jpg";
        await fs.writeFile(path.join("public/thumbs", name), buf);
        thumb = "/thumbs/" + name;
        thumbs++;
      } catch (_) { /* use raw in popup if needed */ }

      features.push({
        type: "Feature",
        properties: {
          title: f.name,
          path: f.path_display,
          taken_at: when,
          source,
          thumb,
          original_raw,
          original_page
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });
    } catch (err) {
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
  console.log(`  via media_info: ${viaMedia}`);
  console.log(`  via filename: ${viaGuess}`);
  console.log(`  thumbnails created: ${thumbs}`);
  console.log(`  raw links obtained: ${raws}`);
  console.log(`  skipped: ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
