// ---- parkrun World – Daily Map Quiz ----

const EVENTS_URL = "https://images.parkrun.com/events.json";
const DAILY_COUNT = 8;
const ADULT_SERIES_ID = 1; // 2 = junior parkrun, excluded

const INK_DOT = "#2B3A4A";
const TRAIL_GREEN = "#2F6B4F";

// Maps a parkrun country "domain" (from the events.json countries block) to a
// display name. Not exhaustive — falls back to showing the raw domain for
// any country not listed here, so nothing breaks if parkrun adds a new one.
const COUNTRY_NAMES = {
  "parkrun.org.uk": "United Kingdom",
  "parkrun.ie": "Ireland",
  "parkrun.com.au": "Australia",
  "parkrun.co.nz": "New Zealand",
  "parkrun.co.za": "South Africa",
  "parkrun.us": "United States",
  "parkrun.ca": "Canada",
  "parkrun.com.de": "Germany",
  "parkrun.co.at": "Austria",
  "parkrun.dk": "Denmark",
  "parkrun.fi": "Finland",
  "parkrun.fr": "France",
  "parkrun.it": "Italy",
  "parkrun.pl": "Poland",
  "parkrun.lt": "Lithuania",
  "parkrun.my": "Malaysia",
  "parkrun.sg": "Singapore",
  "parkrun.no": "Norway",
  "parkrun.se": "Sweden",
  "parkrun.com.na": "Namibia",
  "parkrun.co.zw": "Zimbabwe",
  "parkrun.jp": "Japan",
  "parkrun.nl": "Netherlands",
  "parkrun.si": "Slovenia",
  "parkrun.ru": "Russia"
};

let allEvents = [];
let queue = [];
let currentIndex = 0;
let currentEvent = null;
let score = 0;
let streak = 0;
let distances = [];
let awaitingClick = true;
let pendingGuessLatLng = null;
let quizMode = "daily"; // "daily" | "bonus"

let map, guessMarker, answerMarker, guessLine;
let locationDots = {};
let pendingMarker = null;

async function init() {
  try {
    const res = await fetch(EVENTS_URL);
    if (!res.ok) throw new Error("Network response was not ok");
    const raw = await res.json();
    allEvents = parseEvents(raw);
  } catch (err) {
    showLoadError();
    return;
  }

  if (allEvents.length === 0) {
    showLoadError();
    return;
  }

  map = L.map("map", {
    worldCopyJump: false,
    renderer: L.canvas() // canvas renderer copes far better with 2,000+ markers than SVG
  }).setView([20, 10], 2);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  map.on("click", onMapClick);

  placeLocationDots();

  document.getElementById("guess-btn").addEventListener("click", confirmGuess);
  document.getElementById("skip-btn").addEventListener("click", skipRound);
  document.getElementById("end-restart-btn").addEventListener("click", () => resetProgress());
  document.getElementById("end-bonus-btn").addEventListener("click", () => loadQueue("bonus"));

  await loadQueue("daily");
}

function parseEvents(raw) {
  const countries = raw.countries || {};
  const countryInfo = {};
  Object.keys(countries).forEach(id => {
    const url = (countries[id] && countries[id].url) || "";
    const fullDomain = url.replace(/^https?:\/\//, "").replace(/\/$/, ""); // e.g. www.parkrun.com.de
    const bareDomain = fullDomain.replace(/^www\./, "");                   // e.g. parkrun.com.de
    countryInfo[id] = {
      domain: fullDomain,
      name: COUNTRY_NAMES[bareDomain] || bareDomain || "Unknown"
    };
  });

  const features = (raw.events && raw.events.features) || [];
  return features
    .filter(f => f.properties && f.properties.seriesid === ADULT_SERIES_ID)
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      const info = countryInfo[p.countrycode] || {};
      return {
        id: f.id,
        name: (p.EventLongName || p.EventShortName || p.eventname || "").replace(/ parkrun$/i, ""),
        shortName: p.EventShortName || p.eventname,
        slug: p.eventname, // URL slug, e.g. "hasenheide" — used to build the course-page URL
        location: p.EventLocation || "",
        country: info.name || "Unknown",
        domain: info.domain || "", // e.g. "www.parkrun.com.de" — also used to build the course-page URL
        lat, lon
      };
    })
    .filter(ev => Number.isFinite(ev.lat) && Number.isFinite(ev.lon));
}

function todayString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, resets at UTC midnight
}

// Simple deterministic string hash -> 32-bit seed
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// Mulberry32 seeded PRNG
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getTodaysSeed() {
  return hashSeed(todayString());
}

function getBonusSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

// Builds a queue of exactly `count` events that each have a confirmed
// Wikipedia photo, working through a seeded shuffle of the full location
// list in small concurrent batches until enough photo-bearing events are
// found. Falls back to padding with photo-less events only in the
// (extremely unlikely) case the whole list is exhausted first.
async function buildQueueWithPhotos(seed, count) {
  const shuffled = seededShuffle(allEvents, seed);
  const maxCandidates = Math.min(shuffled.length, 80);
  const concurrency = 6;
  const result = [];
  let i = 0;

  while (result.length < count && i < maxCandidates) {
    const batch = shuffled.slice(i, i + concurrency);
    i += concurrency;
    const settled = await Promise.all(batch.map(async ev => {
      const summary = await tryFindPhoto(ev);
      return { ev, summary };
    }));
    for (const { ev, summary } of settled) {
      if (result.length >= count) break;
      if (summary && summary.thumbnail) {
        ev._wikiSummary = summary;
        result.push(ev);
      }
    }
  }

  if (result.length < count) {
    for (const ev of shuffled) {
      if (result.length >= count) break;
      if (result.includes(ev)) continue;
      if (ev._wikiSummary === undefined) ev._wikiSummary = await tryFindPhoto(ev);
      result.push(ev);
    }
  }

  return result;
}

async function tryFindPhoto(ev) {
  const candidates = [ev.location, ev.shortName, ev.name].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const summary = await fetchWikiSummary(candidate);
      if (summary) return summary;
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

async function fetchWikiSummary(title) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&format=json&origin=*&srlimit=1`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();
  const hit = searchData.query && searchData.query.search && searchData.query.search[0];
  if (!hit) return null;

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) return null;
  const summary = await summaryRes.json();
  if (summary.type === "disambiguation") return null;

  return {
    title: summary.title,
    extract: summary.extract,
    thumbnail: summary.thumbnail && summary.thumbnail.source,
    pageUrl: summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page
  };
}

function placeLocationDots() {
  allEvents.forEach(ev => {
    const dot = L.circleMarker([ev.lat, ev.lon], {
      radius: 3,
      color: "#ffffff",
      weight: 0.5,
      fillColor: INK_DOT,
      fillOpacity: 0.7,
      interactive: false
    }).addTo(map);
    locationDots[ev.id] = dot;
  });
}

function markDotAnswered(id) {
  const dot = locationDots[id];
  if (dot) dot.setStyle({ fillColor: TRAIL_GREEN, fillOpacity: 0.95, radius: 5 });
}

function resetQueueDots() {
  queue.forEach(ev => {
    const dot = locationDots[ev.id];
    if (dot) dot.setStyle({ fillColor: INK_DOT, fillOpacity: 0.7, radius: 3 });
  });
}

async function loadQueue(mode) {
  quizMode = mode;
  showBuildingState(mode);
  const seed = mode === "bonus" ? getBonusSeed() : getTodaysSeed();
  queue = await buildQueueWithPhotos(seed, DAILY_COUNT);
  resetProgress();
}

function resetProgress() {
  currentIndex = 0;
  score = 0;
  streak = 0;
  distances = [];
  resetQueueDots();
  updateScoreDisplay();
  document.getElementById("end-screen").classList.add("hidden");
  document.getElementById("skip-btn").classList.remove("hidden");
  document.getElementById("skip-btn").disabled = false;
  document.getElementById("skip-btn").textContent = "Skip";
  document.getElementById("round-total").textContent = queue.length;
  document.getElementById("day-label").textContent =
    quizMode === "bonus" ? "Bonus round \u00b7 a fresh random 8" : "Today's set \u00b7 " + todayString();
  buildStampTrail();
  nextRound();
}

function showBuildingState(mode) {
  document.getElementById("prompt-name").textContent =
    mode === "bonus" ? "Shuffling a fresh 8\u2026" : "Finding today's 8 parkruns\u2026";
  document.getElementById("prompt-country").textContent = "";
  document.getElementById("prompt-hint").textContent = "Checking which ones have a photo available.";
  document.getElementById("prompt-photo").innerHTML = '<div class="photo-loading">\u2026</div>';
  document.getElementById("feedback").classList.add("hidden");
  setGuessButtonEnabled(false);
  document.getElementById("skip-btn").disabled = true;
}

function buildStampTrail() {
  const el = document.getElementById("stamp-trail");
  el.innerHTML = "";
  queue.forEach((ev, i) => {
    const s = document.createElement("div");
    s.className = "stamp pending";
    s.id = "stamp-" + i;
    el.appendChild(s);
  });
}

function setStampActive(index) {
  document.querySelectorAll(".stamp").forEach(s => s.classList.remove("active"));
  const s = document.getElementById("stamp-" + index);
  if (s) s.classList.add("active");
}

function markStampResult(index, km) {
  const s = document.getElementById("stamp-" + index);
  if (!s) return;
  s.classList.remove("pending", "active");
  if (km === null || km > 300) {
    s.classList.add("done-far");
  } else if (km <= 50) {
    s.classList.add("done-gold");
  } else {
    s.classList.add("done-close");
  }
}

function nextRound() {
  clearMapMarkers();
  awaitingClick = true;
  pendingGuessLatLng = null;
  setGuessButtonEnabled(false);

  if (currentIndex >= queue.length) {
    showEndScreen();
    return;
  }

  currentEvent = queue[currentIndex];
  setStampActive(currentIndex);
  document.getElementById("round-number").textContent = currentIndex + 1;
  document.getElementById("prompt-name").textContent = currentEvent.name + " parkrun";
  document.getElementById("prompt-country").textContent = "";
  document.getElementById("prompt-hint").textContent = "Click the map, then confirm with \u201cGuess\u201d.";
  document.getElementById("feedback").classList.add("hidden");

  const photoBox = document.getElementById("prompt-photo");
  const summary = currentEvent._wikiSummary;
  photoBox.innerHTML = summary && summary.thumbnail
    ? `<img src="${summary.thumbnail}" alt="Photo hint for this parkrun">`
    : '<div class="photo-empty">No photo available for this location.</div>';
}

function skipRound() {
  if (!awaitingClick) {
    // Round already answered — the button is now labeled "Next".
    // registerResult() already advanced currentIndex, so just move on.
    nextRound();
    return;
  }
  registerResult(null);
}

function onMapClick(e) {
  if (!awaitingClick) return;

  pendingGuessLatLng = e.latlng;
  if (pendingMarker) {
    pendingMarker.setLatLng(e.latlng);
  } else {
    pendingMarker = L.marker(e.latlng, { icon: redIcon(), opacity: 0.75 }).addTo(map);
  }
  setGuessButtonEnabled(true);
}

function confirmGuess() {
  if (!awaitingClick || !pendingGuessLatLng) return;
  registerResult(pendingGuessLatLng);
}

function setGuessButtonEnabled(enabled) {
  document.getElementById("guess-btn").disabled = !enabled;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function pointsForDistance(km) {
  // Full points inside 50km (roughly "same metro area" at world scale),
  // tapering to 0 at 3000km+ (about a quarter of the way round the globe).
  if (km <= 50) return 1000;
  if (km >= 3000) return 0;
  const t = (km - 50) / (3000 - 50);
  return Math.round(1000 * (1 - t));
}

function registerResult(clickLatLng) {
  awaitingClick = false;
  setGuessButtonEnabled(false);

  const trueLatLng = L.latLng(currentEvent.lat, currentEvent.lon);
  answerMarker = L.marker(trueLatLng, { icon: greenIcon() }).addTo(map);
  markDotAnswered(currentEvent.id);

  let km = null;
  let points = 0;

  if (clickLatLng) {
    if (pendingMarker) {
      pendingMarker.setOpacity(1);
      guessMarker = pendingMarker;
      pendingMarker = null;
    } else {
      guessMarker = L.marker(clickLatLng, { icon: redIcon() }).addTo(map);
    }
    guessLine = L.polyline([clickLatLng, trueLatLng], { color: "#B9541D", weight: 2, dashArray: "6 6" }).addTo(map);
    km = haversineKm(clickLatLng.lat, clickLatLng.lng, currentEvent.lat, currentEvent.lon);
    points = pointsForDistance(km);
    distances.push(km);
  }

  markStampResult(currentIndex, km);
  pendingGuessLatLng = null;
  score += points;
  streak = points > 0 ? streak + (km !== null && km <= 200 ? 1 : 0) : 0;

  updateScoreDisplay();
  showFeedback(km, points);
  loadEnrichment(currentEvent);
  loadEventInfo(currentEvent);

  const bounds = clickLatLng ? L.latLngBounds([clickLatLng, trueLatLng]) : L.latLngBounds([trueLatLng, trueLatLng]);
  map.fitBounds(bounds.pad(0.6), { maxZoom: 8 });

  currentIndex++;
  document.getElementById("skip-btn").textContent = currentIndex >= queue.length ? "Show results" : "Next";
}

function showFeedback(km, points) {
  const el = document.getElementById("feedback");
  el.classList.remove("hidden", "correct-close", "correct-ok", "correct-far");

  let title, cls;
  if (km === null) {
    title = "Skipped";
    cls = "correct-far";
  } else if (km <= 50) {
    title = "Bullseye! 🎯";
    cls = "correct-close";
  } else if (km <= 300) {
    title = "Very close!";
    cls = "correct-close";
  } else if (km <= 1000) {
    title = "Not bad.";
    cls = "correct-ok";
  } else {
    title = "Way off.";
    cls = "correct-far";
  }

  el.classList.add(cls);
  const distText = km === null ? "" : `<br>Distance: <strong>${km.toFixed(0)} km</strong>`;
  el.innerHTML = `
    <div class="fb-title">${title}</div>
    <div>${currentEvent.name} parkrun is in ${currentEvent.location ? currentEvent.location + ", " : ""}${currentEvent.country}.${distText}</div>
    <div class="fb-points">+${points} points</div>
    <div class="enrichment loading" id="enrichment-box">Looking up a photo…</div>
    <div class="event-info loading" id="event-info-box">Looking up a photo from this parkrun…</div>
  `;
}

// The event's header photo & course description are shown only after
// guessing (a reveal, not a hint) — kept consistent with how this panel
// worked before, and the photo (of participants, not the venue) isn't
// generally a giveaway anyway.
async function loadEventInfo(event) {
  const info = await fetchEventInfo(event);
  if (currentEvent !== event) return; // player has already moved to a new round; discard

  const box = document.getElementById("event-info-box");
  if (!box) return;

  box.classList.remove("loading", "empty");

  if (!info) {
    box.classList.add("empty");
    box.textContent = "Event details couldn't be loaded for this location.";
    return;
  }

  const photoHtml = info.photoUrl
    ? `<img class="event-photo" src="${info.photoUrl}" alt="Participants at ${escapeHtml(event.name)} parkrun">`
    : "";
  const descHtml = info.description ? `<p class="course-desc">${escapeHtml(info.description)}</p>` : "";
  const linkHtml = info.pageUrl
    ? `<a href="${info.pageUrl}" target="_blank" rel="noopener">Visit ${escapeHtml(event.name)} parkrun's page ↗</a>`
    : "";

  if (!photoHtml && !descHtml) {
    box.classList.add("empty");
    box.innerHTML = `Photo & description not found automatically for this one. ${linkHtml}`;
    return;
  }

  box.innerHTML = `${photoHtml}${descHtml}${linkHtml}`;
}

async function fetchEventInfo(ev) {
  if (!ev.domain || !ev.slug) return null;
  try {
    const res = await fetch(`/api/event-info?domain=${encodeURIComponent(ev.domain)}&slug=${encodeURIComponent(ev.slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data; // { pageUrl, photoUrl, description }
  } catch (e) {
    return null;
  }
}

async function loadEnrichment(event) {
  const box = document.getElementById("enrichment-box");
  if (!box) return; // user may have moved on already

  // Reuse the result already fetched for the pre-guess photo hint, if we have it.
  if (event._wikiSummary !== undefined) {
    if (event._wikiSummary) {
      renderEnrichment(box, event._wikiSummary);
    } else {
      box.classList.remove("loading");
      box.classList.add("empty");
      box.textContent = "No Wikipedia entry found for this location.";
    }
    return;
  }

  const candidates = [event.location, event.shortName, event.name].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const summary = await fetchWikiSummary(candidate);
      if (summary) {
        event._wikiSummary = summary;
        renderEnrichment(box, summary);
        return;
      }
    } catch (e) {
      // try next candidate
    }
  }

  event._wikiSummary = null;
  box.classList.remove("loading");
  box.classList.add("empty");
  box.textContent = "No Wikipedia entry found for this location.";
}

function renderEnrichment(box, summary) {
  box.classList.remove("loading", "empty");
  const img = summary.thumbnail ? `<img src="${summary.thumbnail}" alt="${escapeHtml(summary.title)}">` : "";
  const extract = summary.extract ? truncate(summary.extract, 220) : "";
  const link = summary.pageUrl ? ` <a href="${summary.pageUrl}" target="_blank" rel="noopener">Wikipedia ↗</a>` : "";
  box.innerHTML = `${img}<div class="enrichment-text"><strong>${escapeHtml(summary.title)}</strong><br>${escapeHtml(extract)}${link}</div>`;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function updateScoreDisplay() {
  document.getElementById("score-value").textContent = score;
  document.getElementById("streak-value").textContent = streak;
  document.getElementById("bottom-total").textContent = score;
  if (distances.length) {
    const avg = distances.reduce((a, b) => a + b, 0) / distances.length;
    document.getElementById("avg-distance").textContent = avg.toFixed(0) + " km";
  } else {
    document.getElementById("avg-distance").textContent = "–";
  }
}

function clearMapMarkers() {
  if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
  if (answerMarker) { map.removeLayer(answerMarker); answerMarker = null; }
  if (guessLine) { map.removeLayer(guessLine); guessLine = null; }
  if (pendingMarker) { map.removeLayer(pendingMarker); pendingMarker = null; }
}

function showEndScreen() {
  const avg = distances.length ? (distances.reduce((a, b) => a + b, 0) / distances.length).toFixed(0) : "–";
  const maxScore = queue.length * 1000;
  const heading = quizMode === "bonus" ? "Bonus round done! \ud83c\udf89" : "Today's quiz is done! \ud83c\udf89";
  document.querySelector("#end-screen h2").textContent = heading;
  document.getElementById("end-summary").innerHTML =
    `You scored <strong>${score}</strong> out of ${maxScore} possible points.<br>` +
    `Average distance: <strong>${avg} km</strong>.`;
  document.getElementById("end-screen").classList.remove("hidden");
  document.getElementById("skip-btn").classList.add("hidden");
  map.setView([20, 10], 2);
}

function showLoadError() {
  document.querySelector(".app-main").innerHTML = `
    <div class="error-banner">
      <strong>Couldn't load today's parkrun locations.</strong><br><br>
      This app fetches live data directly from parkrun's own event map feed
      (images.parkrun.com/events.json) in your browser. That request may have
      failed because of a network issue, or because parkrun's feed is
      temporarily unavailable or has changed its access policy.<br><br>
      Try reloading the page in a minute. If it keeps failing, open the
      browser console (F12) for the exact error.
    </div>
  `;
}

function greenIcon() {
  return L.icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41], iconAnchor: [12, 41]
  });
}

function redIcon() {
  return L.icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41], iconAnchor: [12, 41]
  });
}

init();
