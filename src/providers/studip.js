// =============================================================================
// PROVIDER: Stud.IP
// =============================================================================
//
// Adapts Stud.IP's OAuth 1.0a REST API to the interface the sync engine expects.
// All Stud.IP-specific transport, response parsing and quirks live here.

const fs = require("fs");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");

const fetch = global.fetch || require("node-fetch");
const credentials = require("../auth/credential-store");
const { publicBase } = require("../config/runtime-settings");
const { createLimiter } = require("../util/limiter");

// Config is read lazily so this module can be required before loadEnvFile() runs.
//
// A trailing slash is stripped, as iserv.js has always done. OAuth 1.0a signs the URL,
// so `${base()}/api.php/...` turning into a double slash is not merely cosmetic: a server
// that normalises its own view of the request path would then compute a different
// signature and answer 401 — a failure that reads like bad credentials. Measured against
// this installation both forms are accepted; the normalisation is insurance for other
// deployments, not a fix for an observed fault.
const base = () => (process.env.STUDIP_BASE_URL || "").replace(/\/+$/, "");

// The base Stud.IP redirects back to after authorization — see publicBase in
// config/runtime-settings, which is also what the student upload link is built from.
let _oauth;
function oauthClient() {
  if (!_oauth) {
    _oauth = new OAuth({
      consumer: { key: process.env.STUDIP_CONSUMER_KEY, secret: process.env.STUDIP_CONSUMER_SECRET },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
      },
    });
  }
  return _oauth;
}

// --- response shape helpers --------------------------------------------------

function normalizeCollection(collection) {
  if (Array.isArray(collection)) return collection;
  if (collection && typeof collection === 'object') return Object.values(collection);
  return [];
}

const collectionOf = (data) => normalizeCollection(data?.collection || data?.data?.collection || data?.data);

function getEntityId(entity) {
  return entity?.id || entity?.attributes?.id || entity?.data?.id
    || entity?.course_id || entity?.semester_id || entity?.user_id
    || entity?.folder_id || entity?.file_id || entity?.range_id;
}

function getEntityName(entity) {
  return entity?.attributes?.name || entity?.name || entity?.data?.name
    || entity?.attributes?.title || entity?.title;
}

function fileMeta(fileRef = {}) {
  const size = fileRef.size ?? fileRef.filesize ?? fileRef.fileSize
    ?? fileRef.attributes?.size ?? fileRef.attributes?.filesize ?? fileRef.attributes?.fileSize ?? null;
  const modifiedAt = fileRef.chdate ?? fileRef.modified_at ?? fileRef.modifiedAt
    ?? fileRef.updated_at ?? fileRef.updatedAt ?? fileRef.attributes?.chdate ?? fileRef.attributes?.modified_at
    ?? fileRef.attributes?.modifiedAt ?? fileRef.attributes?.updated_at ?? fileRef.attributes?.updatedAt ?? null;
  return { size: size != null ? Number(size) : null, timestamp: Number(modifiedAt) || 0 };
}

// --- transport ---------------------------------------------------------------

async function request(ctx, url, method = 'GET', data = null) {
  const requestData = { url, method };
  if (data && method === 'POST') requestData.data = data;
  const authHeader = oauthClient().toHeader(oauthClient().authorize(requestData, { key: ctx.accessToken, secret: ctx.accessTokenSecret }));
  const fetchOptions = { method, headers: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' } };
  if (data && method === 'POST') fetchOptions.body = new URLSearchParams(data).toString();

  const response = await fetch(url, fetchOptions);
  if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Fetch a whole Stud.IP collection across its pagination (collections default to a
// small page size, so a single request can silently truncate the result).
async function requestAll(ctx, url) {
  const items = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const sep = url.includes('?') ? '&' : '?';
    const data = await request(ctx, `${url}${sep}offset=${offset}&limit=${limit}`);
    const batch = collectionOf(data);
    items.push(...batch);
    const total = Number(data?.pagination?.total ?? items.length);
    offset += batch.length;
    if (batch.length === 0 || offset >= total) break;
  }
  return items;
}

async function multipartRequest(ctx, url, method, filePath, fileName) {
  const authHeader = oauthClient().toHeader(oauthClient().authorize({ url, method }, { key: ctx.accessToken, secret: ctx.accessTokenSecret }));
  const fileBuffer = await fs.promises.readFile(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);

  const response = await fetch(url, { method, headers: authHeader, body: formData });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`StudIP upload failed: ${response.status} ${response.statusText} ${body}`);
  }
  return await response.json();
}

// --- folder permissions (cached per auth ctx for the life of a sync) ---------

const permCacheByCtx = new WeakMap();
async function folderPerms(ctx, folderId) {
  let cache = permCacheByCtx.get(ctx);
  if (!cache) { cache = new Map(); permCacheByCtx.set(ctx, cache); }
  if (cache.has(folderId)) return cache.get(folderId);
  let perms = null;
  try {
    perms = await request(ctx, `${base()}/api.php/folder/${folderId}/permissions`);
  } catch { perms = null; }
  cache.set(folderId, perms);
  return perms;
}

// Interpret the permissions payload defensively across shapes (an object of flags
// or a list of granted permissions). When the shape is unrecognised or the perms
// couldn't be fetched, fall back to `defaultAllow`: non-destructive actions default
// to allow (Stud.IP rejects any real overstep, and each action is try/catch-wrapped),
// while destructive ones (folder delete) default to *deny* so an unreadable payload
// never silently green-lights a delete.
function permAllows(perms, keys, { defaultAllow = true } = {}) {
  const p = perms?.attributes ?? perms;
  if (!p || typeof p !== 'object') return defaultAllow;
  if (Array.isArray(p)) return keys.some((k) => p.includes(k));
  for (const k of keys) if (p[k] !== undefined) return !!p[k];
  return defaultAllow;
}

// --- tree traversal ----------------------------------------------------------

// How many API calls the tree walk may have in flight at once.
//
// Walking a course tree is purely latency-bound: two calls per folder, and one folder
// after another means every round trip waits for the previous one. A 51-folder course
// over an 80 ms link took ~9 s that way, with exactly one request open at any moment.
// The work is embarrassingly parallel — sibling folders know nothing about each other —
// so the cap is about politeness, not correctness: 6 is what a browser allows per host,
// and it keeps a wide course from opening a hundred sockets against the school server.
const TREE_CONCURRENCY = 6;

// `limit` gates the HTTP calls only, never the recursive traverse() calls themselves —
// a parent waiting on its children must not occupy a slot, or a deep tree would
// deadlock against its own descendants.
async function traverse(ctx, folderId, segments, files, folders, limit) {
  folders.push({ path: segments.join('/'), id: folderId });

  // Independent of each other: ask for both at once instead of one after the other.
  const [filesData, subData] = await Promise.all([
    limit(() => request(ctx, `${base()}/api.php/folder/${folderId}/files`)),
    limit(() => request(ctx, `${base()}/api.php/folder/${folderId}/subfolders`)),
  ]);

  for (const file of collectionOf(filesData)) {
    const name = getEntityName(file) || `file-${getEntityId(file)}`;
    const meta = fileMeta(file);
    files.push({
      id: getEntityId(file),
      name,
      path: [...segments, name].join('/'),
      folderId,
      size: meta.size,
      timestamp: meta.timestamp,
      ref: file,
    });
  }

  // Siblings are independent too. The result arrays end up in a different order than a
  // depth-first walk would produce, which no caller relies on: the engine builds a Map
  // from `folders` and sorts explicitly wherever depth matters (creation shallowest
  // first, deletion deepest first — see sync/engine.js).
  await Promise.all(
    collectionOf(subData).flatMap((sub) => {
      const subId = getEntityId(sub);
      if (!subId) return [];
      const subName = getEntityName(sub) || `folder-${subId}`;
      return [traverse(ctx, subId, [...segments, subName], files, folders, limit)];
    })
  );
}


// --- tree traversal, second route: JSON:API ----------------------------------
//
// jsonapi.php answers two endpoints that each return a whole course flat:
//
//   GET /jsonapi.php/v1/courses/{id}/folders     every folder, with a `parent` id
//   GET /jsonapi.php/v1/courses/{id}/file-refs   every file, with a `parent` folder id
//
// Both carry the parent as a real relationship id, so the tree is rebuilt locally
// instead of being walked over the wire — two paginated calls instead of 1 + 2N.
//
// This is a *listing* route only. Everything that changes something (upload, delete,
// create folder, permissions) stays on api.php: jsonapi.php is a separate front
// controller, and there is no reason to re-prove the write paths against it.
//
// Ids are shared between the two APIs — a file-ref id from jsonapi.php is the same id
// api.php/file/{id}/download expects — which is what lets the two be mixed at all.

// Fetch a page size that is large but not provocative. The server may silently cap it;
// jsonApiAll() is written so that a cap costs an extra request rather than losing rows.
const JSONAPI_PAGE = 100;

async function jsonApiRequest(ctx, pathAndQuery) {
  const url = `${base()}/jsonapi.php/v1/${pathAndQuery}`;
  const authHeader = oauthClient().toHeader(oauthClient().authorize({ url, method: 'GET' }, { key: ctx.accessToken, secret: ctx.accessTokenSecret }));
  const response = await fetch(url, { method: 'GET', headers: { ...authHeader, Accept: 'application/vnd.api+json' } });
  if (!response.ok) throw new Error(`JSON:API request failed: ${response.status} ${response.statusText}`);
  return JSON.parse(await response.text());
}

// Page through a JSON:API collection.
//
// This installation reports no `meta.total`, so there is no count to page against and
// the loop has to run until the server stops handing out rows. Two consequences shape
// the loop: a short page must NOT end it (the server may have capped page[limit] below
// what we asked for, and stopping there would silently drop every folder past the cap),
// and the offset advances by what actually arrived rather than by what we requested.
// The id set is the stop condition and the safety net at once — a server that ignores
// page[offset] would otherwise return page one forever.
async function jsonApiAll(ctx, pathAndQuery) {
  const items = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const doc = await jsonApiRequest(ctx, `${pathAndQuery}${sep}page[offset]=${offset}&page[limit]=${JSONAPI_PAGE}`);
    const batch = Array.isArray(doc?.data) ? doc.data : [];
    const fresh = batch.filter((r) => r.id && !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    items.push(...fresh);
    if (fresh.length === 0) break;
    offset += batch.length;
  }
  return items;
}

// api.php returns chdate as unix seconds; the JSON:API serialises the same field as an
// ISO 8601 string. Getting this wrong is not a cosmetic difference: a timestamp of 0
// makes the engine read every remote file as older than its local copy, so the whole
// course would look stale in one direction and never sync back in the other.
function toUnixSeconds(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Math.trunc(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

// Build the same { rootFolderId, files, folders } the api.php walk produces.
//
// Every inconsistency below throws rather than skipping the row. That is deliberate:
// the caller falls back to the api.php walk on any error, and a silently dropped file
// would read to the engine as "deleted on the server" — which deletes the local copy.
// A slow listing is recoverable; a wrong one is not.
async function listTreeJsonApi(ctx, courseId) {
  const course = encodeURIComponent(courseId);
  const [rawFolders, rawFiles] = await Promise.all([
    jsonApiAll(ctx, `courses/${course}/folders`),
    jsonApiAll(ctx, `courses/${course}/file-refs`),
  ]);
  if (rawFolders.length === 0) throw new Error('JSON:API returned no folders for this course');

  // Invert the parent pointers into child lists, and find the one folder without a parent.
  const known = new Set(rawFolders.map((f) => f.id));
  const childrenOf = new Map();
  const roots = [];
  for (const folder of rawFolders) {
    const parentId = folder.relationships?.parent?.data?.id;
    // A parent outside this course's own list is the course itself hanging above the top
    // folder — treat it as no parent rather than as a broken edge.
    if (parentId && known.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(folder);
    } else {
      roots.push(folder);
    }
  }
  if (roots.length !== 1) throw new Error(`expected exactly one root folder, found ${roots.length}`);
  const rootFolderId = roots[0].id;

  // Breadth-first from the root, accumulating the path segments as we descend. The
  // visited set guards against a cycle in the parent pointers, which would otherwise
  // spin here forever.
  const folders = [];
  const segmentsById = new Map();
  const visited = new Set();
  const queue = [{ id: rootFolderId, segments: [] }];
  while (queue.length > 0) {
    const { id, segments } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    folders.push({ path: segments.join('/'), id });
    segmentsById.set(id, segments);
    for (const child of childrenOf.get(id) || []) {
      queue.push({ id: child.id, segments: [...segments, child.attributes?.name || `folder-${child.id}`] });
    }
  }
  // Anything the walk did not reach is a folder the server listed but hung off nothing
  // we can place — the tree would be incomplete, so hand the job back to api.php.
  if (folders.length !== rawFolders.length) {
    throw new Error(`${rawFolders.length - folders.length} folder(s) not reachable from the root`);
  }

  const files = rawFiles.map((fileRef) => {
    const folderId = fileRef.relationships?.parent?.data?.id;
    const segments = folderId ? segmentsById.get(folderId) : null;
    if (!segments) throw new Error(`file ${fileRef.id} sits in unknown folder ${folderId ?? '(none)'}`);
    const name = fileRef.attributes?.name || `file-${fileRef.id}`;
    const size = fileRef.attributes?.filesize;
    return {
      id: fileRef.id,
      name,
      path: [...segments, name].join('/'),
      folderId,
      size: size != null ? Number(size) : null,
      timestamp: toUnixSeconds(fileRef.attributes?.chdate),
      // downloadFileRef() only needs an id to build the api.php download url. Link-type
      // refs (storage 'url') carry no url here; api.php/file/{id}/download redirects for
      // those, so they still resolve.
      ref: { id: fileRef.id },
    };
  });

  return { rootFolderId, files, folders };
}

// --- file download / upload --------------------------------------------------

async function downloadFileRef(ctx, fileRef, destinationPath) {
  const fileRefId = fileRef?.id || fileRef?.file_id;
  if (!fileRefId) throw new Error('Missing file reference id for download');
  const downloadUrl = fileRef.storage === 'url' && fileRef.url
    ? new URL(fileRef.url, base()).toString()
    : `${base()}/api.php/file/${fileRefId}/download`;
  const authHeader = oauthClient().toHeader(oauthClient().authorize({ url: downloadUrl, method: 'GET' }, { key: ctx.accessToken, secret: ctx.accessTokenSecret }));
  const response = await fetch(downloadUrl, { method: 'GET', headers: authHeader, redirect: 'follow' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Download failed for ${fileRefId}: ${response.status} ${response.statusText} ${body}`);
  }
  await fs.promises.writeFile(destinationPath, Buffer.from(await response.arrayBuffer()));
}

// Stud.IP sometimes stores the file but returns 500 during post-processing hooks.
// If that happens, verify the file landed in the folder before treating it as failed.
async function uploadToFolder(ctx, folderId, filePath, fileName) {
  try {
    return await multipartRequest(ctx, `${base()}/api.php/file/${folderId}`, 'POST', filePath, fileName);
  } catch (uploadErr) {
    const data = await request(ctx, `${base()}/api.php/folder/${folderId}/files`);
    const found = collectionOf(data).find((f) => getEntityName(f) === fileName);
    if (!found) throw uploadErr;
    return found;
  }
}

// Resolve the server-assigned chdate of a just-uploaded file. Using the real remote
// timestamp (not local wall-clock) keeps the next sync from mistaking the server's
// own clock — or clock skew between machines — for a remote edit.
async function resolveTimestamp(ctx, newRef) {
  let ts = fileMeta(newRef).timestamp;
  if (!ts) {
    const fetched = await request(ctx, `${base()}/api.php/file/${getEntityId(newRef)}`);
    ts = fileMeta(fetched).timestamp;
  }
  return ts;
}

// --- engine-facing provider interface ----------------------------------------

// Pull an id out of a reference that may be a plain id, a "/semester/<id>" link,
// or a nested resource object.
function refId(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/semesters?\/([^/]+)\/?$/i);
    return match ? match[1] : value;
  }
  if (typeof value === 'object') return getEntityId(value) ?? value.id ?? value.data?.id ?? null;
  return null;
}

// Best-effort extraction of a course's semester id. In Stud.IP a course carries
// `start_semester` as a "/semester/<id>" link (sometimes a list of semesters);
// fall back to relationship style for installations that use it.
function semesterIdOf(course, attrs) {
  const direct = attrs.start_semester ?? attrs['start-semester'] ?? attrs.semester ?? attrs.semester_id;
  if (Array.isArray(direct)) return refId(direct[direct.length - 1]);
  return refId(direct)
    ?? refId(course.relationships?.['start-semester']?.data ?? course.relationships?.semester?.data);
}

// List the courses the authenticated user has access to, newest semester first.
// Routes: GET /user (current user) -> GET /user/:id/courses, with GET /semesters
// used to resolve readable semester labels and a begin timestamp for sorting.
async function listCourses(ctx) {
  const me = await request(ctx, `${base()}/api.php/user`);
  const userId = getEntityId(me);
  if (!userId) throw new Error('Could not determine current user id');

  // semester id -> { title, begin } for labelling and ordering.
  const semesters = new Map();
  try {
    for (const s of await requestAll(ctx, `${base()}/api.php/semesters`)) {
      const a = s.attributes ?? s;
      semesters.set(String(getEntityId(s)), {
        title: a.title ?? a.name ?? a.description ?? null,
        begin: Number(a.begin ?? a.start ?? a.seminars_begin ?? 0) || 0,
      });
    }
  } catch (err) { console.error('[studip] could not load semesters:', err.message); }

  const rawCourses = await requestAll(ctx, `${base()}/api.php/user/${userId}/courses`);
  const courses = rawCourses.map((c) => {
    const a = c.attributes ?? c;
    const sem = semesters.get(String(semesterIdOf(c, a)));
    return {
      id: getEntityId(c),
      name: getEntityName(c) || `course-${getEntityId(c)}`,
      semester: sem?.title ?? null,
      sortKey: sem?.begin ?? Number(a.chdate ?? a.mkdate ?? 0) ?? 0,
    };
  }).filter((c) => c.id);

  courses.sort((x, y) => y.sortKey - x.sortKey);
  return courses;
}

// The api.php route: walk the tree folder by folder. Kept as the fallback for
// installations without jsonapi.php (it predates the JSON:API by several releases) and
// for the case where the flat listing turns out inconsistent.
async function listTreeApiPhp(ctx, courseId) {
  const top = await request(ctx, `${base()}/api.php/course/${courseId}/top_folder`);
  const rootFolderId = getEntityId(top);
  if (!rootFolderId) throw new Error('No root folder found for course');
  const files = [];
  const folders = [];
  // One limiter per tree walk, so two courses syncing in sequence never share a budget.
  await traverse(ctx, rootFolderId, [], files, folders, createLimiter(TREE_CONCURRENCY));
  return { rootFolderId, files, folders };
}

// Prefer the JSON:API and fall back to the walk on any trouble at all — a missing
// jsonapi.php, a server error, or a listing that does not add up (listTreeJsonApi throws
// rather than hand back a tree with holes in it).
//
// The failure is not remembered between calls. On an installation without the JSON:API
// that costs one rejected request per course, against the 1 + 2N the walk needs anyway;
// caching it would trade that for a server that stays on the slow route until Sinka is
// restarted — and this one runs for months at a time.
async function listTree(ctx, courseId) {
  const startTime = performance.now();
  let route = 'JSON:API';
  let tree;
  try {
    tree = await listTreeJsonApi(ctx, courseId);
  } catch (err) {
    console.warn(`[studip] JSON:API listing unusable (${err.message}) — falling back to the api.php walk`);
    route = 'api.php';
    tree = await listTreeApiPhp(ctx, courseId);
  }
  console.log(`[studip] listed course tree via ${route} in ${Math.round(performance.now() - startTime)} ms`
    + ` (${tree.folders.length} folders, ${tree.files.length} files)`);
  return tree;
}

async function downloadFile(ctx, file, destPath) {
  await downloadFileRef(ctx, file.ref, destPath);
}

async function uploadFile(ctx, folderId, localPath, name) {
  const newRef = await uploadToFolder(ctx, folderId, localPath, name);
  return { id: getEntityId(newRef), timestamp: await resolveTimestamp(ctx, newRef) };
}

async function deleteFile(ctx, fileId) {
  await request(ctx, `${base()}/api.php/file/${fileId}`, 'DELETE');
}

async function createFolder(ctx, parentId, name) {
  const created = await request(ctx, `${base()}/api.php/folder/${parentId}/new_folder`, 'POST', { name });
  return { id: getEntityId(created) };
}

async function deleteFolder(ctx, folderId) {
  await request(ctx, `${base()}/api.php/folder/${folderId}`, 'DELETE');
}

async function isFolderEmpty(ctx, folderId) {
  try {
    const filesData = await request(ctx, `${base()}/api.php/folder/${folderId}/files`);
    const subData = await request(ctx, `${base()}/api.php/folder/${folderId}/subfolders`);
    return collectionOf(filesData).length === 0 && collectionOf(subData).length === 0;
  } catch {
    return false;
  }
}

async function canWriteFile(ctx, fileId) {
  try {
    const fileRef = await request(ctx, `${base()}/api.php/file/${fileId}`);
    const writable = fileRef?.is_writable ?? fileRef?.attributes?.is_writable;
    return writable !== undefined ? !!writable : true;
  } catch {
    return true;
  }
}

async function canCreateInFolder(ctx, folderId) {
  return permAllows(await folderPerms(ctx, folderId), ['write', 'mkfolder', 'createfolder', 'edit', 'writable', 'is_writable']);
}

async function canDeleteFolder(ctx, folderId) {
  // Destructive: deny unless the permissions payload positively grants it.
  return permAllows(await folderPerms(ctx, folderId), ['delete', 'write', 'edit', 'writable', 'is_writable'], { defaultAllow: false });
}

// --- authentication ----------------------------------------------------------

// The auth context the engine passes back to every provider call. Tokens are read
// from the encrypted per-provider credential store.
function getContext() {
  try {
    const c = credentials.load('studip');
    return c?.accessToken ? { accessToken: c.accessToken, accessTokenSecret: c.accessTokenSecret } : null;
  } catch (err) {
    console.error('Failed to load StudIP credentials:', err.message);
    return null;
  }
}

function registerAuthRoutes(app) {
  app.get("/auth/studip", async (req, res) => {
    try {
      const requestData = { url: `${base()}/dispatch.php/api/oauth/request_token`, method: 'GET' };
      const authHeader = oauthClient().toHeader(oauthClient().authorize(requestData));
      const response = await fetch(requestData.url, { method: 'GET', headers: authHeader });
      if (!response.ok) throw new Error(`Failed to get request token: ${response.statusText}`);

      const params = new URLSearchParams(await response.text());
      const requestToken = params.get('oauth_token');
      const requestTokenSecret = params.get('oauth_token_secret');
      if (!requestToken || !requestTokenSecret) throw new Error('Invalid response from request_token endpoint');

      req.session.studipRequest = { token: requestToken, secret: requestTokenSecret };
      req.session.save((err) => {
        if (err) {
          console.error('Failed to persist request token session:', err);
          return res.status(500).send('Authentication failed');
        }
        const callbackUrl = `${publicBase(req)}/auth/studip/callback`;
        res.redirect(`${base()}/dispatch.php/api/oauth/authorize?oauth_token=${requestToken}&oauth_callback=${encodeURIComponent(callbackUrl)}`);
      });
    } catch (error) {
      console.error('OAuth request token error:', error);
      res.status(500).send('Authentication failed');
    }
  });

  app.get("/auth/studip/callback", async (req, res) => {
    try {
      const { oauth_token, oauth_verifier } = req.query;
      if (!oauth_token || !oauth_verifier) throw new Error('Missing oauth_token or oauth_verifier');

      const pending = req.session.studipRequest;
      if (!pending?.token || !pending?.secret) throw new Error('No request token found in session');

      const requestData = {
        url: `${base()}/dispatch.php/api/oauth/access_token?oauth_verifier=${encodeURIComponent(oauth_verifier)}`,
        method: 'GET',
      };
      const authHeader = oauthClient().toHeader(oauthClient().authorize(requestData, { key: pending.token, secret: pending.secret }));
      const response = await fetch(requestData.url, { method: 'GET', headers: authHeader });
      if (!response.ok) {
        console.error('Access token error response:', await response.text());
        throw new Error(`Failed to get access token: ${response.status} ${response.statusText}`);
      }

      const params = new URLSearchParams(await response.text());
      const accessToken = params.get('oauth_token');
      const accessTokenSecret = params.get('oauth_token_secret');
      if (!accessToken || !accessTokenSecret) throw new Error('Invalid response from access_token endpoint');

      credentials.save('studip', { accessToken, accessTokenSecret });
      delete req.session.studipRequest;
      res.redirect('/sync');
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.status(500).send('Authentication failed');
    }
  });
}

module.exports = {
  name: 'studip',
  registerAuthRoutes,
  getContext,
  listCourses,
  listTree,
  // Both routes stay reachable by name for scripts/bench-studip-tree.js.
  listTreeJsonApi,
  listTreeApiPhp,
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
