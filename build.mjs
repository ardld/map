// buildi.js — builds static site into ./site
// - pulls Dropbox shared folder, extracts GPS (EXIF) or guesses from filename
// - writes site/locations.json + site/thumbs/*
// - writes site/index.html (Google Maps; centered on Romania)
// env needed at build-time: DROPBOX_* + GMAPS_API_KEY

import { Dropbox } from "dropbox";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import crypto from "node:crypto";

/* === Config (env) === */
const RAW_TOKEN       = process.env.DROPBOX_TOKEN;            // optional (may expire)
const REFRESH         = process.env.DROPBOX_REFRESH_TOKEN;     // recommended (long-lived)
const APP_KEY         = process.env.DROPBOX_APP_KEY;
const APP_SECRET      = process.env.DROPBOX_APP_SECRET;
const SHARED_URL      = process.env.DROPBOX_SHARED_URL;        // REQUIRED (shared folder link)
const GMAPS_API_KEY   = process.env.GMAPS_API_KEY || "";       // Google Maps JS key
const ENABLE_NOMINATIM = process.env.ENABLE_NOMINATIM === "1"; // optional reverse geocode
const NOMINATIM_EMAIL  = process.env.NOMINATIM_EMAIL || "";
const NOMI_THROTTLE    = parseInt(process.env.NOMINATIM_THROTTLE_MS || "1100", 10);

if (!SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

/* === Auth Dropbox === */
async function fetchAccessTokenViaRefresh() {
  if (!REFRESH || !APP_KEY || !APP_SECRET) return null;
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH });
  const auth = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString("base64");
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!r.ok) throw new Error(`Dropbox refresh failed: ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return j.access_token;
}
async function getAccessToken() {
  if (REFRESH && APP_KEY && APP_SECRET) {
    console.log("Using Dropbox refresh token.");
    return await fetchAccessTokenViaRefresh();
  }
  if (RAW_TOKEN) {
    console.log("Using DROPBOX_TOKEN (may expire).");
    return RAW_TOKEN;
  }
  throw new Error("Configure refresh (DROPBOX_REFRESH_TOKEN + APP_KEY + APP_SECRET) or DROPBOX_TOKEN.");
}
async function makeDbx() {
  const token = await getAccessToken();
  return new Dropbox({ accessToken: token, fetch });
}

/* === Utils === */
const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
const isImage = n => IMAGE_EXTS.some(ext => (n||"").toLowerCase().endsWith(ext));
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const md5  = s => crypto.createHash("md5").update(s).digest("hex");
const esc  = s => String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseKey = name => (name||"").toLowerCase().replace(/\.[^.]+$/,'').trim();

/* filename -> rough [lon,lat] for Romanian highlights */
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

/* Reverse geocode (optional) */
const geoCache = new Map(); // "lat,lng" -> { niceTitle, components }
async function reverseGeocode(lat, lng){
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  if (!ENABLE_NOMINATIM) { geoCache.set(key,null); return null; }

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "14");
  if (NOMINATIM_EMAIL) url.searchParams.set("email", NOMINATIM_EMAIL);

  await sleep(NOMI_THROTTLE);
  const r = await fetch(url.toString(), { headers: { "User-Agent":"RealRomania-PhotoMap/1.0 (+github-pages)" }});
  if (!r.ok) { geoCache.set(key,null); return null; }
  const j = await r.json().catch(()=>null);
  if (!j) { geoCache.set(key,null); return null; }

  const addr = j.address || {};
  const name = j.name || addr.tourism || addr.historic || addr.natural || addr.village || addr.town || addr.city || "Romania";
  const county = addr.county || addr.state || "";
  const niceTitle = county ? `${name}, ${county}` : name;
  const info = { niceTitle, components: addr };
  geoCache.set(key, info);
  return info;
}

/* Fallback text in EN (used only if no override in content.json) */
function makeBlurb(niceTitle, components) {
  const area = components?.county || components?.state || "Romania";
  return `${niceTitle} is a photogenic stop in ${area}. Take a short walk, find a view, and let it fold into your itinerary.`;
}
function titleFromFilename(name) {
  const base = (name||"").replace(/\.[^.]+$/,'').replace(/[_\-]+/g,' ').trim();
  const words = base.split(/\s+/).map(w=>w[0]?w[0].toUpperCase()+w.slice(1):w);
  return words.join(' ');
}

/* Load content.json overrides (root) */
async function loadOverrides() {
  try {
    const txt = await fs.readFile("content.json","utf8");
    const arr = JSON.parse(txt);
    const byName = new Map(); // base filename (no ext), lowercased
    const patterns = [];      // [{ re: RegExp, data: {title, description}}]

    for (const it of arr) {
      if (!it) continue;
      const title = String(it.title || "");
      const description = String(it.description || "");
      if (it.filename) {
        byName.set(baseKey(it.filename), { title, description });
      } else if (it.pattern) {
        patterns.push({ re: new RegExp(it.pattern, "i"), data: { title, description } });
      }
    }
    console.log(`Overrides: ${byName.size} names & ${patterns.length} patterns.`);
    return { byName, patterns };
  } catch {
    console.log("No content.json — using automatic titles/descriptions.");
    return { byName: new Map(), patterns: [] };
  }
}

/* Dropbox listing */
async function listAll(dbx){
  const shared_link = { url: SHARED_URL };
  const files = [], queue = [""];
  while(queue.length){
    const folder = queue.shift();
    const res = await dbx.filesListFolder({ path: folder, shared_link, include_media_info: true });
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

/* Links & thumbnails */
async function filePageAndRaw(dbx, subpathLower){
  try{
    const meta = await dbx.sharingGetSharedLinkMetadata({ url: SHARED_URL, path: subpathLower });
    const page = meta.result?.url || null;
    const pageUrl = page ? page.replace(/([?&])raw=1/, "$1dl=0") : null;
    const rawUrl  = page ? (()=>{ const u=new URL(page); u.searchParams.set("raw","1"); u.searchParams.delete("dl"); return u.toString(); })() : null;
    return { pageUrl, rawUrl };
  }catch{
    return { pageUrl: null, rawUrl: null };
  }
}
async function fetchThumbViaSharedLink(dbx, subpathLower){
  const api = "https://content.dropboxapi.com/2/files/get_thumbnail_v2";
  const arg = {
    resource: { ".tag":"shared_link", url: SHARED_URL, path: subpathLower },
    format:   { ".tag":"jpeg" },
    mode:     { ".tag":"fitone_bestfit" },
    size:     { ".tag":"w1024h768" }
  };
  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${dbx.auth.getAccessToken()}`,
      "Dropbox-API-Arg": JSON.stringify(arg),
      "Content-Type": "application/octet-stream"
    },
    body: ""
  });
  if(!r.ok) throw new Error(`thumb(shared_link) ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function fetchThumbViaIdOrPath(dbx, idOrPath){
  const api = "https://content.dropboxapi.com/2/files/get_thumbnail_v2";
  const arg = {
    resource: { ".tag":"path", "path": idOrPath },
    format:   { ".tag":"jpeg" },
    mode:     { ".tag":"fitone_bestfit" },
    size:     { ".tag":"w1024h768" }
  };
  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${dbx.auth.getAccessToken()}`,
      "Dropbox-API-Arg": JSON.stringify(arg),
      "Content-Type": "application/octet-stream"
    },
    body: ""
  });
  if(!r.ok) throw new Error(`thumb(id/path) ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/* HTML template (centered on Romania) */
function htmlTemplate({ dataUrl, apiKey }){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Real Romania • Photo Map</title>
<style>
  :root { --left: 380px; --bg:#ffffff; --panel:#f6f7f9; --text:#111; --muted:#5a6b7b; --border:#e7eaef; --accent:#2f6fed; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin:0; background:var(--bg); color:var(--text); font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #wrap { display: grid; grid-template-columns: var(--left) 1fr; height: 100%; }
  #left { background: var(--panel); border-right: 1px solid var(--border); display:flex; flex-direction:column; min-width:0; }
  #brand { padding: 12px 14px; border-bottom:1px solid var(--border); font-weight:650; letter-spacing:.2px; }
  #explain { padding: 14px; border-bottom:1px solid var(--border); }
  #explain h3 { margin: 6px 0 0 0; font-size: 16px; }
  #explain p { margin: 0 0 8px 0; color: var(--muted); }
  #explain .thumb { width: 100%; border-radius:12px; margin-top:10px; display:block; border:1px solid var(--border); }
  #toc { padding: 8px; overflow:auto; flex: 1 1 auto; }
  .toc-item { padding: 8px 10px; border-radius: 10px; cursor: pointer; display:flex; align-items:center; gap:10px; border:1px solid transparent; }
  .toc-item:hover { background:#eef3ff; border-color:#dde7ff; }
  .toc-item.active { background:#e9efff; border-color:#d6e3ff; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); opacity:.85; }
  .toc-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  .toc-count { margin-left:auto; color:var(--muted); font-size:12px; }
  #map { width: 100%; height: 100%; }
  .gm-popup { max-width: 360px; }
  .gm-popup .imgwrap img { width: 100%; height:auto; display:block; border-radius:10px; }
  .gm-pager { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:6px 0; }
  .gm-btn { border: 1px solid #cdd5df; background: #fff; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .gm-count { font-size: 12px; color:#5a6b7b; }
  .gm-title { font-weight:650; margin:6px 0 2px 0; }
  .gm-meta { color:#6b7a88; font-size:12px; }
  /* Lightbox */
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.92); display: none; align-items: center; justify-content: center; z-index: 9999; }
  #lightbox img { max-width: 92vw; max-height: 90vh; display: block; }
  #lightbox .close { position: absolute; top: 12px; right: 16px; font-size: 28px; color: #fff; cursor: pointer; }
  #lightbox .nav { position: absolute; top: 50%; transform: translateY(-50%); font-size: 28px; color: #fff; background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.3); border-radius: 8px; padding: 6px 12px; cursor: pointer; user-select: none; }
  #lightbox .prev { left: 16px; }
  #lightbox .next { right: 16px; }
  #lightbox .counter { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 13px; opacity: .8; }
</style>
</head>
<body>
<div id="wrap">
  <div id="left">
    <div id="brand">Real Romania • Contents</div>
    <div id="explain">
      <p>Select a place from the list or a pin on the map. When you pick one, you’ll see the description (first) and a thumbnail here; click the photo for a full-screen view.</p>
      <h3>&nbsp;</h3>
    </div>
    <div id="toc" role="navigation" aria-label="Places"></div>
  </div>
  <div id="map"></div>
</div>

<div id="lightbox" aria-modal="true" role="dialog">
  <span class="close" aria-label="Close">×</span>
  <button class="nav prev" aria-label="Previous">‹</button>
  <img alt="">
  <button class="nav next" aria-label="Next">›</button>
  <div class="counter"></div>
</div>

<script>
const DATA_URL = '${dataUrl}?ts=' + Date.now();

// small helper to toggle dropbox raw/dl param when an image fails
function toggleDropboxParam(u){
  try{
    const url = new URL(u);
    if (url.hostname.includes('dropbox')) {
      const hasRaw = url.searchParams.get('raw') === '1';
      const hasDl  = url.searchParams.get('dl') === '1';
      if (hasRaw) { url.searchParams.delete('raw'); url.searchParams.set('dl','1'); }
      else if (hasDl) { url.searchParams.delete('dl'); url.searchParams.set('raw','1'); }
      else { url.searchParams.set('raw','1'); }
      return url.toString();
    }
  }catch{}
  return u;
}

function groupByCoord(features) {
  const by = new Map();
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const p = f.properties || {};
    if (!c || c.length < 2) continue;
    const lat = +c[1], lng = +c[0];
    const key = lat.toFixed(5) + "," + lng.toFixed(5);
    const item = {
      title: p.title || "",
      place_title: p.place_title || p.title || "",
      cuprins_title: p.cuprins_title || "",
      blurb: p.blurb || "",
      cuprins_desc: p.cuprins_desc || "",
      taken_at: p.taken_at || "",
      thumb: p.thumb || null,
      thumb_external: p.thumb_external || null,
      full_external: p.full_external || p.thumb_external || p.thumb || null,
      lat, lng
    };
    if (!by.has(key)) by.set(key, { lat, lng, items: [item] });
    else by.get(key).items.push(item);
  }
  return Array.from(by.values()).map(g=>{
    const pick = (get) => {
      const freq = new Map();
      for (const it of g.items) {
        const t = get(it) || "";
        freq.set(t, (freq.get(t)||0)+1);
      }
      let best = ""; let bestCount = -1;
      for (const [t,c] of freq) if (t && c>bestCount) { best=t; bestCount=c; }
      return best;
    };
    g.title = pick(it=>it.cuprins_title) || pick(it=>it.place_title) || "Place";
    return g;
  });
}

let map, info;
let groups = [];
let markers = [];
let currentGroup = null;
let currentIndex = 0;

const left = {
  toc: null, explain: null,
  lightbox: null, lbImg: null, lbClose: null, lbPrev: null, lbNext: null, lbCount: null,
};

function attachImgFallback(imgEl, it){
  imgEl.addEventListener('error', () => {
    const alt = toggleDropboxParam(imgEl.src);
    if (alt !== imgEl.src) { imgEl.src = alt; return; }
    if (it.full_external && imgEl.src !== it.full_external) { imgEl.src = it.full_external; return; }
    if (it.thumb_external && imgEl.src !== it.thumb_external) { imgEl.src = it.thumb_external; return; }
  });
}
function renderExplain(group, idx){
  currentGroup = group; currentIndex = ((idx % group.items.length)+group.items.length)%group.items.length;
  const it = group.items[currentIndex];
  const ex = left.explain;
  ex.innerHTML = "";

  const p = document.createElement('p');  p.textContent = it.cuprins_desc || it.blurb || '';
  const h = document.createElement('h3'); h.textContent = it.cuprins_title || it.place_title || it.title || 'Photo';
  ex.appendChild(p); ex.appendChild(h);

  const imgSrc = it.thumb || it.thumb_external || it.full_external;
  if (imgSrc) {
    const a = document.createElement('a'); a.href="#";
    const img = document.createElement('img'); img.className="thumb"; img.alt=it.title||"";
    img.src = imgSrc; attachImgFallback(img, it);
    a.appendChild(img);
    a.onclick = (e)=>{ e.preventDefault(); openLightbox(group, currentIndex); };
    ex.appendChild(a);
  }
}
function openLightbox(group, index) {
  currentGroup = group; currentIndex = ((index % group.items.length)+group.items.length)%group.items.length;
  const n = group.items.length; const it = group.items[currentIndex];
  const src = it.full_external || it.thumb_external || it.thumb;
  left.lightbox.style.display='flex';
  left.lbImg.src = src || "";
  left.lbCount.textContent = (n>1) ? ( (currentIndex+1)+" / "+n ) : "";
  left.lbPrev.style.display = (n>1) ? "block" : "none";
  left.lbNext.style.display = (n>1) ? "block" : "none";
  left.lbImg.onerror = ()=> {
    const alt = toggleDropboxParam(left.lbImg.src);
    if (alt !== left.lbImg.src) { left.lbImg.src = alt; return; }
    if (it.thumb_external && left.lbImg.src !== it.thumb_external) { left.lbImg.src = it.thumb_external; return; }
  };
}
function closeLightbox(){ left.lightbox.style.display='none'; left.lbImg.src=""; }
function stepLightbox(delta){
  if (!currentGroup) return;
  const n = currentGroup.items.length;
  currentIndex = ((currentIndex + delta) % n + n) % n;
  openLightbox(currentGroup, currentIndex);
}

function renderPopup(marker, group, idx) {
  const n = group.items.length;
  const i = ((idx % n) + n) % n;
  const it = group.items[i];
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
                   '<a href="#" class="imglink" data-idx="'+i+'">' +
                     '<img loading="lazy" class="gm-img" src="'+imgSrc+'" alt="'+(it.title||'')+'">' +
                   '</a>' +
                 '</div>') : '') +
      '<div class="gm-title">'+(it.cuprins_title || it.place_title || it.title || '')+'</div>' +
      (it.taken_at ? '<div class="gm-meta">'+it.taken_at+'</div>' : '') +
    '</div>';

  info.setContent(html);
  info.open({ anchor: marker, map });

  google.maps.event.addListenerOnce(info, 'domready', () => {
    const prev = document.querySelector('.gm-prev');
    const next = document.querySelector('.gm-next');
    const link = document.querySelector('.imglink');
    const img  = document.querySelector('.gm-img');

    if (img) attachImgFallback(img, it);
    if (prev) prev.onclick = (e)=>{ e.preventDefault(); renderPopup(marker, group, i-1); renderExplain(group, i-1); };
    if (next) next.onclick = (e)=>{ e.preventDefault(); renderPopup(marker, group, i+1); renderExplain(group, i+1); };
    if (link) link.onclick = (e)=>{ e.preventDefault(); openLightbox(group, i); };
  });

  renderExplain(group, i);
}

function buildTOC(groups) {
  const toc = left.toc; toc.innerHTML = "";
  groups.forEach((g, idx)=>{
    const item = document.createElement('div');
    item.className = 'toc-item';
    const dot = document.createElement('div'); dot.className = 'dot';
    const title = document.createElement('div'); title.className = 'toc-title'; title.textContent = g.title || ('Place ' + (idx+1));
    const count = document.createElement('div'); count.className = 'toc-count'; count.textContent = g.items.length + ' photo' + (g.items.length>1?'s':'');
    item.appendChild(dot); item.appendChild(title); item.appendChild(count);
    item.onclick = ()=>{
      document.querySelectorAll('.toc-item').forEach(el=>el.classList.remove('active'));
      item.classList.add('active');
      const m = markers[idx];
      map.panTo({ lat: g.lat, lng: g.lng });
      map.setZoom(Math.max(map.getZoom(), 10));
      google.maps.event.trigger(m, 'click');
    };
    toc.appendChild(item);
  });
}

window.initMap = async function initMap() {
  left.toc = document.getElementById('toc');
  left.explain = document.getElementById('explain');
  left.lightbox = document.getElementById('lightbox');
  left.lbImg = left.lightbox.querySelector('img');
  left.lbClose = left.lightbox.querySelector('.close');
  left.lbPrev = left.lightbox.querySelector('.prev');
  left.lbNext = left.lightbox.querySelector('.next');
  left.lbCount = left.lightbox.querySelector('.counter');

  left.lbClose.onclick = closeLightbox;
  left.lightbox.addEventListener('click', (e)=>{ if(e.target===left.lightbox) closeLightbox(); });
  left.lbPrev.onclick = (e)=>{ e.preventDefault(); stepLightbox(-1); };
  left.lbNext.onclick = (e)=>{ e.preventDefault(); stepLightbox(1); };
  document.addEventListener('keydown', (e)=>{
    if (left.lightbox.style.display === 'flex') {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft')  { e.preventDefault(); stepLightbox(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
    }
  });

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 45.9432, lng: 24.9668 }, // Romania center
    zoom: 6,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });
  info = new google.maps.InfoWindow();

  try {
    const res = await fetch(DATA_URL);
    const geo = await res.json();
    groups = groupByCoord(geo.features || []);
    markers = [];

    // plain markers (no cluster)
    for (const g of groups) {
      const m = new google.maps.Marker({ position: { lat: g.lat, lng: g.lng } });
      m.addListener('click', () => renderPopup(m, g, 0));
      markers.push(m);
    }
    markers.forEach(m=>m.setMap(map));

    // fixed center/zoom stays (no auto-fit)
    buildTOC(groups);
  } catch (e) {
    console.error('Failed to load data', e);
  }
};
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap" defer async></script>
</body>
</html>`;
}

/* === BUILD === */
(async () => {
  console.log("Listing Dropbox shared folder…");
  let dbx;
  try {
    dbx = await makeDbx();
  } catch (e) { console.error(e); process.exit(1); }

  const overrides = await loadOverrides();

  let entries;
  try {
    entries = await listAll(dbx);
  } catch (e) {
    if (e?.status === 401 && REFRESH && APP_KEY && APP_SECRET) {
      console.warn("Expired token; refreshing and retrying…");
      dbx = await makeDbx();
      entries = await listAll(dbx);
    } else {
      throw e;
    }
  }

  console.log(`Found ${entries.length} images.`);
  await fs.mkdir("site", { recursive: true });
  await fs.mkdir("site/thumbs", { recursive: true });

  let viaMedia=0, viaGuess=0, viaNom=0, thumbs=0, extLinks=0, skipped=0;
  const features = [];

  // geo reverse cache between builds
  const geocacheFile = "site/geocache.json";
  try {
    const text = await fs.readFile(geocacheFile, "utf8");
    const obj = JSON.parse(text); for (const k of Object.keys(obj)) geoCache.set(k, obj[k]);
  } catch {}

  for (const f of entries) {
    try {
      const key = baseKey(f.name);
      let lon=null, lat=null, when=null, source=null;

      // GPS from media_info (if present)
      const media = f.media_info?.metadata;
      if (media?.location) {
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media?.time_taken || null;
        if (lat!=null && lon!=null) { viaMedia++; source="media_info"; }
      }
      // Fallback: guess from filename
      if (lat==null || lon==null) {
        const g = guessFromFilename(f.name);
        if (g){ [lon,lat]=g; viaGuess++; source = source || "filename"; }
      }
      if (lat==null || lon==null) { skipped++; continue; }

      // Optional reverse-geocode to nice place title
      let placeInfo = null;
      if (ENABLE_NOMINATIM) {
        placeInfo = await reverseGeocode(lat, lon);
        if (placeInfo) viaNom++;
      }

      // Base titles/blurb
      const autoBaseTitle  = titleFromFilename(f.name);
      const autoPlaceTitle = placeInfo?.niceTitle || autoBaseTitle;
      const autoBlurb      = makeBlurb(autoPlaceTitle, placeInfo?.components);

      // content.json overrides by exact filename or pattern
      const ovFromName    = overrides.byName.get(key) || null;
      const ovFromPattern = overrides.patterns.find(p => p.re.test(key))?.data || null;
      const cuprinsTitle  = (ovFromName?.title || ovFromPattern?.title || "").trim();
      const cuprinsDesc   = (ovFromName?.description || ovFromPattern?.description || "").trim();

      // links
      const { pageUrl, rawUrl } = await filePageAndRaw(dbx, f.path_lower);

      // thumbnail (local)
      let thumbRel = null;
      try {
        const buf = await fetchThumbViaSharedLink(dbx, f.path_lower);
        const name = "t-" + md5(f.path_lower) + ".jpg";
        await fs.writeFile(path.join("site/thumbs", name), buf);
        thumbRel = "thumbs/" + name;
        thumbs++;
      } catch {}
      if (!thumbRel) {
        try {
          const buf2 = await fetchThumbViaIdOrPath(dbx, f.path_lower || f.id);
          const name2 = "t-" + md5(f.id || f.path_lower) + ".jpg";
          await fs.writeFile(path.join("site/thumbs", name2), buf2);
          thumbRel = "thumbs/" + name2;
          thumbs++;
        } catch {}
      }
      let thumbExternal = null;
      if (!thumbRel && rawUrl) { thumbExternal = rawUrl; extLinks++; }

      features.push({
        type: "Feature",
        properties: {
          title: esc(autoBaseTitle),
          place_title: esc(autoPlaceTitle),
          blurb: esc(autoBlurb),
          cuprins_title: esc(cuprinsTitle),
          cuprins_desc: esc(cuprinsDesc),
          taken_at: when,
          source,
          original_page: pageUrl,
          thumb: thumbRel,
          thumb_external: thumbExternal,
          full_external: rawUrl
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });

    } catch {
      skipped++;
    }
  }

  // save geo reverse cache
  const cacheObj = {}; for (const [k,v] of geoCache.entries()) cacheObj[k]=v;
  await fs.writeFile("site/geocache.json", JSON.stringify(cacheObj, null, 2), "utf8");

  // outputs
  const geo = { type: "FeatureCollection", features };
  await fs.writeFile("site/locations.json", JSON.stringify(geo, null, 2), "utf8");
  const html = htmlTemplate({ dataUrl: "locations.json", apiKey: GMAPS_API_KEY });
  await fs.writeFile("site/index.html", html, "utf8");

  console.log(`Wrote ${features.length} features -> site/locations.json`);
  console.log(`  from EXIF media_info: ${viaMedia}`);
  console.log(`  from filename guess:  ${viaGuess}`);
  if (ENABLE_NOMINATIM) console.log(`  reverse geocode:     ${viaNom}`);
  console.log(`  local thumbs:        ${thumbs}`);
  console.log(`  external images:     ${extLinks}`);
  console.log(`  skipped (no coords): ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
