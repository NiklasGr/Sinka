// =============================================================================
// PROVIDER: IServ  (WebDAV)
// =============================================================================
//
// IServ exposes the "Dateien" module over WebDAV. There is no "course" concept,
// so a syncable unit is a top-level WebDAV area: the personal folder ("Eigene")
// and each group folder under "Gruppen". A unit's id is its WebDAV path relative
// to /webdav/ (e.g. "Eigene" or "Gruppen/Klasse 10a").
//
// WebDAV has no stable file ids — a file/folder is identified by its URL, which is
// what we hand the engine as `id`/`folderId`/`ref`. Auth is HTTP Basic with the
// user's IServ login (stored in the session). The server domain comes from
// ISERV_BASE_URL.

const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");

const fetch = global.fetch || require("node-fetch");
const credentials = require("../auth/credential-store");
const { createLimiter } = require("../util/limiter");

const base = () => (process.env.ISERV_BASE_URL || "").replace(/\/+$/, "");
// WebDAV root. Defaults to <ISERV_BASE_URL>/webdav, which IServ serves, but IServ
// also exposes WebDAV at a "webdav." subdomain — set ISERV_WEBDAV_URL to override
// (e.g. https://webdav.your-school.de) for installs that only offer the subdomain.
const webdavRoot = () => (process.env.ISERV_WEBDAV_URL || (base() ? `${base()}/webdav` : "")).replace(/\/+$/, "");

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// --- WebDAV transport --------------------------------------------------------

function authHeader(ctx) {
  return "Basic " + Buffer.from(`${ctx.username}:${ctx.password}`).toString("base64");
}

async function dav(ctx, method, url, { depth, body, contentType } = {}) {
  const headers = { Authorization: authHeader(ctx) };
  if (depth !== undefined) headers.Depth = String(depth);
  if (contentType) headers["Content-Type"] = contentType;

  const response = await fetch(url, { method, headers, body, redirect: "follow" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WebDAV ${method} ${url} failed: ${response.status} ${response.statusText} ${text}`.trim());
  }
  return response;
}

const PROPFIND_BODY =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<propfind xmlns="DAV:"><prop>` +
  `<resourcetype/><getcontentlength/><getlastmodified/><displayname/>` +
  `</prop></propfind>`;

// PROPFIND a URL and return its entries as { url, path, isCollection, size, timestamp }.
async function propfind(ctx, url, depth) {
  const response = await dav(ctx, "PROPFIND", url, { depth, body: PROPFIND_BODY, contentType: "application/xml; charset=utf-8" });
  const doc = xml.parse(await response.text());
  let responses = doc?.multistatus?.response ?? [];
  if (!Array.isArray(responses)) responses = responses ? [responses] : [];

  return responses.map((r) => {
    if (!r.href) return null;
    let propstat = r.propstat;
    if (Array.isArray(propstat)) propstat = propstat.find((p) => /\b200\b/.test(String(p.status))) ?? propstat[0];
    const prop = propstat?.prop ?? {};
    const rt = prop.resourcetype;
    const isCollection = !!(rt && typeof rt === "object" && "collection" in rt);
    const entryUrl = new URL(r.href, webdavRoot());
    return {
      url: entryUrl.toString(),
      path: decodeURIComponent(entryUrl.pathname).replace(/\/+$/, ""),
      isCollection,
      size: prop.getcontentlength != null ? Number(prop.getcontentlength) : null,
      timestamp: prop.getlastmodified ? Math.trunc(new Date(prop.getlastmodified).getTime() / 1000) || 0 : 0,
    };
  }).filter(Boolean);
}

// --- url helpers -------------------------------------------------------------

// Build the WebDAV url for a /webdav-relative path, encoding each segment.
function webdavUrl(relPath) {
  const segments = String(relPath).split("/").filter(Boolean).map(encodeURIComponent);
  return `${webdavRoot()}/${segments.join("/")}`;
}

function childUrl(folderUrl, name) {
  return `${String(folderUrl).replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

// --- tree traversal ----------------------------------------------------------

// How many PROPFINDs the tree walk may have in flight at once.
//
// One Depth:1 PROPFIND per folder already returns that folder's files *and* subfolders,
// so unlike Stud.IP there is no second call per folder to overlap — the only parallelism
// available is across sibling folders, and walking them one after another made the whole
// listing latency-bound (51 folders over an 80 ms link: ~5 s, one request open at a
// time). The cap is politeness towards the school's server, not correctness; 6 matches
// what a browser allows per host.
const TREE_CONCURRENCY = 6;

// `limit` gates the PROPFINDs only, never the recursive traverse() calls — a parent
// holding a slot while its children queue for one would deadlock the walk.
async function traverse(ctx, folderUrl, segments, files, folders, limit) {
  folders.push({ path: segments.join("/"), id: folderUrl });
  const folderPath = decodeURIComponent(new URL(folderUrl).pathname).replace(/\/+$/, "");

  const entries = await limit(() => propfind(ctx, folderUrl, 1));

  // Files first, then all subfolders side by side. The results land in a different order
  // than the previous depth-first walk produced; nothing depends on it — the engine
  // builds a Map from `folders` and sorts explicitly wherever depth matters (creation
  // shallowest first, deletion deepest first, see sync/engine.js).
  const descend = [];
  for (const entry of entries) {
    if (entry.path === folderPath) continue; // the folder itself
    const name = entry.path.split("/").pop();
    if (entry.isCollection) {
      descend.push(traverse(ctx, entry.url, [...segments, name], files, folders, limit));
    } else {
      files.push({
        id: entry.url,
        name,
        path: [...segments, name].join("/"),
        folderId: folderUrl,
        size: entry.size,
        timestamp: entry.timestamp,
        ref: entry.url,
      });
    }
  }
  await Promise.all(descend);
}

// --- engine-facing provider interface ----------------------------------------

// Top-level syncable units: "Eigene" (personal) and each folder under "Gruppen".
async function listCourses(ctx) {
  const rootPath = decodeURIComponent(new URL(`${webdavRoot()}/`).pathname).replace(/\/+$/, "");
  const courses = [];

  for (const area of await propfind(ctx, `${webdavRoot()}/`, 1)) {
    if (area.path === rootPath || !area.isCollection) continue;
    const areaName = area.path.split("/").pop();

    if (/grupp|group/i.test(areaName)) {
      for (const group of await propfind(ctx, area.url, 1)) {
        if (group.path === area.path || !group.isCollection) continue;
        const groupName = group.path.split("/").pop();
        courses.push({ id: `${areaName}/${groupName}`, name: `Gruppe: ${groupName}`, semester: null, sortKey: 0 });
      }
    } else {
      courses.push({ id: areaName, name: areaName, semester: null, sortKey: 0 });
    }
  }
  return courses;
}

async function listTree(ctx, courseId) {
  const startTime = performance.now();
  const rootUrl = webdavUrl(courseId);
  const files = [];
  const folders = [];
  // One limiter per tree walk, so two courses syncing in sequence never share a budget.
  await traverse(ctx, rootUrl, [], files, folders, createLimiter(TREE_CONCURRENCY));
  const endTime = performance.now();
  console.log(`Call to list IServ Tree took ${endTime - startTime} milliseconds`);
  return { rootFolderId: rootUrl, files, folders };
}

async function downloadFile(ctx, file, destPath) {
  const response = await dav(ctx, "GET", file.ref);
  await fs.promises.writeFile(destPath, Buffer.from(await response.arrayBuffer()));
}

async function uploadFile(ctx, folderId, localPath, name) {
  const url = childUrl(folderId, name);
  await dav(ctx, "PUT", url, { body: await fs.promises.readFile(localPath) });
  const [info] = await propfind(ctx, url, 0);
  return { id: url, timestamp: info?.timestamp || Math.trunc(Date.now() / 1000) };
}

async function deleteFile(ctx, fileId) {
  await dav(ctx, "DELETE", fileId);
}

async function createFolder(ctx, parentId, name) {
  const url = childUrl(parentId, name);
  await dav(ctx, "MKCOL", url);
  return { id: url };
}

async function deleteFolder(ctx, folderId) {
  await dav(ctx, "DELETE", folderId);
}

async function isFolderEmpty(ctx, folderId) {
  try {
    const folderPath = decodeURIComponent(new URL(folderId).pathname).replace(/\/+$/, "");
    const children = (await propfind(ctx, folderId, 1)).filter((e) => e.path !== folderPath);
    return children.length === 0;
  } catch {
    return false;
  }
}

// WebDAV has no simple per-entry permission flag — attempt the action and let a
// 403 surface as an error (the engine treats create/delete failures as skips).
const canWriteFile = async () => true;
const canCreateInFolder = async () => true;
const canDeleteFolder = async () => true;

// --- authentication (HTTP Basic) ---------------------------------------------

function getContext() {
  try {
    const c = credentials.load("iserv");
    return c?.username ? { username: c.username, password: c.password } : null;
  } catch (err) {
    console.error("Failed to load IServ credentials:", err.message);
    return null;
  }
}

function registerAuthRoutes(app) {
  // Validate credentials with a cheap PROPFIND, then store them encrypted.
  app.post("/auth/iserv", async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password are required" });
    if (!webdavRoot()) return res.status(500).json({ error: "ISERV_BASE_URL (or ISERV_WEBDAV_URL) is not configured" });

    const ctx = { username, password };
    try {
      await propfind(ctx, `${webdavRoot()}/`, 0);
    } catch (error) {
      console.error("IServ login failed:", error.message);
      return res.status(401).json({ error: "IServ login failed" });
    }

    try {
      credentials.save("iserv", { username, password });
    } catch (error) {
      console.error("Failed to store IServ credentials:", error.message);
      return res.status(500).json({ error: "Could not store credentials (is SESSION_ENCRYPTION_KEY set?)" });
    }
    res.json({ success: true });
  });
}

module.exports = {
  name: "iserv",
  registerAuthRoutes,
  getContext,
  listCourses,
  listTree,
  downloadFile,
  uploadFile,
  deleteFile,
  createFolder,
  deleteFolder,
  isFolderEmpty,
  canWriteFile,
  canCreateInFolder,
  canDeleteFolder,
};
