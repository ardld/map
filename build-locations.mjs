import { Dropbox } from "dropbox";
import fs from "fs/promises";
import fetch from "node-fetch";

/* ===== HARD-CODED GOOGLE MAPS API KEY ===== */
const GMAPS_API_KEY = "AIzaSyAsT9RvYBryqFnJJpjEuHbtu1WveVMSoaI";

/* ===== REQUIRED ENV ===== */
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;              // Dropbox developer token
const DROPBOX_SHARED_URL = process.env.DROPBOX_SHARED_URL;    // The long ?scl/fo/... shared folder URL
const ENABLE_NOMINATIM = process.env.ENABLE_NOMINATIM === "1"; // optional filename geocoding

if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!DROPBOX_SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

/* ===== Dropbox SDK ===== */
const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

/* ===== Helpers ===== */
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name = "") {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some(ext => n.endsWith(ext));
}
const norm = s => (s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, ""); // strip diacritics

// Minimal RO gazetteer (extend freely). Stored as [lon, lat].
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

function guessFromFilename(name = "") {
  const t = norm(name);
  const keys = Object.keys(GAZ).filter(k => t.includes(k)).sort((a,b)=>b.length-a.length);
  return keys.length ? GAZ[keys[0]] : null;
}

async function geocodeNominatim(q) {
  if (!ENABLE_NOMINATIM) return null;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": "RealRomania-PhotoMap/1.0" } });
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
      data = more.result;
      for (const e of data.entries) {
        if (e[".tag"] === "folder") queue.push(e.path_lower);
        else if (e[".tag"] === "file" && isImage(e.name)) files.push(e);
      }
    }
  }
  return files;
}

function toRaw(u) {
  const url = new URL(u);
  url.searchParams.set("raw", "1");
  url.searchParams.delete("dl");
  return url.toString();
}

// Build a per-file shared URL from the folder shared link (no new links created)
async function fileLinksFromSharedFolder(sharedFolderUrl, subpathLower) {
  try {
    const meta = await dbx.sharingGetSharedLinkMetadata({ url: sharedFolderUrl, path: subpathLower });
    const page = meta.result?.url || null;
    return {
      pageUrl: page ? page.replace(/([?&])raw=1/, "$1dl=0") : null,
      rawUrl: page ? toRaw(page) : null
    };
  } catch {
    return { pageUrl: null, rawUrl: null };
  }
}

function htmlTemplate({ dataUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Photo Map • Google Maps</title>
<style>
  html, body, #map { height: 100%; margin: 0; }
  .gm-popup { max-width: 320px; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .gm-popup img { width: 100%; height: auto; display: block; border-radius: 8px; margin-bottom: 6px; }
  .gm-title { font-weight: 600; margin-bottom: 2px; }
  .gm-meta { opacity: .7; font-size: 12px; }
</style>
</head>
<body>
<div id="map"></div>

<script src="https://unpkg.com/@googlemaps/markerclusterer/dist/index.min.js"></script>
<script>
async function initMap() {
  const map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 45.94, lng: 25.0 },
    zoom: 6,
    mapTypeControl: false,
  });

  try {
    const res = await fetch('${dataUrl}?ts=' + Date.now());
    const geo = await res.json();
    const markers = [];

    for (const f of geo.features || []) {
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const lat = c[1], lng = c[0];

      const p = f.properties || {};
      const title = p.title || '';
      const imgSrc = p.thumb || p.original_raw || null;
      const linkTo = p.original_page || p.original_raw || p.thumb || null;

      const html =
        '<div class="gm-popup">' +
          (imgSrc ? ('<a ' + (linkTo ? 'href="'+linkTo+'" target="_blank" rel="noopener"' : '') + '>' +
                     '<img loading="lazy" src="'+imgSrc+'" alt="'+title+'"></a>') : '') +
          '<div class="gm-title">' + title + '</div>' +
          (p.taken_at ? '<div class="gm-meta">' + p.taken_at + '</div>' : '') +
        '</div>';

      const info = new google.maps.InfoWindow({ content: html });
      const m = new google.maps.Marker({ position: { lat, lng }, title });
      m.addListener('click', () => info.open({ anchor: m, map }));
      markers.push(m);
    }

    if (markers.length) {
      new markerClusterer.MarkerClusterer({ map, markers });
      const b = new google.maps.LatLngBounds();
      markers.forEach(m => b.extend(m.getPosition()));
      map.fitBounds(b);
    }
  } catch (e) {
    console.error('Failed to load data', e);
  }
}
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${GMAPS_API_KEY}&callback=initMap" defer async></script>
</body>
</html>`;
}

(async () => {
  console.log("Listing Dropbox shared folder…");
  const entries = await listAll(DROPBOX_SHARED_URL);
  console.log(`Found ${entries.length} images.`);

  await fs.mkdir("public", { recursive: true });

  let viaMedia = 0, viaGuess = 0, viaNom = 0, skipped = 0;
  const features = [];

  for (const f of entries) {
    try {
      let lon = null, lat = null, when = null, source = null;

      // 1) GPS from Dropbox media_info
      const media = f.media_info?.metadata;
      if (media?.location) {
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media.time_taken || null;
        if (lat != null && lon != null) { viaMedia++; source = "media_info"; }
      }

      // 2) Filename gazetteer
      if (lat == null || lon == null) {
        const g = guessFromFilename(f.name);
        if (g) { [lon, lat] = g; viaGuess++; source = source || "filename"; }
      }

      // 3) Optional Nominatim
      if ((lat == null || lon == null) && ENABLE_NOMINATIM) {
        const guess = await geocodeNominatim(
          f.name.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").trim()
        );
        if (guess) { [lon, lat] = guess; viaNom++; source = source || "nominatim"; }
      }

      if (lat == null || lon == null) { skipped++; continue; }

      // 4) Public links (from folder shared link)
      const links = await fileLinksFromSharedFolder(DROPBOX_SHARED_URL, f.path_lower);
      const original_raw = links.rawUrl || null;
      const original_page = links.pageUrl || null;

      features.push({
        type: "Feature",
        properties: {
          title: f.name,
          path: f.path_display,
          taken_at: when,
          source,
          original_raw,     // used in <img>
          original_page     // click-thru
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });
    } catch {
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
  if (ENABLE_NOMINATIM) console.log(`  via Nominatim: ${viaNom}`);
  console.log(`  skipped: ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
