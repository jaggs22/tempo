# Tempo

An installable web app (PWA) for private music teachers and their students: timetable and bookings, fees, practice logs and events. Built first for Carnatic vocal studios. Runs free on Cloudflare's free plan.

## What it does

**Teachers** (sign in with Google)
- Create a studio with a link (`/s/<name>`) and a short code. Every student must be approved.
- Set teaching hours, studio rules, an address for in-person classes, and online classrooms (a personal meeting room or a dedicated classroom link from any app).
- Approve accounts and set rules per learner: class length (30-minute blocks), fee per class or per 30 minutes, currency per account, group-class eligibility, in-person and/or online, and whether they may reschedule, book extras or use make-up credits.
- Run the timetable: weekly classes per learner, one-off classes, moves and cancellations, time off (cancels and credits affected classes), group classes with no seat limit.
- See fees due per account, record payments, read each learner's practice log, and publish events (lecdems, competitions, presentations) that notify every student and can collect what each will sing.

**Students and families** (no Google, no email, no password)
- Must install Tempo to the home screen before joining. The studio link only shows install steps in a browser.
- Join with the studio code and their full name (the username). Siblings or a group can share one account; the family confirms who is on it.
- See upcoming classes with the join link or address, classes done, make-up credits and fees due.
- Reschedule within the teacher's cut-off, cancel (on-time cancellations earn a make-up credit if the teacher allows), book make-ups and extra classes in free 30-minute blocks.
- Log daily practice (visible only to the teacher), RSVP to events and enter their piece, join group classes they are eligible for.
- On a new phone: type the full name; the teacher approves the device.

## How it is built

| Part | Choice | Why |
|---|---|---|
| Hosting + API | Cloudflare Worker (`src/`) | Free plan, never sleeps |
| Database | Cloudflare D1 (SQLite), `migrations/` | Free plan, no server to run |
| App | Plain HTML/CSS/JS in `public/` | No build step |
| Notifications | Web Push with VAPID (`src/push.js`) | No paid push service; verified against RFC 8291's test vector |

Double booking is impossible at the database level: every class claims its 30-minute blocks in `booking_blocks`, whose primary key is studio + block start.

## Run it locally

```bash
npm install
npm run db:local            # create the local database
echo "DEV_MODE=1" > .dev.vars
npm run dev                 # http://localhost:8787
```

`DEV_MODE=1` adds a "Developer sign-in" for teachers. To act as an installed student in a desktop browser, open `http://localhost:8787/?installed=1` (this only works on localhost).

Tests:

```bash
npm test                    # Web Push encryption against the RFC test vector
npm run test:flow           # 14 end-to-end flows against the running dev server
```

## Deploy (one time, about 20 minutes)

1. **Cloudflare.** Create a free account, then:
   ```bash
   npx wrangler login
   npx wrangler d1 create tempo     # copy the database_id into wrangler.toml
   npm run db:remote
   npm run deploy                   # prints your https://tempo.<you>.workers.dev URL
   ```
2. **Google sign-in for teachers.** In Google Cloud Console, create an OAuth client (type: Web application) with the redirect URI `https://<your-url>/api/auth/google/callback`. Tempo only asks for basic sign-in (name and email) at this stage. Then:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   Optional: set `TEACHER_EMAILS` in `wrangler.toml` to limit who can create a studio.
3. **Notifications.**
   ```bash
   npm run vapid                    # prints a key pair
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT     # e.g. mailto:you@example.com
   ```
4. **Automatic deploys (optional).** Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository secrets. Every push to `main` then runs the tests, applies migrations and deploys.

## Notes and limits

- The install-first rule is enforced by the app, not cryptographically. It also matters for notifications: iPhones and iPads only allow web push for apps added to the home screen.
- Students' sessions live on each installed device for up to 400 days.
- Online classes use fixed rooms for now. The schema already supports auto-generated Zoom, Google Meet and Teams links per class; those need each provider's account connection and are the next phase. Provider limits to keep in mind: Zoom's free plan caps meetings at 40 minutes, Google Meet's free plan caps group calls at 60 minutes, and Teams links can only be generated for paid Microsoft 365 work or school accounts.
- Next phase: Google Calendar sync for teachers, auto-generated meeting links, class reminders, PayNow/UPI QR on the fees screen.
