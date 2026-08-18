// Fetches a parkrun event's own pages server-side (not subject to the
// browser CORS restrictions that block the app from reading parkrun's
// website pages directly) and extracts:
//   1. The event's header photo (from its homepage) — typically a shot of
//      participants at that parkrun, e.g. www.parkrun.org.uk/northampton/
//   2. The course description paragraph (from its /course/ page)
//   3. Event stats (experimental — see below)
//
// Usage: /api/event-info?domain=www.parkrun.org.uk&slug=northampton&id=2761

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};

const USER_AGENT = "Mozilla/5.0 (compatible; parkrun-world-quiz/1.0)";
const FETCH_TIMEOUT_MS = 6000; // don't let one slow/blocked page sink the whole response
const THIRD_PARTY_TIMEOUT_MS = 5000;

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
  const id = url.searchParams.get("id"); // parkrun's own numeric event ID, optional — only needed for stats

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

  const [homeRes, courseRes] = await Promise.allSettled([
    fetchWithTimeout(homeUrl),
    fetchWithTimeout(courseUrl)
  ]);

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

  // ---- Experimental: event stats via a third-party API ----
  // parkrun's own site doesn't give us this (see the two comments below),
  // so this calls an unofficial, independently-hosted API
  // (parkrun-api.rggs.xyz, github.com/BadgerHobbs/Parkrun-API-Python)
  // that scrapes parkrun's results tables on its own server. This is a
  // real external dependency outside anyone's control — it could go
  // offline, change its response shape, or disappear entirely with no
  // warning. It's wrapped independently so that if it fails, photo and
  // description are completely unaffected.
  //
  // What we can honestly derive from its /history endpoint: event count,
  // average weekly finishers, and first edition date. We can't get
  // "Finishers" (unique participants), "Volunteers" (unique), "PBs", or
  // "Groups" from this endpoint — those need per-runner data this
  // endpoint doesn't expose, so the app is explicit that these three
  // numbers are an approximation, not identical to parkrun's own count.
  let stats = null;
  if (id) {
    try {
      const historyRes = await fetchWithTimeout(
        `https://parkrun-api.rggs.xyz/v1/events/${encodeURIComponent(id)}/history`,
        THIRD_PARTY_TIMEOUT_MS
      );
      if (historyRes.ok) {
        const history = await historyRes.json();
        stats = deriveStatsFromHistory(history);
      }
    } catch (e) { /* third-party API unreachable/down — leave stats null */ }
  }

  return new Response(
    JSON.stringify({ pageUrl: homeUrl, coursePageUrl: courseUrl, photoUrl, description, stats }),
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

// The third-party API's /history endpoint returns one entry per weekly
// occurrence, e.g. { eventNumber, date (DD/MM/YYYY), finishers, volunteers,
// male, female, maleTime, femaleTime }. We derive event count, average
// finishers, and first edition date from this — see the caveat above
// about what this can't tell us.
function deriveStatsFromHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return null;

  const finisherCounts = history
    .map(h => parseInt(h.finishers, 10))
    .filter(n => Number.isFinite(n));
  const avgFinishers = finisherCounts.length
    ? Math.round(finisherCounts.reduce((a, b) => a + b, 0) / finisherCounts.length)
    : null;

  const parsedDates = history
    .map(h => h.date)
    .filter(Boolean)
    .map(d => {
      const parts = d.split("/").map(Number); // DD/MM/YYYY per documented format
      if (parts.length !== 3 || parts.some(isNaN)) return null;
      const [day, month, year] = parts;
      return { raw: d, time: new Date(year, month - 1, day).getTime() };
    })
    .filter(Boolean);

  let firstEdition = null;
  if (parsedDates.length) {
    parsedDates.sort((a, b) => a.time - b.time);
    firstEdition = parsedDates[0].raw;
  }

  return { totalEvents: history.length, avgFinishers, firstEdition };
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