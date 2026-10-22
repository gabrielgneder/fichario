/* Fichário de Receitas — app local-first com cópia no Google Drive.
 * Dados: IndexedDB no aparelho (fonte principal) + um arquivo JSON no Drive da usuária (escopo drive.file).
 * Sincronização: mescla por receita usando updatedAt; exclusões viram "lápides" para não ressuscitar receitas. */
"use strict";

const APP_VERSION = "1.4.1";
const CFG = Object.assign({ GOOGLE_CLIENT_ID: "", DRIVE_FILE_NAME: "Fichário de Receitas (dados).json" }, window.FICHARIO_CONFIG || {});
const DRIVE_ON = !!CFG.GOOGLE_CLIENT_ID;
const SCOPES = "openid email https://www.googleapis.com/auth/drive.file";

const DEFAULT_CATS = [
  { id: "doce", name: "Doce", color: "k1" },
  { id: "lanche", name: "Lanche", color: "k2" },
  { id: "refeicao", name: "Refeição", color: "k3" },
  { id: "fitness", name: "Fitness", color: "k4" },
  { id: "bebida", name: "Bebida", color: "k6" },
];
const COLORS = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"];

/* ======================= armazenamento local ======================= */
const Store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const req = indexedDB.open("fichario", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
  const tx = async (mode, fn, store = "kv") => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    async get(k) { try { return await tx("readonly", s => s.get(k)); } catch (e) { try { return JSON.parse(localStorage.getItem("fichario." + k)); } catch (_) { return undefined; } } },
    async set(k, v) { try { await tx("readwrite", s => s.put(v, k)); } catch (e) { localStorage.setItem("fichario." + k, JSON.stringify(v)); } },
    // fotos (Blob) — só em IndexedDB
    photoGet(id) { return tx("readonly", s => s.get(id), "photos").catch(() => undefined); },
    photoPut(id, blob) { return tx("readwrite", s => s.put(blob, id), "photos"); },
    photoDel(id) { return tx("readwrite", s => s.delete(id), "photos").catch(() => {}); },
  };
})();

const emptyData = () => ({ v: 1, recipes: {}, cats: { list: DEFAULT_CATS, updatedAt: 0 } });
let data = emptyData();
let meta = { fileId: null, email: null, lastSync: 0, dirty: false, photoFolderId: null, driveTrash: [] };

const UI = { q: "", mode: "all", view: "home", cat: "", loaded: false };
const live = () => Object.values(data.recipes).filter(r => !r.deleted);
const cats = () => data.cats.list;

async function persist() {
  meta.dirty = true;
  await Store.set("data", data);
  await Store.set("meta", meta);
  render();
  scheduleSync();
}
async function saveMeta() { await Store.set("meta", meta); }

function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }

async function upsertRecipe(rec) { data.recipes[rec.id] = rec; await persist(); }
async function removeRecipe(id) {
  const r = data.recipes[id];
  if (r && r.photos) await discardPhotos(r.photos);
  data.recipes[id] = { id, deleted: true, updatedAt: Date.now() }; await persist();
}

/* ======================= fotos ======================= */
const photoUrls = new Map(); // id -> object URL (cache da sessão)
async function compressImage(file, max = 1600, quality = 0.82) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
  const w0 = bmp.width, h0 = bmp.height, k = Math.min(1, max / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", quality));
  if (!blob) throw new Error("falha ao converter");
  return { blob, w, h };
}
async function photoURL(p) {
  if (photoUrls.has(p.id)) return photoUrls.get(p.id);
  let blob = await Store.photoGet(p.id);
  if (!blob && p.driveId && Token.get()) {
    try { const r = await gfetch(`${DRIVE}/${encodeURIComponent(p.driveId)}?alt=media`); if (r.ok) { blob = await r.blob(); await Store.photoPut(p.id, blob); } } catch (e) {}
  }
  if (!blob) return null;
  const url = URL.createObjectURL(blob); photoUrls.set(p.id, url); return url;
}
async function discardPhotos(list) {
  for (const p of list) {
    await Store.photoDel(p.id);
    if (photoUrls.has(p.id)) { URL.revokeObjectURL(photoUrls.get(p.id)); photoUrls.delete(p.id); }
    if (p.driveId) meta.driveTrash = [...(meta.driveTrash || []), p.driveId];
  }
}
// preenche as <img data-photo> de um trecho da tela
function hydratePhotos(root, rec) {
  root.querySelectorAll("[data-photo]").forEach(async el => {
    const p = (rec.photos || []).find(x => x.id === el.dataset.photo) || (el._photo);
    if (!p) return;
    const url = await photoURL(p);
    const img = el.querySelector("img");
    if (url && img) { img.src = url; el.classList.remove("missing"); }
    else el.classList.add("missing");
  });
}
async function setCats(list) { data.cats = { list, updatedAt: Date.now() }; await persist(); }

/* ======================= mesclagem ======================= */
function mergeData(local, remote) {
  const out = { v: 1, recipes: {}, cats: local.cats };
  let remoteStale = false, localChanged = false;
  const ids = new Set([...Object.keys(local.recipes), ...Object.keys(remote.recipes)]);
  ids.forEach(id => {
    const a = local.recipes[id], b = remote.recipes[id];
    if (a && b) {
      if ((b.updatedAt || 0) > (a.updatedAt || 0)) { out.recipes[id] = b; localChanged = true; }
      else { out.recipes[id] = a; if ((a.updatedAt || 0) > (b.updatedAt || 0)) remoteStale = true; }
    } else if (a) { out.recipes[id] = a; remoteStale = true; }
    else { out.recipes[id] = b; localChanged = true; }
  });
  if ((remote.cats.updatedAt || 0) > (local.cats.updatedAt || 0)) { out.cats = remote.cats; localChanged = true; }
  else if ((local.cats.updatedAt || 0) > (remote.cats.updatedAt || 0)) remoteStale = true;
  return { data: out, remoteStale, localChanged };
}
function toFile(d) {
  return JSON.stringify({ app: "fichario-receitas", v: 1, savedAt: new Date().toISOString(), cats: d.cats, recipes: Object.values(d.recipes) }, null, 1);
}
function fromFile(text) {
  const j = JSON.parse(text);
  if (!j || j.app !== "fichario-receitas" || !Array.isArray(j.recipes)) throw new Error("formato");
  const d = emptyData();
  j.recipes.forEach(r => { if (r && r.id) d.recipes[r.id] = r; });
  if (j.cats && Array.isArray(j.cats.list) && j.cats.list.length) d.cats = j.cats;
  return d;
}

/* ======================= Google: login por redirecionamento ======================= */
const baseUrl = () => new URL(".", location.href).href;
const Token = {
  get() { try { const t = JSON.parse(localStorage.getItem("fichario.token")); return t && t.exp > Date.now() ? t.access_token : null; } catch (e) { return null; } },
  set(tok, secs) { localStorage.setItem("fichario.token", JSON.stringify({ access_token: tok, exp: Date.now() + (Number(secs) || 3600) * 1000 - 60000 })); },
  clear() { localStorage.removeItem("fichario.token"); },
};
function googleLogin() {
  if (!DRIVE_ON) return;
  const state = uid();
  localStorage.setItem("fichario.oauthState", state);
  const p = new URLSearchParams({
    client_id: CFG.GOOGLE_CLIENT_ID, redirect_uri: baseUrl(), response_type: "token",
    scope: SCOPES, state, include_granted_scopes: "true",
  });
  if (meta.email) p.set("login_hint", meta.email);
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString());
}
function handleOAuthReturn() {
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has("access_token") && !p.has("error")) return null;
  const expected = localStorage.getItem("fichario.oauthState");
  localStorage.removeItem("fichario.oauthState");
  history.replaceState(null, "", baseUrl());
  if (p.get("error")) return p.get("error") === "access_denied" ? "Conexão com o Google cancelada." : "O Google recusou a conexão. Tente de novo.";
  if (!expected || p.get("state") !== expected) return "Não foi possível confirmar o login. Tente conectar de novo.";
  const granted = (p.get("scope") || "");
  if (!granted.includes("drive.file")) return "Para guardar no Drive, marque a permissão de acesso ao Drive na tela do Google.";
  Token.set(p.get("access_token"), p.get("expires_in"));
  return "ok";
}

class AuthError extends Error {}
async function gfetch(url, opts = {}) {
  const tok = Token.get();
  if (!tok) throw new AuthError("sem token");
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + tok } });
  if (res.status === 401) { Token.clear(); throw new AuthError("expirado"); }
  return res;
}
async function fetchEmail() {
  try { const r = await gfetch("https://openidconnect.googleapis.com/v1/userinfo"); if (r.ok) { const j = await r.json(); if (j.email) { meta.email = j.email; await saveMeta(); } } } catch (e) {}
}

/* ======================= Drive ======================= */
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

async function findFile() {
  if (meta.fileId) {
    const r = await gfetch(`${DRIVE}/${encodeURIComponent(meta.fileId)}?fields=id,trashed`);
    if (r.ok) { const j = await r.json(); if (!j.trashed) return j.id; }
    else if (r.status !== 404) throw new Error("drive " + r.status);
    meta.fileId = null;
  }
  const q = `name='${CFG.DRIVE_FILE_NAME.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed=false`;
  const r = await gfetch(`${DRIVE}?q=${encodeURIComponent(q)}&spaces=drive&orderBy=modifiedTime desc&pageSize=1&fields=files(id)`);
  if (!r.ok) throw new Error("drive " + r.status);
  const j = await r.json();
  return j.files && j.files[0] ? j.files[0].id : null;
}
async function downloadFile(id) {
  const r = await gfetch(`${DRIVE}/${encodeURIComponent(id)}?alt=media`);
  if (!r.ok) throw new Error("drive " + r.status);
  return r.text();
}
async function createFile(content) {
  const b = "fichario" + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: CFG.DRIVE_FILE_NAME, mimeType: "application/json", description: "Receitas do app Fichário de Receitas. Não apague: é a cópia de segurança." }) +
    `\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
  const r = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  if (!r.ok) throw new Error("drive " + r.status);
  return (await r.json()).id;
}
async function updateFile(id, content) {
  const r = await gfetch(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: content });
  if (!r.ok) throw new Error("drive " + r.status);
}

async function ensurePhotoFolder() {
  if (meta.photoFolderId) {
    const r = await gfetch(`${DRIVE}/${encodeURIComponent(meta.photoFolderId)}?fields=id,trashed`);
    if (r.ok && !(await r.json()).trashed) return meta.photoFolderId;
  }
  const r = await gfetch(`${DRIVE}?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Fichário de Receitas — fotos", mimeType: "application/vnd.google-apps.folder" }) });
  if (!r.ok) throw new Error("drive " + r.status);
  meta.photoFolderId = (await r.json()).id; await saveMeta();
  return meta.photoFolderId;
}
async function uploadPhoto(blob, name, folder) {
  const b = "fichario" + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, parents: [folder], mimeType: "image/jpeg" }),
    `\r\n--${b}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  if (!r.ok) throw new Error("drive " + r.status);
  return (await r.json()).id;
}
async function syncPhotos() {
  // envia fotos novas
  const pending = live().flatMap(r => (r.photos || []).filter(p => !p.driveId).map(p => [r, p]));
  if (pending.length) {
    const folder = await ensurePhotoFolder();
    const touched = new Set();
    for (const [r, p] of pending) {
      const blob = await Store.photoGet(p.id); if (!blob) continue;
      p.driveId = await uploadPhoto(blob, `${r.title.slice(0, 60)} - ${p.id.slice(0, 8)}.jpg`, folder);
      touched.add(r.id);
    }
    touched.forEach(id => { data.recipes[id] = { ...data.recipes[id], updatedAt: Date.now() }; });
    await Store.set("data", data);
  }
  // manda para a lixeira do Drive as fotos apagadas
  const trash = [...new Set(meta.driveTrash || [])];
  for (const fid of trash) {
    try { const r = await gfetch(`${DRIVE}/${encodeURIComponent(fid)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
      if (r.ok || r.status === 404) meta.driveTrash = meta.driveTrash.filter(x => x !== fid); } catch (e) { if (e instanceof AuthError) throw e; }
  }
  await saveMeta();
}

let syncing = false, syncAgain = false, syncTimer = null;
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }

async function sync({ manual = false } = {}) {
  if (!DRIVE_ON) return setSync();
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setSync(); if (manual) toast("Sem internet. As receitas estão salvas no celular."); return; }
  if (!Token.get()) { setSync(); if (manual) googleLogin(); return; }
  syncing = true; setSync("busy");
  try {
    const id = await findFile();
    let remote = null;
    if (id) { try { remote = fromFile(await downloadFile(id)); } catch (e) { if (e instanceof AuthError) throw e; remote = null; } }
    let remoteStale = true;
    if (remote) {
      const m = mergeData(data, remote);
      remoteStale = m.remoteStale;
      if (m.localChanged) { data = m.data; await Store.set("data", data); }
    }
    await syncPhotos();
    if (!id) meta.fileId = await createFile(toFile(data));
    else { meta.fileId = id; if (remoteStale || meta.dirty) await updateFile(id, toFile(data)); }
    meta.dirty = false; meta.lastSync = Date.now();
    await saveMeta();
    if (!meta.email) fetchEmail();
    render();
    syncing = false; setSync();
    if (manual) toast("Receitas salvas no Drive");
  } catch (e) {
    syncing = false;
    if (e instanceof AuthError) { setSync(); if (manual) googleLogin(); }
    else { setSync("error"); if (manual) toast("Não deu para falar com o Drive agora. Tente de novo em instantes."); }
  }
  if (syncAgain) { syncAgain = false; scheduleSync(300); }
}

function setSync(force) {
  const el = $("#sync");
  if (!DRIVE_ON) { el.hidden = true; return; }
  el.hidden = false;
  const connected = !!meta.lastSync || !!meta.email;
  let st, label;
  if (force === "busy") { st = "busy"; label = "Salvando no Drive…"; }
  else if (force === "error") { st = "error"; label = "Erro no Drive · tentar de novo"; }
  else if (!connected) { st = "login"; label = "Conectar Drive"; }
  else if (meta.dirty && !navigator.onLine) { st = "pending"; label = "Sem internet · salvo no celular"; }
  else if (meta.dirty) { st = "pending"; label = Token.get() ? "Salvando…" : "Toque para salvar no Drive"; }
  else { st = "ok"; label = "No Drive · " + whenText(meta.lastSync); }
  el.dataset.state = st; el.textContent = label;
}
function whenText(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + hm;
}

/* ======================= utilidades de interface ======================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const lines = s => String(s || "").split("\n").map(x => x.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
const catOf = id => cats().find(c => c.id === id) || { id, name: "Sem categoria", color: "k8" };
const kstyle = c => `--kbg:var(--${c.color}-bg);--kfg:var(--${c.color});--ka:var(--${c.color}-a);--kb:var(--${c.color}-b)`;
const fmtTime = m => !m ? "" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, "0") : ""}`;
const safeUrl = u => /^https?:\/\/\S+$/i.test((u || "").trim()) ? u.trim() : "";
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function toast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

/* ======================= ícones ======================= */
const ico = (id, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const CAT_ICONS = ["c-cake", "c-sandwich", "c-plate", "c-dumbbell", "c-cup", "c-salad", "c-soup", "c-bread", "c-book"];
const ICON_BY_ID = { doce: "c-cake", lanche: "c-sandwich", refeicao: "c-plate", fitness: "c-dumbbell", bebida: "c-cup" };
const catIcon = c => (c && c.icon) || ICON_BY_ID[c && c.id] || "c-book";

/* ======================= busca ======================= */
function matches(r) {
  const q = norm(UI.q); if (!q) return true;
  if (UI.mode === "have") {
    const want = q.split(",").map(s => s.trim()).filter(Boolean);
    const ing = norm((r.ingredients || []).join(" | "));
    return want.every(w => ing.includes(w));
  }
  const terms = q.split(/\s+/).filter(Boolean);
  const hay = UI.mode === "name" ? norm(r.title) : norm([r.title, (r.ingredients || []).join(" "), (r.tags || []).join(" "), catOf(r.category).name, r.notes].join(" "));
  return terms.every(t => hay.includes(t));
}
function searchTerms() {
  const q = norm(UI.q); if (!q) return [];
  return (UI.mode === "have" ? q.split(",") : q.split(/\s+/)).map(s => s.trim()).filter(t => t.length > 1);
}
function hl(text) {
  const raw = String(text ?? "").normalize("NFC");
  const terms = searchTerms(); if (!terms.length) return esc(raw);
  const n = norm(raw); if (n.length !== raw.length) return esc(raw);
  const marks = new Array(raw.length).fill(false);
  terms.forEach(t => { let i = n.indexOf(t); while (i > -1) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = n.indexOf(t, i + 1); } });
  let out = "", on = false;
  for (let i = 0; i < raw.length; i++) { if (marks[i] !== on) { out += on ? "</mark>" : "<mark>"; on = marks[i]; } out += esc(raw[i]); }
  return out + (on ? "</mark>" : "");
}

/* ======================= telas ======================= */
function cardHTML(r, withCat) {
  const c = catOf(r.category);
  const ing = r.ingredients || [];
  const terms = UI.mode !== "name" ? searchTerms() : [];
  const hits = terms.length ? ing.filter(i => terms.some(t => norm(i).includes(t))).slice(0, 2) : [];
  const meta = [
    r.timeMin && `<span>${ico("i-clock", "sm")}${fmtTime(r.timeMin)}</span>`,
    r.calories && `<span>${ico("i-flame", "sm")}${r.calories} kcal</span>`,
    (r.photos || []).length && `<span>${ico("i-camera", "sm")}${r.photos.length}</span>`,
  ].filter(Boolean).join("");
  return `<button class="card" data-id="${esc(r.id)}" style="${kstyle(c)}">
    <div class="cover"><span class="deco" aria-hidden="true"></span>${ico(catIcon(c))}
      ${r.fav ? `<span class="star" aria-label="Favorita">${ico("i-star")}</span>` : ""}
      ${withCat ? `<span class="cat">${esc(c.name)}</span>` : ""}</div>
    <div class="card-body">
      <h3>${hl(r.title)}</h3>
      ${hits.length ? `<div class="hits">${hits.map(hl).join(" · ")}</div>` : meta ? `<div class="meta">${meta}</div>` : `<div class="meta"><span>${ing.length} ingrediente${ing.length === 1 ? "" : "s"}</span></div>`}
    </div>
  </button>`;
}

function renderChips() {
  const all = live();
  const counts = {}; all.forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  const used = cats().filter(c => counts[c.id] || UI.cat === c.id);
  const el = $("#catchips");
  el.hidden = !UI.cat || used.length < 2;
  el.innerHTML = `<button class="chip" data-chip="" aria-pressed="${!UI.cat}">Todas</button>` +
    used.map(c => `<button class="chip" data-chip="${esc(c.id)}" style="${kstyle(c)}" aria-pressed="${UI.cat === c.id}"><span class="dot"></span>${esc(c.name)}</button>`).join("");
}

function render() {
  if (!UI.loaded) return;
  const main = $("#main");
  const all = live();
  const favView = UI.view === "fav";
  $("#view-title").textContent = favView ? "Favoritas" : UI.cat ? catOf(UI.cat).name : "Minhas receitas";
  document.body.dataset.screen = UI.cat ? "cat" : favView ? "fav" : "home";
  document.body.setAttribute("style", UI.cat ? kstyle(catOf(UI.cat)) : "");
  $("#back").hidden = !UI.cat;
  const nShown = UI.cat ? all.filter(r => r.category === UI.cat).length : favView ? all.filter(r => r.fav).length : all.length;
  $("#count").textContent = `${nShown} ${nShown === 1 ? "receita" : "receitas"}${UI.cat || favView ? "" : nShown === 1 ? " guardada" : " guardadas"}`;
  document.querySelectorAll(".tab[data-view]").forEach(t => t.dataset.view === UI.view ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"));
  $("#q-clear").hidden = !UI.q;
  setSync(syncing ? "busy" : undefined);
  renderChips();

  if (!all.length) {
    main.innerHTML = `<div class="state"><div class="ic-tile">${ico("c-book", "lg")}</div><h2>Seu fichário está vazio</h2>
      <p>Toque no <b>+</b> lá embaixo para guardar a primeira receita.</p>
      ${DRIVE_ON && !meta.lastSync ? `<p class="small">Já usava o app em outro celular? Vá em <b>Ajustes</b> e conecte o Google Drive para trazer suas receitas.</p>` : ""}</div>`;
    return;
  }

  let list = all;
  if (favView) list = list.filter(r => r.fav);
  if (UI.cat) list = list.filter(r => r.category === UI.cat);
  const searching = !!UI.q.trim();
  if (searching) list = list.filter(matches);

  if (searching || favView || UI.cat) {
    list.sort((a, b) => searching ? a.title.localeCompare(b.title, "pt") : (b.updatedAt || 0) - (a.updatedAt || 0));
    const head = searching ? (list.length ? `${list.length} encontrada${list.length > 1 ? "s" : ""}` : "") : "";
    let empty;
    if (searching) empty = UI.mode === "have" ? "Nenhuma receita usa todos esses ingredientes. Tente tirar um." : "Nada encontrado. Tente outra palavra ou troque para “Tudo”.";
    else if (favView) empty = "Nenhuma favorita ainda. Abra uma receita e toque na estrela.";
    else empty = "Nenhuma receita nesta categoria ainda.";
    main.innerHTML = (head ? `<div class="results-head"><h2>${head}</h2></div>` : "") +
      (list.length ? `<div class="grid">${list.map(r => cardHTML(r, !UI.cat)).join("")}</div>`
        : `<div class="state"><div class="ic-tile">${ico(favView && !searching ? "i-star" : "i-search", "lg")}</div><p>${empty}</p>
           ${UI.cat && !searching ? `<button class="btn primary" data-addcat="${esc(UI.cat)}">${ico("i-plus")}Adicionar receita</button>` : ""}</div>`);
    return;
  }

  // Início: só as categorias, em barras coloridas. As receitas aparecem ao tocar na barra.
  const counts = {};
  all.forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  const orphan = Object.keys(counts).filter(id => !cats().some(c => c.id === id)).map(catOf);
  main.innerHTML = `<div class="bars">${[...cats(), ...orphan].map(c => {
    const n = counts[c.id] || 0;
    return `<button class="catbar" data-chip="${esc(c.id)}" style="${kstyle(c)}">
      <span class="ic-tile">${ico(catIcon(c), "lg")}</span>
      <span class="grow"><span class="name">${esc(c.name)}</span><span class="n">${n ? `${n} receita${n === 1 ? "" : "s"}` : "Nenhuma receita ainda"}</span></span>
      <span class="go">${ico("i-chev")}</span>
      <span class="wm" aria-hidden="true">${ico(catIcon(c))}</span>
    </button>`;
  }).join("")}</div>`;
}

/* painel deslizante */
let lastFocus = null, ignorePop = false, pendingPush = false;
function openSheet(title, bodyHTML, onMount, { hideHead = false } = {}) {
  lastFocus = document.activeElement;
  $("#layer").innerHTML = `<div class="scrim" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${hideHead ? "" : `<div class="sheet-head"><h2>${esc(title)}</h2>
        <button class="iconbtn" data-close aria-label="Fechar">${ico("i-x")}</button></div>`}
      <div class="sheet-body">${bodyHTML}</div></div>`;
  document.body.style.overflow = "hidden"; document.body.classList.add("sheet-open");
  if (ignorePop) pendingPush = true; else history.pushState({ sheet: 1 }, "");
  onMount && onMount($(".sheet"));
}
let onSheetClose = null;
function closeSheet(fromPop) {
  if (!$("#layer").innerHTML) return;
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
  $("#layer").innerHTML = ""; document.body.style.overflow = ""; document.body.classList.remove("sheet-open");
  if (!fromPop && history.state && history.state.sheet) { ignorePop = true; history.back(); }
  lastFocus && lastFocus.focus && lastFocus.focus({ preventScroll: true });
}
addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; if (pendingPush) { pendingPush = false; history.pushState({ sheet: 1 }, ""); } return; }
  if ($("#lightbox")) { closeLightbox(true); return; }
  if ($("#layer").innerHTML) { closeSheet(true); return; }
  if (UI.cat) { UI.cat = ""; render(); scrollTo({ top: 0 }); }
});
function openCat(id) {
  if (!id) return closeCat();
  if (!UI.cat) history.pushState({ cat: 1 }, "");
  UI.cat = id; render(); scrollTo({ top: 0 });
}
function closeCat() {
  if (!UI.cat) return;
  if (history.state && history.state.cat) history.back();
  else { UI.cat = ""; render(); }
}
document.addEventListener("keydown", e => { if (e.key === "Escape") { if ($("#lightbox")) closeLightbox(); else closeSheet(); } });

/* álbum: visualização em tela cheia */
function openLightbox(rec, start) {
  const photos = rec.photos || []; if (!photos.length) return;
  let i = start;
  const lb = document.createElement("div");
  lb.id = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "Álbum de fotos");
  lb.innerHTML = `<div class="lb-top"><span class="lb-count" aria-live="polite"></span>
      <button class="lb-btn" data-lb="close" aria-label="Fechar álbum">${ico("i-x")}</button></div>
    <div class="lb-stage"><img alt=""><p class="lb-missing" hidden>Foto guardada no Drive. Conecte o Drive em Ajustes para ver.</p></div>
    <div class="lb-bottom"><button class="lb-btn" data-lb="prev" aria-label="Foto anterior">${ico("i-back")}</button>
      <p class="lb-cap"></p>
      <button class="lb-btn" data-lb="next" aria-label="Próxima foto">${ico("i-chev")}</button></div>`;
  document.body.appendChild(lb);
  history.pushState({ lb: 1 }, "");
  const show = async () => {
    const p = photos[i];
    $(".lb-count", lb).textContent = `${i + 1} de ${photos.length}`;
    $(".lb-cap", lb).textContent = p.caption || "";
    $('[data-lb="prev"]', lb).disabled = i === 0; $('[data-lb="next"]', lb).disabled = i === photos.length - 1;
    const img = $("img", lb); img.alt = p.caption || `Foto ${i + 1} de ${rec.title}`;
    const url = await photoURL(p);
    img.hidden = !url; $(".lb-missing", lb).hidden = !!url; if (url) img.src = url;
  };
  const go = d => { const n = i + d; if (n >= 0 && n < photos.length) { i = n; show(); } };
  lb.addEventListener("click", e => { const b = e.target.closest("[data-lb]"); if (!b) return;
    if (b.dataset.lb === "close") closeLightbox(); else go(b.dataset.lb === "next" ? 1 : -1); });
  let x0 = null;
  lb.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); });
  lb._keys = e => { if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); };
  document.addEventListener("keydown", lb._keys);
  show(); $('[data-lb="close"]', lb).focus();
}
function closeLightbox(fromPop) {
  const lb = $("#lightbox"); if (!lb) return;
  document.removeEventListener("keydown", lb._keys); lb.remove();
  if (!fromPop && history.state && history.state.lb) { ignorePop = true; history.back(); }
}
const albumGrid = (rec, editable) => (rec.photos || []).map((p, n) => `
  <div class="ph${editable ? " edit" : ""}" data-photo="${esc(p.id)}">
    ${editable ? "" : `<button type="button" class="ph-open" data-open="${n}" aria-label="Abrir foto ${n + 1}${p.caption ? ": " + esc(p.caption) : ""}">`}
      <img alt="${esc(p.caption || "")}" loading="lazy">
      <span class="ph-miss">${ico("i-cloud")}</span>
    ${editable ? `<button type="button" class="ph-del" data-delph="${esc(p.id)}" aria-label="Remover foto">${ico("i-x", "sm")}</button>
      <input class="ph-cap" data-cap="${esc(p.id)}" value="${esc(p.caption || "")}" maxlength="60" placeholder="Legenda" aria-label="Legenda da foto ${n + 1}">` : `</button>${p.caption ? `<span class="ph-label">${esc(p.caption)}</span>` : ""}`}
  </div>`).join("");
$("#layer").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
const reopen = fn => { closeSheet(); setTimeout(fn, 30); };

function showRecipe(id) {
  const r = data.recipes[id]; if (!r || r.deleted) return;
  const c = catOf(r.category);
  const facts = [
    r.timeMin && `<span class="fact">${ico("i-clock", "sm")}${fmtTime(r.timeMin)}</span>`,
    r.servings && `<span class="fact">${ico("i-users", "sm")}${r.servings} porç${r.servings === 1 ? "ão" : "ões"}</span>`,
    r.calories && `<span class="fact">${ico("i-flame", "sm")}${r.calories} kcal${r.servings ? " /porção" : ""}</span>`,
  ].filter(Boolean).join("");
  const url = safeUrl(r.videoUrl);
  const ing = r.ingredients || [];
  openSheet(r.title, `
    <div class="d-hero" style="${kstyle(c)}">
      <div class="top">
        <span class="catlabel">${ico(catIcon(c), "sm")}${esc(c.name)}</span>
        <div class="acts">
          <button class="iconbtn" id="d-fav" aria-pressed="${!!r.fav}" aria-label="${r.fav ? "Tirar dos favoritos" : "Favoritar"}">${ico("i-star")}</button>
          <button class="iconbtn" data-close aria-label="Fechar">${ico("i-x")}</button>
        </div>
      </div>
      <h2>${esc(r.title)}</h2>
      ${facts ? `<div class="facts">${facts}</div>` : ""}
    </div>
    ${url ? `<a class="btn tonal block" style="${kstyle(c)}" href="${esc(url)}" target="_blank" rel="noopener">${ico("i-play")}Ver vídeo da receita</a>` : ""}
    <section>
      <div class="sec-title"><h3>Ingredientes</h3><span class="n" id="ing-n">0 de ${ing.length}</span></div>
      <ul class="checklist">${ing.map((i, n) => `<li><label><input type="checkbox" id="ing-${n}"><span>${esc(i)}</span></label></li>`).join("")}</ul>
    </section>
    <section>
      <div class="sec-title"><h3>Modo de fazer</h3><span class="n">${(r.steps || []).length} passos</span></div>
      <ol class="steps">${(r.steps || []).map(s => `<li><span>${esc(s)}</span></li>`).join("")}</ol>
    </section>
    ${r.notes ? `<section><div class="sec-title"><h3>Observações</h3></div><p class="notes">${esc(r.notes)}</p></section>` : ""}
    ${(r.photos || []).length ? `<section><div class="sec-title"><h3>Álbum</h3><span class="n">${r.photos.length} foto${r.photos.length === 1 ? "" : "s"}</span></div>
      <div class="album">${albumGrid(r, false)}</div></section>` : ""}
    ${(r.tags || []).length ? `<div class="tags">${r.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="actions">
      <button class="btn danger" id="d-del">${ico("i-trash")}Excluir</button>
      <button class="btn primary" id="d-edit" style="flex:1">${ico("i-edit")}Editar receita</button>
    </div>
    <div id="d-confirm"></div>
  `, sheet => {
    sheet.setAttribute("style", kstyle(c));
    hydratePhotos(sheet, r);
    sheet.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLightbox(r, +b.dataset.open));
    sheet.querySelectorAll(".checklist input").forEach(cb => cb.onchange = () => {
      $("#ing-n", sheet).textContent = `${sheet.querySelectorAll(".checklist input:checked").length} de ${ing.length}`;
    });
    $("#d-edit", sheet).onclick = () => reopen(() => showForm(r));
    $("#d-fav", sheet).onclick = async e => {
      const btn = e.currentTarget; const next = !(data.recipes[r.id] || r).fav;
      await upsertRecipe({ ...data.recipes[r.id], fav: next, updatedAt: Date.now() });
      btn.setAttribute("aria-pressed", next); btn.setAttribute("aria-label", next ? "Tirar dos favoritos" : "Favoritar");
      toast(next ? "Adicionada às favoritas" : "Removida das favoritas");
    };
    $("#d-del", sheet).onclick = () => {
      $("#d-confirm", sheet).innerHTML = `<div class="confirm"><p>Excluir <b>${esc(r.title)}</b>? Não dá para desfazer.</p>
        <div class="actions"><button class="btn" id="c-no">Cancelar</button><button class="btn danger" id="c-yes">Excluir</button></div></div>`;
      $("#d-confirm", sheet).scrollIntoView({ block: "nearest", behavior: "smooth" });
      $("#c-no", sheet).onclick = () => $("#d-confirm", sheet).innerHTML = "";
      $("#c-yes", sheet).onclick = async () => { await removeRecipe(r.id); closeSheet(); toast("Receita excluída"); };
    };
  }, { hideHead: true });
}

function showForm(r, presetCat) {
  const isNew = !r;
  r = r || { title: "", category: presetCat || UI.cat || (cats()[0] && cats()[0].id), ingredients: [], steps: [], videoUrl: "", calories: "", servings: "", timeMin: "", tags: [], notes: "", photos: [] };
  const album = { photos: (r.photos || []).map(p => ({ ...p })), added: [], removed: [] };
  let saved = false;
  let cat = r.category;
  let newColor = COLORS.find(k => !cats().some(c => c.color === k)) || "k5";
  let newIcon = CAT_ICONS.find(k => !cats().some(c => catIcon(c) === k)) || "c-book";
  const draftKey = "fichario.draft";
  const catsHTML = () => cats().map(c => `<button type="button" class="cat-opt" style="${kstyle(c)}" data-cat="${esc(c.id)}" aria-pressed="${c.id === cat}">${ico(catIcon(c), "sm")}${esc(c.name)}</button>`).join("") +
    `<button type="button" class="cat-opt cat-new" id="f-newcat-btn">${ico("i-plus", "sm")}Nova</button>`;

  openSheet(isNew ? "Nova receita" : "Editar receita", `
    <form id="f" novalidate style="display:grid;gap:20px">
      <div class="field" id="w-title"><label for="f-title">Nome da receita</label><input id="f-title" maxlength="120" value="${esc(r.title)}" placeholder="Ex.: Bolo de cenoura" autocapitalize="sentences"></div>
      <div class="group" id="w-cat"><span class="lbl">Categoria</span><div class="cats" id="f-cats">${catsHTML()}</div>
        <div class="newcat" id="f-newcat" hidden>
          <input id="f-newcat-name" maxlength="30" placeholder="Nome da nova categoria" aria-label="Nome da nova categoria">
          <div class="pickrow" role="group" aria-label="Cor">${COLORS.map(k => `<button type="button" class="swatch" style="--kfg:var(--${k})" data-color="${k}" aria-label="Cor ${k.slice(1)}" aria-pressed="${k === newColor}"></button>`).join("")}</div>
          <div class="pickrow" role="group" aria-label="Ícone">${CAT_ICONS.map(k => `<button type="button" class="icopt" data-icon="${k}" aria-label="Ícone ${k.slice(2)}" aria-pressed="${k === newIcon}">${ico(k)}</button>`).join("")}</div>
          <div class="row"><button type="button" class="btn" id="f-newcat-cancel">Cancelar</button><button type="button" class="btn primary" id="f-newcat-save" style="flex:1">Criar categoria</button></div>
        </div></div>
      <div class="field" id="w-ing"><label for="f-ing">Ingredientes</label>
        <textarea id="f-ing" placeholder="3 cenouras médias&#10;3 ovos&#10;2 xícaras de farinha">${esc((r.ingredients || []).join("\n"))}</textarea>
        <small>Um por linha. Pode colar uma lista pronta.</small></div>
      <div class="field" id="w-steps"><label for="f-steps">Modo de fazer</label>
        <textarea id="f-steps" placeholder="Bata no liquidificador…&#10;Asse por 40 min a 180 °C">${esc((r.steps || []).join("\n"))}</textarea>
        <small>Cada linha vira um passo numerado.</small></div>
      <div class="group"><span class="lbl">Detalhes (opcional)</span>
        <div class="grid3">
          <div class="field"><label for="f-time">Tempo (min)</label><input id="f-time" type="number" inputmode="numeric" min="0" max="2000" value="${esc(r.timeMin)}"></div>
          <div class="field"><label for="f-serv">Porções</label><input id="f-serv" type="number" inputmode="numeric" min="0" max="200" value="${esc(r.servings)}"></div>
          <div class="field"><label for="f-cal">Kcal</label><input id="f-cal" type="number" inputmode="numeric" min="0" max="20000" value="${esc(r.calories)}"></div>
        </div>
        <small class="small">Com porções preenchidas, as calorias valem por porção.</small></div>
      <div class="field" id="w-video"><label for="f-video">Link do vídeo (opcional)</label><input id="f-video" type="url" inputmode="url" autocapitalize="off" value="${esc(r.videoUrl)}" placeholder="https://youtube.com/…"></div>
      <div class="field"><label for="f-tags">Etiquetas (opcional)</label><input id="f-tags" value="${esc((r.tags || []).join(", "))}" placeholder="sem glúten, airfryer, rápido"><small>Separe por vírgula. Ajudam na busca.</small></div>
      <div class="group" id="w-album"><span class="lbl">Álbum de fotos (opcional)</span>
        <div class="album edit" id="f-album"></div>
        <label class="btn tonal block add-photo" for="f-photos">${ico("i-camera")}Adicionar fotos</label>
        <input type="file" id="f-photos" accept="image/*" multiple hidden>
        <small class="small">Fotos do passo a passo, do ponto da massa, do prato pronto. Não viram capa da receita.</small></div>
      <div class="field"><label for="f-notes">Observações (opcional)</label><textarea id="f-notes" style="min-height:76px" placeholder="Dicas, substituições, de onde veio a receita">${esc(r.notes)}</textarea></div>
      <p class="err" id="f-err" hidden></p>
      <div class="sticky-actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" id="f-save">Salvar receita</button></div>
    </form>`, sheet => {
    if (isNew) {
      try { const d = JSON.parse(localStorage.getItem(draftKey) || "null");
        if (d && (d.title || d.ing || d.steps)) { $("#f-title", sheet).value = d.title || ""; $("#f-ing", sheet).value = d.ing || ""; $("#f-steps", sheet).value = d.steps || ""; toast("Rascunho recuperado"); }
      } catch (e) {}
    }
    $("#f", sheet).addEventListener("input", e => {
      const w = e.target.closest(".field"); if (w && w.classList.contains("invalid")) { w.classList.remove("invalid"); const fe = w.querySelector(".ferr"); fe && fe.remove(); }
      if (isNew) { try { localStorage.setItem(draftKey, JSON.stringify({ title: $("#f-title", sheet).value, ing: $("#f-ing", sheet).value, steps: $("#f-steps", sheet).value })); } catch (_) {} }
    });
    // álbum no formulário
    const drawAlbum = () => {
      const box = $("#f-album", sheet);
      box.innerHTML = albumGrid(album, true);
      box.hidden = !album.photos.length;
      hydratePhotos(box, album);
    };
    drawAlbum();
    $("#f-album", sheet).addEventListener("click", async e => {
      const b = e.target.closest("[data-delph]"); if (!b) return;
      const p = album.photos.find(x => x.id === b.dataset.delph);
      album.photos = album.photos.filter(x => x !== p);
      if (album.added.includes(p.id)) { album.added = album.added.filter(x => x !== p.id); await discardPhotos([p]); }
      else album.removed.push(p);
      drawAlbum();
    });
    $("#f-album", sheet).addEventListener("input", e => {
      const inp = e.target.closest("[data-cap]"); if (!inp) return;
      const p = album.photos.find(x => x.id === inp.dataset.cap); if (p) p.caption = inp.value.trim();
    });
    $("#f-photos", sheet).onchange = async e => {
      const files = [...e.target.files].filter(f => f.type.startsWith("image/")); e.target.value = "";
      if (!files.length) return;
      if (album.photos.length + files.length > 30) { toast("Limite de 30 fotos por receita."); return; }
      const lbl = $(".add-photo", sheet); lbl.classList.add("busy"); lbl.lastChild.textContent = "Preparando fotos…";
      let fail = 0;
      for (const f of files) {
        try {
          const { blob, w, h } = await compressImage(f);
          const id = uid(); await Store.photoPut(id, blob);
          album.photos.push({ id, w, h, caption: "", addedAt: Date.now() }); album.added.push(id);
        } catch (err) { fail++; }
      }
      lbl.classList.remove("busy"); lbl.lastChild.textContent = "Adicionar fotos";
      drawAlbum();
      if (fail) toast(fail === files.length ? "Não deu para abrir essas imagens." : `${fail} imagem(ns) não puderam ser abertas.`);
    };
    // cancelou o cadastro: apaga as fotos novas que não foram usadas
    onSheetClose = () => { if (!saved) album.added.forEach(id => Store.photoDel(id)); };
    const wireCats = () => {
      sheet.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { cat = b.dataset.cat; sheet.querySelectorAll("[data-cat]").forEach(x => x.setAttribute("aria-pressed", x.dataset.cat === cat)); });
      $("#f-newcat-btn", sheet).onclick = () => { $("#f-newcat", sheet).hidden = false; $("#f-newcat-name", sheet).focus(); };
    };
    wireCats();
    const pick = (attr, set) => sheet.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => { set(b.dataset[attr]); sheet.querySelectorAll(`[data-${attr}]`).forEach(x => x.setAttribute("aria-pressed", x === b)); });
    pick("color", v => newColor = v); pick("icon", v => newIcon = v);
    $("#f-newcat-cancel", sheet).onclick = () => { $("#f-newcat", sheet).hidden = true; };
    $("#f-newcat-save", sheet).onclick = async () => {
      const name = $("#f-newcat-name", sheet).value.trim(); if (!name) { $("#f-newcat-name", sheet).focus(); return; }
      if (cats().some(c => norm(c.name) === norm(name))) { toast("Essa categoria já existe."); return; }
      let id = norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cat";
      while (cats().some(c => c.id === id)) id += "-2";
      await setCats([...cats(), { id, name, color: newColor, icon: newIcon }]);
      cat = id; $("#f-cats", sheet).innerHTML = catsHTML(); wireCats();
      $("#f-newcat", sheet).hidden = true; $("#f-newcat-name", sheet).value = "";
    };
    const fieldErr = (wid, msg) => { const w = $("#" + wid, sheet); if (!w) return; w.classList.add("invalid"); if (!w.querySelector(".ferr")) w.insertAdjacentHTML("beforeend", `<span class="ferr">${msg}</span>`); };
    $("#f", sheet).onsubmit = async e => {
      e.preventDefault();
      const err = $("#f-err", sheet); err.hidden = true;
      const num = id => { const v = parseInt($(id, sheet).value, 10); return Number.isFinite(v) && v > 0 ? v : null; };
      const now = Date.now();
      const rec = {
        id: r.id || uid(),
        title: $("#f-title", sheet).value.trim(),
        category: cat,
        ingredients: lines($("#f-ing", sheet).value),
        steps: lines($("#f-steps", sheet).value),
        timeMin: num("#f-time"), servings: num("#f-serv"), calories: num("#f-cal"),
        videoUrl: $("#f-video", sheet).value.trim(),
        tags: [...new Set($("#f-tags", sheet).value.split(",").map(s => s.trim()).filter(Boolean))],
        photos: album.photos,
        notes: $("#f-notes", sheet).value.trim(),
        fav: !!r.fav, createdAt: r.createdAt || now, updatedAt: now,
      };
      const bad = [];
      if (!rec.title) { fieldErr("w-title", "Dê um nome para a receita."); bad.push("w-title"); }
      if (!rec.category) { fieldErr("w-cat", "Escolha uma categoria."); bad.push("w-cat"); }
      if (!rec.ingredients.length) { fieldErr("w-ing", "Coloque pelo menos um ingrediente."); bad.push("w-ing"); }
      if (!rec.steps.length) { fieldErr("w-steps", "Escreva pelo menos um passo."); bad.push("w-steps"); }
      if (rec.videoUrl && !safeUrl(rec.videoUrl)) { fieldErr("w-video", "O link precisa começar com https://"); bad.push("w-video"); }
      if (bad.length) { $("#" + bad[0], sheet).scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      const dupe = live().find(x => x.id !== rec.id && norm(x.title) === norm(rec.title));
      if (dupe && !err.dataset.dupeOk) { err.textContent = `Já existe “${dupe.title}”. Toque em salvar de novo para guardar mesmo assim.`; err.hidden = false; err.dataset.dupeOk = "1"; err.scrollIntoView({ block: "nearest" }); return; }
      saved = true;
      await discardPhotos(album.removed);
      await upsertRecipe(rec);
      if (isNew) { try { localStorage.removeItem(draftKey); } catch (_) {} }
      closeSheet(); toast(isNew ? "Receita salva" : "Alterações salvas");
    };
  });
}

/* tema (dia / noite / automático) — preferência do aparelho, fica só no navegador */
const THEME_KEY = "fichario-tema";
const getTheme = () => { try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "auto"; } catch (e) { return "auto"; } };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "auto") delete root.dataset.theme; else root.dataset.theme = t;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    const dark = t === "auto" ? /dark/.test(m.media) : t === "dark";
    m.content = dark ? "#111312" : "#f6f6f3";
  });
}
function setTheme(t) {
  try { if (t === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch (e) {}
  applyTheme(t);
}
applyTheme(getTheme());

/* ajustes */
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });

function showSettings() {
  const counts = {}; live().forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  const connected = DRIVE_ON && (meta.lastSync || meta.email);
  const head = (icon, t) => `<h3><span class="ic-tile">${ico(icon, "sm")}</span>${t}</h3>`;
  const drivePanel = !DRIVE_ON
    ? `<div class="panel">${head("i-cloud", "Google Drive")}<p class="small">A cópia no Drive ainda não foi ativada neste app. As receitas ficam salvas só neste celular. Use “Exportar” abaixo para guardar uma cópia.</p></div>`
    : connected
      ? `<div class="panel">${head("i-cloud", "Google Drive")}
          <dl class="kv"><dt>Conta</dt><dd>${esc(meta.email || "conectada")}</dd><dt>Última cópia</dt><dd>${meta.lastSync ? whenText(meta.lastSync) : "ainda não"}</dd></dl>
          <p class="small">O app só enxerga o arquivo de receitas que ele mesmo criou no seu Drive.</p>
          <div class="row"><button class="btn primary" id="s-sync" style="flex:1">Sincronizar agora</button><button class="btn" id="s-out">Desconectar</button></div></div>`
      : `<div class="panel">${head("i-cloud", "Google Drive")}
          <p>Guarde uma cópia das receitas no seu Drive para não perder nada se trocar de celular.</p>
          <p class="small">O Google vai pedir permissão. O app só acessa o arquivo de receitas que ele mesmo cria.</p>
          <button class="btn primary block" id="s-in">Conectar Google Drive</button></div>`;
  const installPanel = isStandalone() ? "" : `<div class="panel">${head("i-phone", "Instalar no celular")}
      ${installEvt ? `<p>Coloca o Fichário na tela inicial, abrindo como um app.</p><button class="btn primary block" id="s-install">Instalar app</button>`
        : isIOS ? `<p>No Safari, toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.</p>`
        : `<p>No Chrome, toque no menu <b>⋮</b> e depois em <b>Instalar app</b>.</p>`}</div>`;

  const theme = getTheme();
  const themePanel = `<div class="panel">${head("i-sun", "Aparência")}
      <div class="modes" role="group" aria-label="Cores do app">${[["light", "Dia"], ["dark", "Noite"], ["auto", "Automático"]].map(([k, t]) =>
        `<button data-theme-opt="${k}" aria-pressed="${k === theme}">${t}</button>`).join("")}</div>
      <p class="small">No automático, segue o modo claro ou escuro do celular.</p></div>`;

  openSheet("Ajustes", `
    ${themePanel}
    ${drivePanel}
    ${installPanel}
    <div class="panel">${head("i-tags", "Categorias")}
      <div id="s-cats">${cats().map(c => `
        <div class="catrow" data-row="${esc(c.id)}" style="${kstyle(c)}">
          <span class="ic-tile">${ico(catIcon(c), "sm")}</span>
          <span class="name">${esc(c.name)}<small>${counts[c.id] || 0} receita${counts[c.id] === 1 ? "" : "s"}</small></span>
          <button class="iconbtn plain" data-ren="${esc(c.id)}" aria-label="Renomear ${esc(c.name)}">${ico("i-edit")}</button>
          <button class="iconbtn plain" data-delc="${esc(c.id)}" aria-label="Excluir ${esc(c.name)}" ${counts[c.id] ? "disabled style=\"opacity:.3\"" : ""}>${ico("i-trash")}</button>
        </div>`).join("")}</div>
      <p class="small">Só dá para excluir categorias vazias. Crie novas no cadastro da receita.</p></div>
    <div class="panel">${head("i-box", "Cópia de segurança")}
      <p class="small">Um arquivo com todas as receitas, para guardar onde quiser ou levar para outro aparelho.</p>
      <div class="row"><button class="btn" id="s-exp" style="flex:1">Exportar</button><label class="btn" for="s-imp-file" style="flex:1">Importar</label><input type="file" id="s-imp-file" accept="application/json,.json" hidden></div></div>
    <p class="small" style="text-align:center">Fichário de Receitas · versão ${APP_VERSION}</p>
  `, sheet => {
    const on = (id, fn) => { const el = $(id, sheet); if (el) el.onclick = fn; };
    on("#s-in", () => googleLogin());
    on("#s-sync", () => { closeSheet(); sync({ manual: true }); });
    on("#s-out", async () => {
      const t = Token.get();
      if (t) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }); } catch (e) {} }
      Token.clear(); meta = { fileId: null, email: null, lastSync: 0, dirty: meta.dirty }; await saveMeta();
      closeSheet(); render(); toast("Drive desconectado. As receitas continuam no celular.");
    });
    on("#s-install", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; closeSheet(); });
    on("#s-exp", exportBackup);
    sheet.querySelectorAll("[data-theme-opt]").forEach(b => b.onclick = () => {
      setTheme(b.dataset.themeOpt);
      sheet.querySelectorAll("[data-theme-opt]").forEach(x => x.setAttribute("aria-pressed", x === b));
    });
    $("#s-imp-file", sheet).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const m = mergeData(data, fromFile(await f.text())); data = m.data; await persist(); closeSheet(); toast("Receitas importadas"); }
      catch (err) { toast("Esse arquivo não é uma cópia do Fichário."); }
    };
    sheet.querySelectorAll("[data-ren]").forEach(b => b.onclick = () => {
      const id = b.dataset.ren, c = catOf(id), row = sheet.querySelector(`[data-row="${CSS.escape(id)}"]`);
      row.innerHTML = `<span class="ic-tile">${ico(catIcon(c), "sm")}</span><input value="${esc(c.name)}" maxlength="30" aria-label="Novo nome da categoria"><button class="btn primary" data-ok>Salvar</button>`;
      const inp = row.querySelector("input"); inp.focus(); inp.select();
      row.querySelector("[data-ok]").onclick = async () => {
        const name = inp.value.trim(); if (!name) return;
        await setCats(cats().map(x => x.id === id ? { ...x, name } : x)); reopen(showSettings);
      };
    });
    sheet.querySelectorAll("[data-delc]").forEach(b => b.onclick = async () => {
      if (cats().length <= 1) { toast("Mantenha pelo menos uma categoria."); return; }
      await setCats(cats().filter(x => x.id !== b.dataset.delc)); if (UI.cat === b.dataset.delc) UI.cat = ""; reopen(showSettings);
    });
  });
}

async function exportBackup() {
  const name = `fichario-receitas-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([toFile(data)], { type: "application/json" });
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Fichário de Receitas" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ======================= eventos ======================= */
let qTimer;
const setSearchUI = () => {
  const active = document.activeElement === $("#q") || !!UI.q;
  $("#modes").hidden = !active; $("#hint").hidden = !(active && UI.mode === "have");
};
$("#q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { UI.q = e.target.value; render(); setSearchUI(); }, 120); });
$("#q").addEventListener("focus", setSearchUI);
$("#q").addEventListener("blur", () => setTimeout(setSearchUI, 150));
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#q-clear").onclick = () => { $("#q").value = ""; UI.q = ""; render(); $("#q").focus(); };
document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
  UI.mode = b.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("#q").placeholder = UI.mode === "have" ? "ovo, banana, aveia" : UI.mode === "name" ? "Nome da receita" : "Buscar receita ou ingrediente";
  render(); $("#q").focus(); setSearchUI();
});
document.querySelectorAll(".tab[data-view]").forEach(t => t.onclick = () => {
  if (UI.cat) { closeCat(); if (t.dataset.view === UI.view) return; }
  UI.view = t.dataset.view;
  render(); scrollTo({ top: 0, behavior: "smooth" });
});
$("#back").onclick = closeCat;
$("#tab-search").onclick = () => { scrollTo({ top: 0 }); $("#q").focus(); };
$("#tab-settings").onclick = showSettings;
$("#fab").onclick = () => showForm(null);
$("#sync").onclick = () => { if (!(meta.lastSync || meta.email)) return showSettings(); sync({ manual: true }); };
document.addEventListener("click", e => {
  const chip = e.target.closest("[data-chip]");
  if (chip) { openCat(chip.dataset.chip); return; }
  if (!e.target.closest("#main")) return;
  const card = e.target.closest(".card"); if (card) return showRecipe(card.dataset.id);
  const add = e.target.closest("[data-addcat]"); if (add) return showForm(null, add.dataset.addcat);
});
addEventListener("online", () => scheduleSync(500));
addEventListener("offline", () => setSync());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(300); });

/* ======================= início ======================= */
(async () => {
  const oauth = handleOAuthReturn();
  const [d, m] = await Promise.all([Store.get("data"), Store.get("meta")]);
  if (d && d.recipes) data = d;
  if (m) meta = { ...meta, ...m };
  if (CFG.DEMO && !Object.keys(data.recipes).length) seedDemo();
  UI.loaded = true;
  render();
  if (oauth === "ok") { await fetchEmail(); sync({ manual: true }); }
  else { if (oauth) toast(oauth); sync(); }
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
})();

function seedDemo() {
  const t = Date.now();
  const mk = (id, title, category, ingredients, steps, extra = {}) => ({ id, title, category, ingredients, steps, videoUrl: "", tags: [], notes: "", fav: false, createdAt: t, updatedAt: t - id.length * 1000, timeMin: null, servings: null, calories: null, ...extra });
  [
    mk("d1", "Bolo de cenoura com calda de chocolate", "doce", ["3 cenouras médias", "3 ovos", "1 xícara de óleo", "2 xícaras de açúcar", "2 xícaras de farinha de trigo", "1 colher (sopa) de fermento"], ["Bata cenoura, ovos e óleo no liquidificador.", "Misture com açúcar e farinha; junte o fermento por último.", "Asse a 180 °C por cerca de 40 min.", "Cubra com a calda ainda quente."], { timeMin: 60, servings: 12, calories: 290, fav: true, tags: ["clássico"], videoUrl: "https://www.youtube.com/" }),
    mk("d2", "Brigadeiro de colher", "doce", ["1 lata de leite condensado", "1 colher (sopa) de manteiga", "3 colheres (sopa) de chocolate em pó"], ["Leve tudo ao fogo baixo mexendo sempre.", "Cozinhe até desgrudar do fundo."], { timeMin: 15, servings: 8, calories: 120 }),
    mk("d3", "Pudim de leite", "doce", ["1 lata de leite condensado", "2 medidas de leite", "3 ovos", "1 xícara de açúcar para a calda"], ["Derreta o açúcar até virar caramelo.", "Bata o restante e despeje na forma.", "Asse em banho-maria por 1h."], { timeMin: 80, servings: 10, calories: 260 }),
    mk("d4", "Misto quente na airfryer", "lanche", ["2 fatias de pão de forma", "2 fatias de muçarela", "2 fatias de presunto", "Manteiga"], ["Passe manteiga por fora do pão.", "Monte e leve à airfryer a 180 °C por 6 min."], { timeMin: 8, servings: 1, calories: 380, tags: ["airfryer"] }),
    mk("d5", "Pão de queijo de frigideira", "lanche", ["1 ovo", "2 colheres de tapioca", "1 colher de requeijão", "Queijo ralado"], ["Misture tudo.", "Doure na frigideira dos dois lados."], { timeMin: 10, servings: 1, calories: 210 }),
    mk("d6", "Frango com legumes na panela", "refeicao", ["500 g de peito de frango em cubos", "1 cenoura", "1 abobrinha", "1 cebola", "2 dentes de alho"], ["Tempere e doure o frango.", "Refogue cebola e alho, junte os legumes.", "Volte o frango e cozinhe tampado por 10 min."], { timeMin: 35, servings: 3, calories: 310, fav: true, tags: ["marmita"] }),
    mk("d7", "Escondidinho de carne seca", "refeicao", ["500 g de carne seca dessalgada", "1 kg de mandioca", "Requeijão", "Queijo para gratinar"], ["Cozinhe e amasse a mandioca.", "Refogue a carne desfiada.", "Monte em camadas e gratine."], { timeMin: 90, servings: 6, calories: 450 }),
    mk("d8", "Panqueca de banana e aveia", "fitness", ["1 banana madura", "2 ovos", "3 colheres de aveia", "Canela"], ["Amasse a banana com os ovos.", "Junte aveia e canela.", "Doure 2 min de cada lado."], { timeMin: 10, servings: 1, calories: 320, tags: ["sem açúcar"] }),
    mk("d9", "Suco verde", "bebida", ["1 folha de couve", "1 maçã", "Suco de 1 limão", "Gengibre", "200 ml de água"], ["Bata tudo no liquidificador.", "Sirva gelado."], { timeMin: 5, servings: 1, calories: 90 }),
  ].forEach(r => data.recipes[r.id] = r);
  // fotos de exemplo no álbum do bolo (desenhadas, só para a prévia)
  const bolo = data.recipes.d1; bolo.photos = [];
  [["Massa no ponto", "#f08c00", "#ffd43b"], ["Saindo do forno", "#c2410c", "#fab005"], ["Calda pronta", "#5c2b0f", "#a0522d"], ["Fatia servida", "#c2255c", "#ffa8a8"]].forEach(([cap, c1, c2], n) => {
    const cv = document.createElement("canvas"); cv.width = 600; cv.height = 600; const g = cv.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 600, 600); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, 600, 600);
    g.fillStyle = "rgba(255,255,255,.18)"; g.beginPath(); g.arc(470, 120, 170, 0, 7); g.fill(); g.beginPath(); g.arc(90, 540, 210, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.font = "700 44px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(cap, 300, 300);
    g.font = "600 26px system-ui, sans-serif"; g.globalAlpha = .8; g.fillText("foto de exemplo", 300, 350);
    const id = "demo-ph-" + n;
    bolo.photos.push({ id, w: 600, h: 600, caption: cap, addedAt: t });
    cv.toBlob(b => b && Store.photoPut(id, b).then(() => { if ($(".sheet")) hydratePhotos($(".sheet"), bolo); }), "image/jpeg", .85);
  });
}

if ("serviceWorker" in navigator && !CFG.DEMO) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").then(reg => {
    // o app aberto em segundo plano não recarrega sozinho: procura versão nova ao voltar para ele
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {}));
  // versão nova assumiu: recarrega para usar os arquivos novos (se não houver nada aberto na tela)
  let hadController = !!navigator.serviceWorker.controller, pendingReload = false;
  const reloadNow = () => { if ($(".sheet")) { pendingReload = true; return; } location.reload(); };
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) reloadNow(); hadController = true; });
  new MutationObserver(() => { if (pendingReload && !$(".sheet")) location.reload(); }).observe($("#layer"), { childList: true });
}
