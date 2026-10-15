# Launch post drafts

Replace `<SITE>` with the live `*.pages.dev` URL and `<REPO>` with the GitHub URL before posting.

---

## Product Hunt

**Name:** Jetlog

**Tagline (60 chars):** The life story of the exact plane you're sitting in

**Description (260 chars):**
Type your flight number or the tail number on the plane. Jetlog shows that airframe's age, owner, where it flew
this month and how many of its siblings are airborne now, then makes you a shareable card. Free, open source, no
sign-up.

**First comment (maker):**

Hi Product Hunt! I built Jetlog because every time I board I wonder about the specific plane: is this 737 brand
new or older than me? Where was it this morning?

How it works:
- Your flight number is matched to the aircraft broadcasting it right now, including regional partners (a Delta
  Connection flight often flies as SkyWest).
- The transponder code unlocks the FAA registry record: build year, serial, engines, registered owner.
- A nightly pipeline streams ~4 GB of volunteer ADS-B data from ADSB.lol and turns it into a 30-day flight history
  for every US-registered aircraft.

It runs entirely on free tiers (GitHub Actions + Cloudflare), and the data-quality page shows honestly where
coverage has gaps. Private owners are never named, and aircraft in the FAA's privacy programs only get a type-level
card.

US aircraft get the full story; everything else gets a reduced card for now. I'd love to hear which plane you looked
up!

<SITE> · Code: <REPO>

---

## r/aviation

**Title:** I made a free site that tells you the life story of the exact plane you're on (age, owner, last 30 days of flights)

**Body:**

Boarding a 737 and wondering if it's 2 or 25 years old? Type the flight number (or the tail number from the gate
window) into <SITE>.

You get:
- Build year, serial, engines and "registered to current owner since" from the FAA registry (with an age percentile
  against every other US-registered airframe of that model)
- Live altitude/speed/route if it's flying
- Every flight it made in the last 30 days, segmented from ADSB.lol's volunteer feeder data
- How many of the same type are airborne worldwide right now
- A "Plane Wrapped" card to share

Some things I learned building it:
- About a fifth of US airliners are registered to banks, trusts or lessors, not the airline whose paint is on them.
- The oldest common US airliner type is the 757-200 (median age 32 years); Southwest gets the most airborne hours
  out of each aircraft per flying day in my sample (8.4 h).
- Published callsign → route tables are surprisingly stale. Airlines reuse a flight number across several legs.
- Business jets opt out of public tracking (FAA LADD/PIA) at the highest rate, about 27% of those seen flying vs 7%
  of piston aircraft. Those aircraft get a type-only card, no tracking.

Limitations: US (N-number) aircraft get the full card; coverage depends on volunteers' receivers, so oceanic legs
show as "partly observed" rather than guessed. Not for anything operational; it's for curiosity.

It's free, open source (<REPO>), and if you run an ADS-B receiver, consider feeding ADSB.lol, since all of this
depends on it.
