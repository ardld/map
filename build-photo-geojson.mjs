import { Dropbox } from "dropbox";
import fetch from "node-fetch";
import { exiftool } from "exiftool-vendored";
import fs from "fs/promises";

// ====== CONFIG via env ======
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const SHARED_URL = process.env.DROPBOX_SHARED_URL;
const DISABLE_EXIF = process.env.DISABLE_EXIF === "1";
const ENABLE_FILENAME_GEOCODE = process.env.ENABLE_FILENAME_GEOCODE === "1";

if (!DROPBOX_TOKEN) throw new Error("Missing env DROPBOX_TOKEN");
if (!SHARED_URL) throw new Error("Missing env DROPBOX_SHARED_URL");

const OUTPUT_FILE = "public/photos.geojson";
const OVERRIDES_FILE = "public/overrides.json";

const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch });

const IMAGE_EXTS = [".jpg",".jpeg",".png",".webp",".tif",".tiff",".heic",".heif"];
function isImage(name = "") {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some(ext => n.endsWith(ext));
}

function toRaw(sharedUrl) {
  const u = new URL(sharedUrl);
  u.searchParams.set("raw", "1");
  u.searchParams.delete("dl");
  return u.toString();
}

async function ensureSharedLink(pathLower) {
  const list = await dbx.sharingListSharedLinks({ path: pathLower, direct_only: true });
  if (list?.links?.length) return toRaw(list.links[0].url);
  const created = await dbx.sharingCreateSharedLinkWithSettings({ path: pathLower });
  return toRaw(created.url);
}

async function downloadViaSharedLink(sharedFolderUrl, subpathLower) {
  const r = await dbx.sharingGetSharedLinkFile({ url: sharedFolderUrl, path: subpathLower });
  const buf = Buffer.from(r.fileBinary, "binary");
  return buf;
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
    const res = await dbx.filesListFolder({
      path: folder,
      shared_link,
      include_media_info: true
    });

    for (const e of res.entries) {
      if (e[".tag"] === "folder") {
        folders.push(e.path_lower);
      } else if (e[".tag"] === "file" && isImage(e.name)) {
        files.push(e);
      }
    }

    let cursor = res.cursor;
    while (res.has_more) {
      const more = await dbx.filesListFolderContinue({ cursor });
      for (const e of more.entries) {
        if (e[".tag"] === "folder") {
          folders.push(e.path_lower);
        } else if (e[".tag"] === "file" && isImage(e.name)) {
          files.push(e);
        }
      }
      cursor = more.cursor;
      if (!more.has_more) break;
    }
  }

  return files;
}

function baseNameNoExt(n = "") {
  return n.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").trim();
}

(async () => {
  console.log("Listing shared folder tree…");
  const entries = await listSharedTree(SHARED_URL);
  console.log(`Found ${entries.length} image files.`);

  const overrides = await loadOverrides();

  const features = [];
  let skipped = 0;

  for (const f of entries) {
    try {
      let lat = null, lon = null, when = null;

      const media = f.media_info?.metadata;
      if (media?.location) {
        lat = media.location?.latitude ?? null;
        lon = media.location?.longitude ?? null;
        when = media.time_taken || null;
      }

      if (lat == null || lon == null) {
        const buf = await downloadViaSharedLink(SHARED_URL, f.path_lower);
        const exif = await getExifGPS(buf);
        if (exif) {
          lat = exif.lat; lon = exif.lon; when = when || exif.when;
        }
      }

      const ov = overrides[f.path_display];
      if (ov && typeof ov.lat === "number" && typeof ov.lon === "number") {
        lat = ov.lat; lon = ov.lon;
      }

      if ((lat == null || lon == null) && ENABLE_FILENAME_GEOCODE) {
        const guess = await geocodeName(baseNameNoExt(f.name));
        if (guess) { lat = guess.lat; lon = guess.lon; }
      }

      if (lat == null || lon == null) {
        skipped++;
        continue;
      }

      const url = await ensureSharedLink(f.path_lower);

      features.push({
        type: "Feature",
        properties: {
          title: f.name,
          dropbox_path: f.path_display,
          url,
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
  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(geo, null, 2), "utf8");
  console.log(`Wrote ${features.length} features → ${OUTPUT_FILE} (skipped ${skipped})`);

  if (!DISABLE_EXIF) await exiftool.end();
})().catch(async (e) => {
  console.error(e);
  if (!DISABLE_EXIF) await exiftool.end();
  process.exit(1);
});
