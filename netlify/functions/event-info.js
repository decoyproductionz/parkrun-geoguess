// Fetches a parkrun event's own pages server-side (not subject to the
// browser CORS restrictions that block the app from reading parkrun's
// website pages directly) and extracts:
//   1. The event's header photo (from its homepage) — typically a shot of
//      participants at that parkrun, e.g. www.parkrun.org.uk/northampton/
//   2. The course description paragraph (from its /course/ page)
//   3. Event stats — first edition date, average weekly finishers, and
//      average finish time (from its /results/eventhistory/ page)
//
// Usage: /api/event-info?domain=www.parkrun.org.uk&slug=northampton

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};

const USER_AGENT = "Mozilla/5.0 (compatible; parkrun-world-quiz/1.0)";
const FETCH_TIMEOUT_MS = 6000; // don't let one slow/blocked page sink the whole response

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const slug = url.searchParams.get("slug");

  if (!domain || !slug) {
    return new Response(
      JSON.stringify({ error: "Missing domain or slug parameter" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Only ever fetch parkrun's own domains — keeps this from being usable
  // as an open proxy for arbitrary URLs.
  if (!/^www\.parkrun\.[a-z.]+$/i.test(domain)) {
    return new Response(
      JSON.stringify({ error: "domain must be a www.parkrun.* address" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const homeUrl = `https://${domain}/${encodeURIComponent(slug)}/`;
  const courseUrl = `https://${domain}/${encodeURIComponent(slug)}/course/`;
  const historyUrl = `https://${domain}/${encodeURIComponent(slug)}/results/eventhistory/`;

  const [homeRes, courseRes, historyRes] = await Promise.allSettled([
    fetchWithTimeout(homeUrl),
    fetchWithTimeout(courseUrl),
    fetchWithTimeout(historyUrl)
  ]);

  // Each of these three is independent and wrapped in its own try/catch —
  // a problem extracting one (especially stats, the least verified) must
  // never wipe out the other two, which is what was happening before.
  let photoUrl = null;
  try {
    if (homeRes.status === "fulfilled" && homeRes.value.ok) {
      const homeHtml = await homeRes.value.text();
      photoUrl = extractHeaderPhoto(homeHtml);
    }
  } catch (e) { /* leave photoUrl null */ }

  let description = null;
  try {
    if (courseRes.status === "fulfilled" && courseRes.value.ok) {
      const courseHtml = await courseRes.value.text();
      description = extractDescription(courseHtml);
    }
  } catch (e) { /* leave description null */ }

  let stats = null;
  try {
    if (historyRes.status === "fulfilled" && historyRes.value.ok) {
      const historyHtml = await historyRes.value.text();
      stats = extractEventStats(historyHtml);
    }
  } catch (e) { /* leave stats null */ }

  return new Response(
    JSON.stringify({ pageUrl: homeUrl, coursePageUrl: courseUrl, historyUrl, photoUrl, description, stats }),
    {
      status: 200,
      // Event pages change rarely — cache for 12h to keep this fast and cheap.
      headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=43200" }
    }
  );
};

export const config = { path: "/api/event-info" };

// The header photo is pulled from the page's Open Graph image tag —
// <meta property="og:image" content="...">  — the same tag sites set so
// Slack/Facebook/Twitter show a preview photo when a link is shared. This
// is a very standard, template-independent convention, and on a page like
// parkrun's event homepage it's a good bet the OG image *is* that header
// photo, since it's meant to represent the page visually. Falls back to
// Twitter's equivalent tag, then a generic <img> heuristic, if not found.
function extractHeaderPhoto(html) {
  let match = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (!match) match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (match) return match[1];

  match = html.match(/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (match) return match[1];

  // Last-resort heuristic: an <img> tag whose class/src hints at being a
  // header/hero/banner image. Less reliable than the tags above — this is
  // the part most likely to need adjustment once tested against real pages.
  match = html.match(/<img[^>]+class=["'][^"']*(?:header|hero|banner)[^"']*["'][^>]+src=["']([^"']+)["']/i)
    || html.match(/<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*(?:header|hero|banner)[^"']*["']/i);
  if (match) return match[1];

  return null;
}

// Best-effort: the course description sits in a <p> shortly after a
// section heading, but that heading text is translated per country. This
// list covers parkrun's current locales; if a locale isn't matched here,
// the app just omits the description rather than guessing wrong. Worth
// extending this list if testing turns up a country whose heading isn't
// recognized.
const DESCRIPTION_HEADINGS = [
  "Course Description", "Streckenbeschreibung", "Description du parcours",
  "Descripción del recorrido", "Descrizione del percorso", "Opis trasy",
  "Trasos aprašymas", "Baneomtale", "Ratakuvaus", "Banbeskrivning",
  "Parcoursbeschrijving", "Popis trate"
];

function extractDescription(html) {
  for (const heading of DESCRIPTION_HEADINGS) {
    const idx = html.indexOf(heading);
    if (idx === -1) continue;

    const chunk = html.slice(idx + heading.length, idx + heading.length + 6000);
    const pMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) {
      const text = stripTags(pMatch[1]);
      if (text.length > 20) return truncate(text, 500);
    }
  }
  return null;
}

function stripTags(str) {
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

// Best-effort: parkrun's per-event history page lists one row per weekly
// occurrence, typically with an event number, a date, and a finisher
// count (and sometimes an average time). From that we derive:
//   - first edition: the date of the earliest event number
//   - average finishers: mean of the finisher counts across all rows
//   - average time: mean of any time-shaped values found, if present
//
// I couldn't verify this page's actual layout myself (see README) — this
// parses defensively via generic patterns (a numeric first cell, a
// date-shaped cell, a small-integer cell, a MM:SS-shaped cell) rather than
// assuming specific column positions, and returns null rather than
// guessing wrong if nothing matches. Very likely needs real-world
// adjustment — see the extractEventStats caveat in the README.
function extractEventStats(html) {
  // Cap the amount of HTML scanned — a blocked/challenge page can return
  // unexpected content, and there's no reason to regex-scan more than a
  // generous chunk of a normal results table.
  const scanText = html.length > 500000 ? html.slice(0, 500000) : html;
  const rows = [...scanText.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const events = [];

  for (const rowMatch of rows) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripTags(m[1]));
    if (cells.length < 3) continue;

    const eventNum = parseInt((cells[0] || "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(eventNum)) continue; // skip header rows / non-data rows

    const dateCell = cells.find(c => /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(c));
    const finisherCell = cells.find(c => /^\d{1,4}$/.test(c.trim()));
    const timeCell = cells.find(c => /^\d{1,2}:\d{2}(:\d{2})?$/.test(c.trim()));

    events.push({
      eventNum,
      date: dateCell || null,
      finishers: finisherCell ? parseInt(finisherCell, 10) : null,
      timeStr: timeCell || null
    });
  }

  if (events.length === 0) return null;

  events.sort((a, b) => a.eventNum - b.eventNum);
  const first = events[0];

  const finisherCounts = events.map(e => e.finishers).filter(n => Number.isFinite(n));
  const avgFinishers = finisherCounts.length
    ? Math.round(finisherCounts.reduce((a, b) => a + b, 0) / finisherCounts.length)
    : null;

  const timeSeconds = events.map(e => parseTimeToSeconds(e.timeStr)).filter(n => n !== null);
  const avgTime = timeSeconds.length
    ? secondsToTimeStr(Math.round(timeSeconds.reduce((a, b) => a + b, 0) / timeSeconds.length))
    : null;

  return {
    firstEdition: first.date,
    totalEvents: events.length,
    avgFinishers,
    avgTime
  };
}

function parseTimeToSeconds(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function secondsToTimeStr(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}