// Wave Dash Worker: NOAA CORS proxy + surf session sync to GitHub.
//
// Secrets (set with `wrangler secret put <NAME>`):
//   GITHUB_TOKEN  fine-grained token with Contents read/write on b0tt0mturn/wavedash
//   SESSIONS_KEY  passphrase the page sends with each sync
//
// Routes:
//   GET  /?url=<encoded NOAA url>   proxy; only the NOAA hosts below are allowed
//   POST /sessions                  body: { key, sessions: [ ...session objects ] }
//
// Sessions are written to data/sessions-<YEAR>.json on the BRANCH branch, one
// file per year of the surf frame. Each POST makes one commit.

const REPO = "b0tt0mturn/wavedash";
const BRANCH = "data";
const GH_API = `https://api.github.com/repos/${REPO}/contents`;

const PROXY_HOSTS = ["www.ndbc.noaa.gov", "ndbc.noaa.gov", "api.tidesandcurrents.noaa.gov"];
const PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WaveDash/1.0";

const MAX_BODY_BYTES = 400_000;
const MAX_BATCH = 50;
const MAX_WRITE_ATTEMPTS = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/sessions") {
      if (request.method !== "POST") return text("Use POST.", 405);
      return handleSessions(request, env);
    }
    return handleProxy(request);
  },
};

function text(msg, status = 200) {
  return new Response(msg, { status, headers: { ...CORS, "Content-Type": "text/plain" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/* ---------------------------------------------------------------------------
   NOAA proxy (unchanged behaviour, except the host allowlist)
--------------------------------------------------------------------------- */
async function handleProxy(request) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return text("Missing target 'url' parameter.", 400);

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return text("Bad 'url' parameter.", 400);
  }
  if (targetUrl.protocol !== "https:" || !PROXY_HOSTS.includes(targetUrl.hostname)) {
    return text("Host not allowed.", 403);
  }

  try {
    const response = await fetch(targetUrl, { headers: { "User-Agent": PROXY_UA } });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...CORS, "Content-Type": "text/plain" },
    });
  } catch (err) {
    return text(`Worker Error: ${err.message}`, 500);
  }
}

/* ---------------------------------------------------------------------------
   Session sync
--------------------------------------------------------------------------- */
async function handleSessions(request, env) {
  if (!env.GITHUB_TOKEN || !env.SESSIONS_KEY) {
    return text("Sessions not configured.", 500);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return text("Body too large.", 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return text("Bad JSON.", 400);
  }

  if (!safeEqual(String(body?.key ?? ""), env.SESSIONS_KEY)) {
    return text("Unauthorized.", 401);
  }

  const incoming = Array.isArray(body.sessions) ? body.sessions : [];
  if (incoming.length < 1 || incoming.length > MAX_BATCH) {
    return text(`Send between 1 and ${MAX_BATCH} sessions.`, 400);
  }
  if (incoming.some(s => !isValidSession(s))) {
    return text("Invalid session data.", 400);
  }

  // Group by the year of the surf frame so each file stays small.
  const byYear = new Map();
  for (const s of incoming) {
    const year = s.frameTimestamp.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(s);
  }

  const results = {};
  try {
    for (const [year, sessions] of byYear) {
      results[year] = await appendToYearFile(year, sessions, env);
    }
  } catch (err) {
    return json({ ok: false, error: err.message, results }, 502);
  }
  return json({ ok: true, results }, 201);
}

function isValidSession(s) {
  return !!s
    && typeof s === "object"
    && typeof s.id === "string" && /^[a-z0-9]{1,40}$/i.test(s.id)
    && Number.isInteger(s.rating) && s.rating >= 1 && s.rating <= 5
    && typeof s.frameTimestamp === "string"
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/.test(s.frameTimestamp)
    && (s.note === undefined || s.note === null || (typeof s.note === "string" && s.note.length <= 200));
}

// Reads the year file, adds any sessions whose id isn't already there, and
// writes it back. A stale sha (someone else wrote first) is retried.
async function appendToYearFile(year, sessions, env) {
  const path = `data/sessions-${year}.json`;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const current = await githubGet(path, env);
    const known = new Set(current.list.map(s => s.id));
    const fresh = sessions.filter(s => !known.has(s.id));
    if (fresh.length === 0) {
      return { added: 0, total: current.list.length };
    }

    const next = current.list.concat(fresh);
    const res = await githubPut(path, next, current.sha, fresh.length, env);
    if (res.ok) {
      return { added: fresh.length, total: next.length };
    }
    if (res.status !== 409 && res.status !== 422) {
      throw new Error(`GitHub PUT ${path} failed with ${res.status}`);
    }
    // Conflict: loop around, re-read, and try again.
  }
  throw new Error(`Too many write conflicts on ${path}`);
}

async function githubGet(path, env) {
  const res = await fetch(`${GH_API}/${path}?ref=${BRANCH}`, { headers: ghHeaders(env) });
  if (res.status === 404) return { list: [], sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed with ${res.status}`);

  const meta = await res.json();
  if (meta.encoding !== "base64") {
    throw new Error(`${path} is too large for the Contents API; split the year file.`);
  }
  const bytes = Uint8Array.from(atob(meta.content.replace(/\n/g, "")), c => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return { list: Array.isArray(parsed) ? parsed : [], sha: meta.sha };
}

async function githubPut(path, list, sha, addedCount, env) {
  // One session per line, so the diffs on GitHub read cleanly.
  const contents = "[\n" + list.map(s => JSON.stringify(s)).join(",\n") + "\n]\n";
  const bytes = new TextEncoder().encode(contents);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }

  const payload = {
    message: `Log ${addedCount} surf session${addedCount === 1 ? "" : "s"} to ${path}`,
    content: btoa(bin),
    branch: BRANCH,
  };
  if (sha) payload.sha = sha;

  return fetch(`${GH_API}/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wavedash-sessions",
  };
}

// Compares two strings without returning early on the first mismatch.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
