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
  return candidates.length ? GAZ
