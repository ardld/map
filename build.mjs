import { Dropbox } from "dropbox";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import crypto from "node:crypto";

/* === Config from Secrets (with fallback) === */
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_SHARED_URL = process.env.DROPBOX_SHARED_URL;
const GMAPS_API_KEY = process.env.GMAPS_API_KEY || "AIzaSyAsT9RvYBryqFnJJpjEuHbtu1WveVMSoaI";
const ENABLE_NOMINATIM = process.env.ENABLE_NOMINATIM === "1";

if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!DROPBOX_SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

/* === Helpers === */
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
const isImage = n => IMAGE_EXTS.some(ext => (n||"").toLowerCase().endsWith(ext));
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const md5  = s => crypto.createHash("md5").update(s).digest("hex");
const esc  = s => String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;");

/* Tiny RO gazetteer [lon,lat] */
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
const guessFromFilename = (name="") => {
  const t = norm(name);
  const keys = Object.keys(GAZ).filter(k=>t.includes(k)).sort((a,b)=>b.length-a.length);
  return keys.length ? GAZ[keys[0]] : null;
};

/* === Dropbox === */
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

/* Build a page URL + a raw ?raw=1 URL from the folder shared link */
async function filePageAndRaw(sharedFolderUrl, subpathLower){
  try{
    const meta = await dbx.sharingGetSharedLinkMetadata({ url: sharedFolderUrl, path: subpathLower });
    const page = meta.result?.url || null;
    const pageUrl = page ? page.replace(/([?&])raw=1/, "$1dl=0") : null;
    const rawUrl  = page ? (()=>{ const u=new URL(page); u.searchParams.set("raw","1"); u.searchParams.delete("dl"); return u.toString(); })() : null;
    return { pageUrl, rawUrl };
  }catch{
    return { pageUrl: null, rawUrl: null };
  }
}

/* Try A: thumbnail via SHARED LINK */
async function fetchThumbViaSharedLink(sharedFolderUrl, subpathLower){
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
    body: ""
  });
  if(!r.ok) throw new Error(`thumb(shared_link) ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/* Try B: thumbnail via FILE ID (if token has direct access) */
async function fetchThumbViaId(fileId){
  const api = "https://content.dropboxapi.com/2/files/get_thumbnail_v2";
  const arg = {
    resource: { ".tag":"path", "path": fileId },   // Dropbox accepts ids/paths here
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
    body: ""
  });
  if(!r.ok) throw new Error(`thumb(id) ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/* === HTML (single InfoWindow, pagination, zoom cap, lightbox) === */
function htmlTemplate({ dataUrl, apiKey }){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Photo Map • Google Maps</title>
<style>
  html, body, #map { height: 100%; margin: 0; }
  .gm-popup { max-width: 340px; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .gm-popup .imgwrap { position: relative; }
  .gm-popup img { width: 100%; height: auto; display: block; border-radius: 8px; }
  .gm-title { font-weight: 600; margin: 6px 0 2px 0; }
  .gm-meta { opacity: .7; font-size: 12px; }
  .gm-pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
  .gm-btn { border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .gm-count { font-size: 12px; opacity: .7; }
  /* Lightbox */
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.9); display: none; align-items: center; justify-content: center; z-index: 9999; }
  #lightbox img { max-width: 92vw; max-height: 90vh; display: block; }
  #lightbox .close { position: absolute; top: 12px; right: 16px; font-size: 28px; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<div id="map"></div>

<!-- Lightbox -->
<div id="lightbox">
  <span class="close" aria-label="Close">×</span>
  <img alt="">
</div>

<script src="https://unpkg.com/@googlemaps/markerclusterer/dist/index.min.js"></script>
<script>
function groupByCoord(features) {
  const by = new Map();
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const p = f.properties || {};
    if (!c || c.length < 2) continue;
    const lat = c[1], lng = c[0];
    const key = lat.toFixed(5) + "," + lng.toFixed(5); // group within ~1m
    const item = {
      title: p.title || "",
      taken_at: p.taken_at || "",
      thumb: p.thumb || null,
      thumb_external: p.thumb_external || null,
      full_external: p.full_external || p.thumb_external || p.thumb || null
    };
    if (!by.has(key)) by.set(key, { lat, lng, items: [item] });
    else by.get(key).items.push(item);
  }
  return Array.from(by.values());
}

async function initMap() {
  const map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 45.94, lng: 25.0 },
    zoom: 6,
    mapTypeControl: false
  });

  const info = new google.maps.InfoWindow(); // single InfoWindow => only one open at a time

  // Lightbox helpers
  const lb = document.getElementById('lightbox');
  const lbImg = lb.querySelector('img');
  const lbClose = lb.querySelector('.close');
  lb.addEventListener('click', (e)=>{ if(e.target===lb || e.target===lbClose) { lb.style.display='none'; lbImg.src=''; }});
  document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') { lb.style.display='none'; lbImg.src=''; }});

  try {
    const res = await fetch('${dataUrl}?ts=' + Date.now());
    const geo = await res.json();

    // Group multiple photos at identical coords
    const groups = groupByCoord(geo.features || []);
    const markers = [];

    function renderPopup(marker, g, idx) {
      const n = g.items.length;
      const i = ((idx % n) + n) % n;
      const it = g.items[i];
      const imgSrc = it.thumb || it.thumb_external || null;
      const html =
        '<div class="gm-popup" data-idx="'+i+'">' +
          (n>1 ? (
            '<div class="gm-pager">' +
              '<button class="gm-btn gm-prev" aria-label="Previous">‹ Prev</button>' +
              '<span class="gm-count">'+(i+1)+' / '+n+'</span>' +
              '<button class="gm-btn gm-next" aria-label="Next">Next ›</button>' +
            '</div>'
          ) : '') +
          (imgSrc ? ('<div class="imgwrap">' +
                       '<a href="#" class="imglink" data-full="'+(it.full_external||'')+'">' +
                         '<img loading="lazy" src="'+imgSrc+'" alt="'+(it.title||'')+'">' +
                       '</a>' +
                     '</div>') : '') +
          '<div class="gm-title">'+(it.title||'')+'</div>' +
          (it.taken_at ? '<div class="gm-meta">'+it.taken_at+'</div>' : '') +
        '</div>';

      info.setContent(html);
      info.open({ anchor: marker, map });

      // Wire controls once DOM is ready for THIS content
      google.maps.event.addListenerOnce(info, 'domready', () => {
        const box = document.querySelector('.gm-popup');
        const prev = document.querySelector('.gm-prev');
        const next = document.querySelector('.gm-next');
        const link = document.querySelector('.imglink');

        if (prev) prev.onclick = (e)=>{ e.preventDefault(); renderPopup(marker, g, i-1); };
        if (next) next.onclick = (e)=>{ e.preventDefault(); renderPopup(marker, g, i+1); };

        if (link) link.onclick = (e)=>{
          e.preventDefault();
          const full = link.getAttribute('data-full');
          if (full) { lbImg.src = full; lb.style.display = 'flex'; }
        };
      });
    }

    // Create one marker per group
    for (const g of groups) {
      const m = new google.maps.Marker({ position: { lat: g.lat, lng: g.lng } });
      m.addListener('click', () => renderPopup(m, g, 0));
      markers.push(m);
    }

    // Cluster with a gentle cluster-zoom
    new markerClusterer.MarkerClusterer({
      map,
      markers,
      onClusterClick: (ev) => {
        const bounds = ev.cluster.bounds;
        map.fitBounds(bounds);
        // Cap zoom so it doesn't dive into street level
        setTimeout(() => { if (map.getZoom() > 8) map.setZoom(8); }, 0);
      }
    });

    // Fit bounds initially, but cap zoom (keep it higher)
    if (markers.length) {
      const b = new google.maps.LatLngBounds();
      markers.forEach(m => b.extend(m.getPosition()));
      map.fitBounds(b);
      google.maps.event.addListenerOnce(map, 'idle', () => {
        if (map.getZoom() > 8) map.setZoom(8);
      });
    }
  } catch (e) {
    console.error('Failed to load data', e);
  }
}
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap" defer async></script>
</body>
</html>`;
}

/* === Build === */
(async () => {
  console.log("Listing Dropbox shared folder…");
  const entries = await listAll(DROPBOX_SHARED_URL);
  console.log(`Found ${entries.length} images.`);

  await fs.mkdir("site", { recursive: true });
  await fs.mkdir("site/thumbs", { recursive: true });

  let viaMedia=0, viaGuess=0, viaNom=0, thumbs=0, extLinks=0, skipped=0;
  const features = [];

  for (const f of entries) {
    try {
      let lon=null, lat=null, when=null, source=null;

      // 1) GPS via media_info
      const media = f.media_info?.metadata;
      if (media?.location) {
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media?.time_taken || null;
        if (lat!=null && lon!=null) { viaMedia++; source="media_info"; }
      }

      // 2) Filename guess
      if (lat==null || lon==null) {
        const g = guessFromFilename(f.name);
        if (g){ [lon,lat]=g; viaGuess++; source = source || "filename"; }
      }

      // 3) Optional Nominatim
      if ((lat==null || lon==null) && ENABLE_NOMINATIM) {
        const urlName = f.name.replace(/\.[^.]+$/,"").replace(/[_\-.]+/g," ").trim();
        try{
          const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(urlName)}&format=jsonv2&limit=1`;
          const r = await fetch(u, { headers:{ "User-Agent":"RealRomania-PhotoMap/1.0" } });
          if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length) { [lon,lat] = [parseFloat(d[0].lon), parseFloat(d[0].lat)]; viaNom++; source = source || "nominatim"; }
          }
        }catch{}
      }

      if (lat==null || lon==null) { skipped++; continue; }

      // Per-file links
      const { pageUrl, rawUrl } = await filePageAndRaw(DROPBOX_SHARED_URL, f.path_lower);

      // Try local thumbnail (A then B)
      let thumbRel = null;
      try {
        const buf = await fetchThumbViaSharedLink(DROPBOX_SHARED_URL, f.path_lower);
        const name = "t-" + md5(f.path_lower) + ".jpg";
        await fs.writeFile(path.join("site/thumbs", name), buf);
        thumbRel = "thumbs/" + name;
        thumbs++;
      } catch {}
      if (!thumbRel && f.id) {
        try {
          const buf2 = await fetchThumbViaId(f.id);
          const name2 = "t-" + md5(f.id) + ".jpg";
          await fs.writeFile(path.join("site/thumbs", name2), buf2);
          thumbRel = "thumbs/" + name2;
          thumbs++;
        } catch {}
      }

      // External raw fallback
      let thumbExternal = null;
      if (!thumbRel && rawUrl) { thumbExternal = rawUrl; extLinks++; }

      features.push({
        type: "Feature",
        properties: {
          title: esc(f.name),
          taken_at: when,
          source,
          original_page: pageUrl,
          thumb: thumbRel,               // local thumbnail
          thumb_external: thumbExternal, // fallback for <img>
          full_external: rawUrl          // bigger image for lightbox
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });

    } catch {
      skipped++;
    }
  }

  const geo = { type: "FeatureCollection", features };
  await fs.writeFile("site/locations.json", JSON.stringify(geo, null, 2), "utf8");
  const html = htmlTemplate({ dataUrl: "locations.json", apiKey: GMAPS_API_KEY });
  await fs.writeFile("site/index.html", html, "utf8");

  console.log(`Wrote ${features.length} features -> site/locations.json`);
  console.log(`  via media_info: ${viaMedia}`);
  console.log(`  via filename:   ${viaGuess}`);
  if (ENABLE_NOMINATIM) console.log(`  via Nominatim:  ${viaNom}`);
  console.log(`  local thumbs:   ${thumbs}`);
  console.log(`  external imgs:  ${extLinks}`);
  console.log(`  skipped:        ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
