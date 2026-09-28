# Device test: working offline past the one-hour sign-in lapse

**What this proves:** a crew member who signed in with signal keeps working
with **no signal for longer than an hour**: cold start, start the day or clock
in, photos, checklist, supplies, complete. Then signal returns and everything
replays under a fresh sign-in.

**Why the 2026-08-09 airplane-mode test passed and this one might not have:**
the sign-in token lasts one hour and renews only with signal. That test ran
inside the hour. Past it, the old app sat on the logo for about 50 seconds and
then showed the **login screen**, where nothing can be saved.

Takes about 20 minutes with the clock shortcut in step 2, or about 90 minutes
the slow way.

---

## 0. Get the new code onto a test phone

Pick one.

**A. A preview build (the crews' phones are not touched).**
Build from the PR branch; the fix is in the embedded bundle, so no OTA is
needed. The `preview` channel's branch has no updates, so the build runs
exactly what it was built from.
```bash
eas build --profile preview --platform android
```
Android gives you an APK: open the build link on the phone and install it.
For iPhone, use `--platform ios`. The phone must be registered for internal
builds first (`eas device:create`), and the install is signed ad hoc.

**B. The production OTA (reaches the fleet).** Only after Todd okays it. Follow
the normal publish steps (branch `offline-test`, verify the manifest on both
lanes), then on the test phone: Profile → **Check for updates** and restart.
The Profile build line must show the new update id before you start.
Rollback, if needed: republish the previous update group.

## 1. Warm up online (Wi-Fi or cell)

1. Sign in as a crew member of a company that has a job today, assigned to them.
   Use a **daily-shift** company for one run and a **per-job** company for another if you can.
2. Open **Home**. Open **today's job**. Open **Supplies** on it. Open **Schedule**.
   This is the "loaded my day this morning" step: what gets saved on the phone is
   what you can see offline later.
3. Profile: note the build line. Sync card: should show nothing pending.

## 2. Make the sign-in lapse with no signal

Turn **Airplane Mode ON** (and Wi-Fi off) first, then pick one:

- **Fast (clock shortcut, ~1 min):** Settings → General → Date & Time → turn
  **Set Automatically OFF** → set the time **2 hours ahead**. The app checks
  expiry against the phone's clock, so this is the same situation as the hour
  passing. Airplane Mode has to be on first, or the phone corrects the clock.
- **Slow (real, ~65 min):** leave the phone in Airplane Mode for **65 minutes or
  more**. Background the app or lock the phone; either is fine.

Do not use the "shorten the JWT expiry" route on the production Supabase
project: it is project-wide, so every crew token would lapse sooner.

## 3. Cold start with no signal ← the main check

1. **Force-quit** the app (swipe it away). Start a stopwatch and open it.
2. **Expect:** logo for a normal launch (a few seconds at most), then **Home**
   with the amber banner *"You're offline — showing last saved data"* and
   today's jobs.
   **Fail:** logo for ~50 s, or the **login screen**.
3. Write down the seconds from tap to Home.

## 4. Work the day offline

Each screen should open in a second or two, never ~25 seconds. Note any that
stall.

- **Daily-shift company:** Home → **Start my day** → alert *"Saved on your phone
  — will sync when you have signal again"* → the shift timer runs.
- **Per-job company:** open the job → **Clock in** → same "Saved on your phone"
  alert.
- Take **2 photos** on the job: they show *⏳ waiting to upload*.
- Tick **3–4 checklist items**.
- **Supplies:** the banner shows offline; mark one item **low**, change a count,
  **Save** → "Saved on your phone". Leave and reopen Supplies: your changes
  are still there.
- **Complete the job** (per-job: clock out, then complete).
- Profile → the Sync card shows several **pending**, no errors.
- *(Optional, "Always" location granted)* Walk 300 m or more from the
  property while still clocked in. The "you left the property" reminder should
  still arrive. Before this fix, tracking switched itself off in a dead zone.

## 5. Signal returns

1. If you used the clock shortcut: turn **Airplane Mode OFF first**, then
   Date & Time → **Set Automatically ON**.
   If you waited: turn Airplane Mode off.
2. Keep the app open on Home for ~30 s, then **pull to refresh**.
3. **Expect:** within about half a minute the offline banner is gone after a
   refresh, photos lose their ⏳, and Profile → Sync shows **0 pending, no
   sync problems**.

## 6. Confirm the replay on the web (owner view)

- The job's **time entry** exists with the **offline clock-in time**, not the
  reconnect time (daily-shift: the shift starts at the offline tap).
- Job status is **Completed**. The checklist ticks and **both photos** are
  there.
- **Supplies:** one set of rows for the job, with your "low" flag and count.
  **No duplicates.**

Optional server-side check (replace the id). `created_at` is when the row
reached the server, so it should be at the reconnect time, while
`clocked_in_at` is the offline tap:
```sql
select id, entry_type, clocked_in_at, clocked_out_at, created_at
from job_time_entries where user_id = '<crew users.id>'
order by created_at desc limit 5;
```

## 7. Send back

- Seconds from tap to Home in step 3.
- Any screen that took more than ~3 s offline.
- Screenshots of Home offline (with the banner), and of the Profile build line
  and Sync card after reconnecting.
- Anything that showed the login screen, an error, or a duplicate.

### If it fails
- **Login screen at step 3:** first confirm the phone ran the new code. The
  Profile build line has to match the build or update from step 0, and an OTA
  needs a Check for updates plus a restart. If it did, note how long the logo
  showed.
- **A write shows an error instead of "Saved on your phone":** screenshot the
  message. That is a real server answer, not a signal problem.
