# parkrun World – Daily Map Quiz

Every day, 8 parkrun locations from anywhere in the world are selected (the
same 8 for everyone, Wordle-style) and you guess where each one is by
clicking the map.

No backend, no build step, no maintained dataset — just static
HTML/CSS/JS. All location data and photos are fetched live, in the
visitor's browser, each time the page loads.

## Files

- `index.html` – page structure
- `style.css` – styling
- `app.js` – map, daily selection, scoring, Wikipedia photo lookups, course info
- `netlify/functions/event-info.js` – server-side function for the header photo & course description (new — see below)
- `netlify.toml` – tells Netlify where to find the function

There's no `data.json` this time — see below.

## ⚠️ The one thing to verify first: cross-origin access

This app fetches `https://images.parkrun.com/events.json` directly from the
browser. This is the same file parkrun's own site uses to power its
interactive event map, and since that widget is loaded from a different
subdomain than the file itself, the endpoint *should* already support
cross-origin requests (the browser security feature called CORS) — but I
wasn't able to confirm this myself, because my own sandboxed environment
blocks that domain entirely at the network level (unrelated to CORS).

**Please check this first**, before assuming anything else is broken:

1. Run the app locally (Live Server, as before).
2. Open the browser dev tools (F12) → Console tab.
3. If you see a red CORS error mentioning `images.parkrun.com`, the feed
   doesn't allow browser-side requests, and the app will show a friendly
   "couldn't load today's locations" message instead of the quiz.

**If that happens**, the fix is to fetch the file server-side instead of
client-side — for example with a small Netlify Function (a few lines of
JavaScript that runs on Netlify's servers, not in the browser, so it isn't
subject to CORS) that fetches the feed and passes it through to the app. Say
the word and I can build that piece if it's needed.

## Running it locally in VS Code

Same as the German version: `data.json` doesn't apply here, but `fetch()`
still needs to run over HTTP, not `file://`. Use the Live Server extension
(right-click `index.html` → "Open with Live Server") or:
```
python3 -m http.server 8000
```

## How the daily rotation works

No server, database, or scheduled job needed. Today's date (`YYYY-MM-DD`,
UTC) is hashed into a seed for a deterministic shuffle of the full location
list, and the first 8 **with a confirmed Wikipedia photo** are taken (see
below). Every visitor computing that same hash on the same date gets the
identical 8 locations, and it automatically changes at UTC midnight.
Reloading the page doesn't reshuffle it.

## Guaranteeing 8 photos, and playing more

Photo availability is checked *before* the round starts, not during it:
the app works through the date-seeded shuffle of the full location list,
checking small batches of candidates in parallel against Wikipedia, until
it has 8 confirmed to have a photo. This takes a moment on load (you'll
see "Finding today's 8 parkruns…"), but it means every round genuinely has
an image to guess from — no more silent gaps.

After finishing, two options appear:
- **Replay these 8** — same set, same order, instantly (no new lookups).
- **Play 8 more** — a fresh, genuinely random set of 8 (not tied to the
  date), independently checked for photo availability the same way. This
  is a good "just one more round" option that doesn't interfere with
  tomorrow's daily set, since it uses a random seed rather than the date.

## Design

The visual identity is built around a "running passport" idea — parkrun is
fundamentally about visiting different parks, and the progress indicator
above the prompt card (a row of stamp-like circles, filling in gold/green/
grey as you play) is the signature element, standing in for a plain round
counter. The palette is a warm parchment background with forest green and
trail-blaze rust accents, paired with a display serif (Fraunces) for
headings and a monospace face (IBM Plex Mono) for scores and stats — meant
to feel a little like race-bib numbers and field-journal notes rather than
a generic dashboard.

## Scoring

Distance-based, same idea as the Germany version but rescaled for world
geography: full points inside 50km, tapering to zero at 3,000km+.

## The Wikipedia photo & enrichment

As soon as a round starts, the app searches Wikipedia (via its public,
CORS-enabled API) for the parkrun's venue name and shows a photo — right
alongside the name — as a hint you can use before guessing. e.g. searching
"Bushy Park" finds the London royal park's Wikipedia photo. This won't find
a match for every location (smaller or newer venues often don't have their
own article), and that's expected — it just shows "No photo available."

Because this is a text-based name search rather than a coordinate lookup,
there's a small chance of matching the wrong place if a location's name is
generic and shared with somewhere more famous (e.g. a small "Richmond"
parkrun could in theory match a Wikipedia article about a different,
better-known Richmond). This hasn't come up in testing, but it's worth
knowing about if a photo ever looks obviously wrong for the location shown.

After you guess, the same lookup result (cached, not re-fetched) is shown
again alongside a short text extract and a link back to the source article
for attribution.

## What's deliberately not included, and why

- **First edition date per event**: only available on each event's
  individual results-history page on parkrun's own site — there's no bulk
  feed for it. Getting this for 2,600+ locations would need a scraping
  pipeline (fetch each event page, parse the date, cache it somewhere),
  which is a real but separate project from this static site. If you want
  it later, the German dataset from the first version already demonstrates
  the pattern on a much smaller scale (72 events) — that could be the
  starting point.
- **A curated venue photo per location**: no scalable, openly-licensed
  source exists for thousands of specific parkrun photos. The Wikipedia
  lookup is the practical middle ground. Google Street View is a viable
  alternative (keyed to exact coordinates rather than a name match, so
  more reliably on-target) but requires your own billed Google Cloud API
  key — happy to switch back to that approach again if you want it later.

## Header photo & course description (new)

After you guess, the feedback panel now also shows, when available:
- The event's own header photo from its parkrun homepage — usually a shot
  of participants at that parkrun, e.g. the photo at the top of
  `www.parkrun.org.uk/northampton/`
- A short course description, pulled from that event's `/course/` page

This is deliberately a **post-guess reveal, not a pre-guess hint**, kept
consistent with how this panel worked before — though unlike a route map,
a photo of runners generally wouldn't give the location away regardless.

**Honest caveat**: this works by fetching each event's own pages
server-side and extracting the photo from the page's Open Graph image tag
(`<meta property="og:image">` — the same tag sites use so a photo shows up
when the link is shared on Slack, Twitter, etc.), with a couple of
fallback methods if that tag isn't present. I built this based on the one
page you showed me (Northampton) and this being a very standard,
template-independent web convention — but I wasn't able to inspect the
raw HTML of parkrun's site myself to fully verify it, since my tools can't
reach that domain. **It will likely need a round of real-world testing**
once it's live — if a photo or description doesn't show up for some
locations, that's expected at this stage, not necessarily a sign
something's broken. If you hit cases that don't work, send me what you see
(or the page's raw HTML, via "View Page Source" in the browser) and I'll
refine the extraction logic. Also worth knowing: not every parkrun event
page has a header photo or description — some newer or smaller events may
genuinely have neither, in which case the panel just links to the real
page instead.

(A course-map version of this same idea — embedding the parkrun's own
hand-drawn Google My Maps route — was explored first but set aside for
now in favor of this photo. The approach would be similar if you want to
revisit it later.)

## ⚠️ This feature changes how you deploy — Netlify Drop won't work anymore

Everything up to now has been pure static files (HTML/CSS/JS), which is
why drag-and-drop onto Netlify Drop worked. The event-info feature needs a
small **serverless function** (`netlify/functions/event-info.js`) to get
around a browser restriction — parkrun's own website pages don't allow
other sites' JavaScript to read them directly (unlike the JSON feed and
Wikipedia, which are built to be called this way), so a small piece of
server-side code has to fetch the page on the app's behalf instead. And
**Netlify Drop only deploys static files, not functions.** You'll need to
switch to one of two proper deployment methods:

### Option A (recommended): Connect a GitHub repo to Netlify

This is the standard, sustainable way to run a site with functions, and
it also means every future update deploys automatically on `git push`
rather than needing a manual drag-and-drop each time.

1. Create a new repository on GitHub and push this project folder to it.
2. In Netlify, go to **Add new site → Import an existing project**, and
   connect that GitHub repo.
3. Build settings: leave the build command empty, and set the publish
   directory to `.` (the repo root) — `netlify.toml` in this folder
   already has this configured, so Netlify should detect it automatically.
4. Deploy. You'll get a new Netlify URL (or you can point your existing
   site at this new deploy source instead, if you'd rather keep the same
   link — ask if you want help with that specifically).

### Option B: Netlify CLI (no GitHub required)

1. Install Node.js if you don't already have it, then run
   `npm install -g netlify-cli`.
2. From the project folder, run `netlify login`, then `netlify init`
   (link it to a new or existing site).
3. To deploy: `netlify deploy --prod` from the project folder each time
   you want to publish an update — this replaces drag-and-drop as your
   update method for this specific site.

### Testing locally before deploying

Live Server won't run the function. Instead, with the Netlify CLI
installed (see Option B, step 1), run `netlify dev` from the project
folder — this serves the site *and* runs the function locally, so
`fetch("/api/event-info?...")` works exactly like it will once deployed.

## Deploying it

**This project can no longer be deployed via Netlify Drop** — see the
section above about why. Use one of the two proper methods described
there (GitHub-connected Netlify, or the Netlify CLI) instead.
