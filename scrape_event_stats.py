#!/usr/bin/env python3
"""
scrape_event_stats.py
 
Visits each UK/Ireland parkrun's own homepage with a REAL headless browser
(so JavaScript-rendered content actually loads) and saves the "event
statistics" widget shown at the bottom of each page to a CSV (for you to
review/edit) and a matching JSON file (event-stats.json, which the app
reads at runtime).
 
Why a real browser is needed here, when the app's own live lookups aren't:
  - The /results/eventhistory/ page blocks plain server-side requests
    (anti-bot protection — confirmed via a direct 405 response).
  - The "event statistics" widget on the plain homepage is added by
    JavaScript after the page loads, so a plain server-side fetch (like
    the app's Netlify function) never sees it at all, regardless of bot
    protection — this is a different, more fundamental limitation.
A real browser, run occasionally by a person, sidesteps both.
 
⚠️ Please be a considerate visitor to parkrun's site:
  - This runs sequentially, with a real delay between requests (3s by
    default) — please don't reduce this to make it faster.
  - Run this occasionally (e.g. weekly at most), not on every deploy or
    every game session — these numbers update slowly regardless.
  - Whether to run this at all is a judgment call worth thinking about:
    parkrun appears to have intentionally reduced visibility of some of
    these numbers elsewhere on their own site (see the app's README for
    the fuller context on this). This script makes it possible, but
    doesn't make that decision for you.
 
Setup:
    pip install playwright requests
    playwright install chromium
 
Usage:
    python scrape_event_stats.py
    python scrape_event_stats.py --limit 10          # small test run first
    python scrape_event_stats.py --delay 5            # be even gentler
"""
 
import argparse
import csv
import json
import re
import time
from datetime import datetime, timezone
 
import requests
from playwright.sync_api import sync_playwright
 
EVENTS_URL = "https://images.parkrun.com/events.json"
ADULT_SERIES_ID = 1
ALLOWED_COUNTRIES = {"United Kingdom", "Ireland"}
COUNTRY_DOMAINS = {
    "parkrun.org.uk": "United Kingdom",
    "parkrun.ie": "Ireland",
}
DEFAULT_DELAY_SECONDS = 3.0
STAT_LABELS = ["Events", "Finishers", "Finishes", "Volunteers", "PBs", "Average finish time", "Groups"]
 
 
def fetch_events():
    print(f"Fetching {EVENTS_URL} ...")
    resp = requests.get(EVENTS_URL, timeout=20)
    resp.raise_for_status()
    data = resp.json()
 
    countries = data.get("countries", {})
    country_domain = {}
    for cid, info in countries.items():
        url = (info or {}).get("url") or ""
        domain = re.sub(r"^https?://", "", url).rstrip("/")
        country_domain[cid] = domain
 
    events = []
    for feature in data.get("events", {}).get("features", []):
        props = feature.get("properties", {})
        if props.get("seriesid") != ADULT_SERIES_ID:
            continue
        domain = country_domain.get(str(props.get("countrycode")), "")
        bare = domain.replace("www.", "")
        country = COUNTRY_DOMAINS.get(bare)
        if country not in ALLOWED_COUNTRIES:
            continue
        events.append({
            "id": feature.get("id"),
            "slug": props.get("eventname"),
            "domain": domain,
            "name": (props.get("EventLongName") or props.get("EventShortName") or "").replace(" parkrun", ""),
        })
    print(f"Found {len(events)} UK/Ireland events.")
    return events
 
 
def scrape_one(page, event):
    url = f"https://{event['domain']}/{event['slug']}/"
    page.goto(url, timeout=20000, wait_until="domcontentloaded")
 
    # The stats widget is added by JS after load — wait for it specifically
    # rather than assuming a fixed delay is long enough.
    try:
        page.wait_for_selector("text=event statistics", timeout=8000)
    except Exception:
        return None  # widget never appeared for this event — leave it blank
 
    body_text = page.inner_text("body")
    stats = {}
    for label in STAT_LABELS:
        m = re.search(re.escape(label) + r":\s*([^\n]+)", body_text)
        if m:
            stats[label] = m.group(1).strip()
    return stats or None
 
 
def main():
    parser = argparse.ArgumentParser(description="Scrape real UK/Ireland parkrun event statistics with a real browser.")
    parser.add_argument("--out-csv", default="event_stats.csv")
    parser.add_argument("--out-json", default="event-stats.json")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS)
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N events (for a test run)")
    args = parser.parse_args()
 
    events = fetch_events()
    if args.limit:
        events = events[:args.limit]
        print(f"Limiting to first {len(events)} events for this run.")
 
    rows = []
    json_out = {}
 
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ))
 
        for i, event in enumerate(events, 1):
            print(f"[{i}/{len(events)}] {event['name']} ({event['slug']}) ...", end=" ", flush=True)
            try:
                stats = scrape_one(page, event)
            except Exception as e:
                stats = None
                print(f"ERROR: {e}", end=" ")
 
            print("OK" if stats else "no stats widget found")
 
            rows.append({
                "id": event["id"],
                "slug": event["slug"],
                "domain": event["domain"],
                "name": event["name"],
                "events": (stats or {}).get("Events", ""),
                "finishers": (stats or {}).get("Finishers", ""),
                "finishes": (stats or {}).get("Finishes", ""),
                "volunteers": (stats or {}).get("Volunteers", ""),
                "pbs": (stats or {}).get("PBs", ""),
                "avg_time": (stats or {}).get("Average finish time", ""),
                "groups": (stats or {}).get("Groups", ""),
                "scraped_at": datetime.now(timezone.utc).isoformat(),
            })
 
            if stats:
                json_out[event["slug"]] = {
                    "events": stats.get("Events"),
                    "finishers": stats.get("Finishers"),
                    "finishes": stats.get("Finishes"),
                    "volunteers": stats.get("Volunteers"),
                    "pbs": stats.get("PBs"),
                    "avgTime": stats.get("Average finish time"),
                    "groups": stats.get("Groups"),
                }
 
            time.sleep(args.delay)
 
        browser.close()
 
    if rows:
        with open(args.out_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nWrote {len(rows)} rows to {args.out_csv}")
 
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(json_out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(json_out)} entries with real stats to {args.out_json}")
    print(f"({len(rows) - len(json_out)} events had no stats widget found, out of {len(rows)} total)")
 
 
if __name__ == "__main__":
    main()