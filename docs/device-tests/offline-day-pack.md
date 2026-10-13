# Device test: the next morning's stops with no signal (offline day pack)

**What this proves:** a crew member whose phone had signal the evening before
can cold-open the app the next morning with **no signal at all** and still see
the day: Home's stops, each stop's door code and arrival instructions, its
checklist, Supplies and the prep card, without ever having opened those stops
online. Start my day, Start and Complete queue on the phone and sync when signal
returns.

**Why this was broken:** Home saved a copy of *today* only, so the copy saved at
night came back empty the next morning, and a stop the crew never opened online
had no door code at all (CKS Perfections, Nichole, 2026-10-13).

**What it does not do:** download anything while the app is closed. The app has
to be open (or come to the foreground) with signal after the office dispatches.
Downloading with the app never opened needs a native background task and a
store build.

Takes about 20 minutes with the clock shortcut in step 3.

---

## 0. Get the new code onto a test phone

Same two routes as `offline-sign-in-lapse.md` step 0: a preview build from the
PR branch, or the production OTA **only after Todd okays it** (Profile build line
must show the new update id before you start).

## 1. Set up tomorrow in the office (web)

1. In a test company, assign the test crew member **two cleans tomorrow** at
   properties that have a **door code**, **arrival instructions** and a
   **checklist** (template or seeded rows). Give one a crew note.
2. Use a **daily-shift** company if you can (CKS runs daily); a per-job company
   is worth a second run.
3. Do **not** open those cleans on the phone.

## 2. The evening: open the app once with signal

1. Wi-Fi or cell on. Open the app (cold start is fine). Stay on **Home** for
   ~15 seconds.
2. Under the header, Home should read **"✓ Saved for offline · {time} · {n} stops"**,
   where n counts tonight's remaining stops plus tomorrow's two.
3. Optional, the push path: have the office assign one more clean for tomorrow
   while the app is open. Within a few seconds n goes up by one on its own
   (the assignment push / realtime row forces a refresh).
4. Do not open the new cleans. Lock the phone.

## 3. The next morning, no signal

Turn **Airplane Mode ON** (and Wi-Fi off) first, then either:

- **Fast:** Settings → General → Date & Time → **Set Automatically OFF** → set
  the date to **tomorrow, 7:00 AM**. (Airplane Mode first, or the phone corrects
  the clock.) This also puts the sign-in token well past its hour, which is the
  real morning.
- **Real:** wait for the morning.

Then **force-quit the app** (swipe it away) and open it.

## 4. Check, still in Airplane Mode

- [ ] The app opens to **Home** (not the login screen), with the amber
      "You're offline — showing last saved data" banner.
- [ ] Home lists **this morning's two stops** — not empty, not yesterday's.
      Today / Done / Remaining count only today.
- [ ] The **Saved for offline** line still shows, with "Yesterday {time}" and
      the stops ahead.
- [ ] Open the first stop: **door code** (🔐) and **arrival instructions** show.
- [ ] Its **checklist** shows the property's rooms and tasks (not the generic
      8-item default).
- [ ] The office's **crew note** shows; "Stop 1 of 2" shows if the office set a route.
- [ ] **Supplies** opens with the property's items.
- [ ] The **prep card** ("Get ready for today") shows lines for these stops, if
      the company uses linens / arrivals.
- [ ] Note what the **property cover photo** does (see the PR: it is not part of
      the pack; it shows only if the phone still holds it from an earlier view,
      otherwise the "add a photo" placeholder shows).

## 5. Work the day offline

- [ ] Daily company: **Start my day** → "Saved on your phone" message; the
      shift timer runs.
- [ ] Per-job company: **Clock In** on the first stop.
- [ ] Tick checklist items, take a before photo.
- [ ] **Complete** the stop (photos queue; completion queues).

## 6. Signal back

1. Airplane Mode **OFF** first, then **Set Automatically ON** for the clock.
2. Bring the app to the foreground. Within ~30 seconds:
   - [ ] Profile → Sync card: nothing pending, nothing rejected.
   - [ ] The web shows the shift / clock-in with the **tap time** from step 5,
         the ticks, the photo, and the stop completed.
   - [ ] The Saved for offline line refreshes to the current time.

If any step fails, note the step, the screen, and the Profile build line.
