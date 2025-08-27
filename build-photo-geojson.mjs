import { Dropbox } from "dropbox";
import fetch from "node-fetch";
import { exiftool } from "exiftool-vendored";
import Jimp from "jimp";
import fs from "fs/promises";
import path from "path";

// ===== Env/config =====
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const SHARED_URL = process.env.DROPBOX_SHARED_URL;
const DISABLE_EXIF = process.env.DISABLE_EXIF === "1";
const ENABLE_FILENAME_GEOCODE = process.env.ENABLE_FILENAME_GEOCODE === "1";
const THUMB_MAX_WIDTH = parseInt(process.env.THUMB_MAX_WIDTH || "1024", 10);

if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

const OUTPUT_FILE = "public/photos.geojson";
const OVERRIDES_FILE = "public/overrides.json";
const THUMBS_DIR = "public/thumbs";

const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name = "") {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some(ext => n.endsWith(ext));
}

function toRaw(u) {
  const url = new URL(u);
  url.searchParams.set("raw", "1");  // forces file bytes
  url.searchParams.delete("dl");
  return url.toString();
}

async function getPerFileSharedLink(sharedFolderUrl, subpathLower) {
  // Ask Dropbox to give us the file-level link relative to the folder shared link
  const meta = await dbx.sharingGetSharedLinkMetadata({ url: sharedFolderUrl, path: subpathLower });
  const link = meta.result?.url;
  if (!link) throw new Error("No per-file shared link returned");
  return toRaw(link);
}

async function fetchBytes(rawUrl) {
  const res = await fetch(rawUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function getExifGPS(buf) {
  if (DISABLE_EXIF) return null;
  try {
    const meta = await exiftool.read(buf);
    if (meta.GPSLatitude && meta.GPSLongitude) {
      const when = meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate || null;
      return { lat: meta.GPSLatitude, lon: meta.GPSLongitude, when };
    }
  } catch (_) {}
  return null;
}

async function geocodeName(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": "RealRomania-PhotoMap/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data) && data.length) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return null;
}

async function loadOverrides() {
  try {
    const raw = await fs.readFile(OVERRIDES_FILE, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function listSharedTree(sharedUrl) {
  const shared_link = { url: sharedUrl };
  const files = [];
  const folders = [""];

  while (folders.length) {
    const folder = folders.shift();

    let res = await dbx.filesListFolder({
      path: folder,
      shared_link,
      include_media_info: true
    });
    let data = res.result;

    for (const e of data.entries) {
      if (e[".tag"] === "folder") {
        folders.push(e.path_lower);
      } else if (e[".tag"] === "file" && isImage(e.name)) {
        files.push(e);
      }
    }

    while (data.has_more) {
      const more = await dbx.filesListFolderContinue({ cursor: data.cursor });
      const md = more.result;
      for (const e of md.entries) {
        if (e[".tag"] === "folder") {
          folders.push(e.path_lower);
        } else if (e[".tag"] === "file" && isImage(e.name)) {
          files.push(e);
        }
      }
      data = md;
    }
  }

  return files;
}

function baseNameNoExt(n = "") {
  return n.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").trim();
}
function safeFileName(n = "") {
  return n.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

(async () => {
  console.log("Listing shared folder tree…");
  const entries = await listSharedTree(SHARED_URL);
  console.log(`Found ${entries.length} image files.`);

  await fs.mkdir("public", { recursive: true });
  await fs.mkdir(THUMBS_DIR, { recursive: true });

  const overrides = await loadOverrides();

  const features = [];
  let skipped = 0;

  for (const f of entries) {
    try {
      let lat = null, lon = null, when = null;

      // Use Dropbox's own parsed media_info when present
      const media = f.media_info?.metadata;
      if (media?.location) {
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media.time_taken || null;
      }

      // Get a public per-file link and download bytes from there
      const rawUrl = await getPerFileSharedLink(SHARED_URL, f.path_lower);
      const buf = await fetchBytes(rawUrl);

      // EXIF fallback for GPS/time
      if (lat == null || lon == null) {
        const exif = await getExifGPS(buf);
        if (exif) {
          lat = exif.lat; lon = exif.lon; when = when || exif.when;
        }
      }

      // Manual overrides
      const ov = overrides[f.path_display];
      if (ov && typeof ov.lat === "number" && typeof ov.lon === "number") {
        lat = ov.lat; lon = ov.lon;
      }

      // Last-ditch filename geocode
      if ((lat == null || lon == null) && ENABLE_FILENAME_GEOCODE) {
        const guess = await geocodeName(baseNameNoExt(f.name));
        if (guess) { lat = guess.lat; lon = guess.lon; }
      }

      if (lat == null || lon == null) {
        skipped++;
        continue;
      }

      // Make a thumbnail to serve from Vercel (fast popups, no hotlinking)
      const thumbName = safeFileName(f.name.replace(/\.[^.]+$/, "")) + ".jpg";
      const thumbPath = path.join(THUMBS_DIR, thumbName);

      const image = await Jimp.read(buf);
      if (image.getWidth() > THUMB_MAX_WIDTH) {
        image.resize({ w: THUMB_MAX_WIDTH });
      }
      await image.quality(82).writeAsync(thumbPath);

      features.push({
        type: "Feature",
        properties: {
          title: f.name,
          dropbox_path: f.path_display,
          url: `/thumbs/${thumbName}`,      // served by Vercel
          original: rawUrl,                  // optional: original Dropbox link
          taken_at: when
        },
        geometry: { type: "Point", coordinates: [lon, lat] }
      });

    } catch (err) {
      console.warn("Skip due to error:", f?.name, err?.message);
      skipped++;
    }
  }

  const geo = { type: "FeatureCollection", features };
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(geo, null, 2), "utf8");
  console.log(`Wrote ${features.length} features → ${OUTPUT_FILE} (skipped ${skipped})`);

  if (!DISABLE_EXIF) await exiftool.end();
})().catch(async (e) => {
  console.error(e);
  if (!DISABLE_EXIF) await exiftool.end();
  process.exit(1);
});
