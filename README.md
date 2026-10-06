# MedClass

A mobile-first, private class schedule and announcement app. Runs on **Node.js 24.15+** with no production dependencies. A small HTTP server, browser-native JavaScript, SQLite, and Server-Sent Events keep deployment straightforward. SQLite support comes from [Node’s built-in database API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

## Run locally

```powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run seed
npm.cmd start
```

On macOS/Linux, use `npm` instead of `npm.cmd` and `cp .env.example .env`. Open **http://localhost:3000**. Installing dependencies is only necessary for browser tests; the app can run directly with `node server.js`.

The sign-in page has working demo shortcuts after seeding:

| Role | Email | Password |
| --- | --- | --- |
| Admin | admin@medclass.demo | MedClassDemo2026! |
| Representative/editor | editor@medclass.demo | MedClassDemo2026! |
| Student | student@medclass.demo | MedClassDemo2026! |
| Student in another class | other@medclass.demo | MedClassDemo2026! |

`MEDCLASS-DEMO` is a student invitation for Group A, valid for 30 days after seeding. Demo class names and every demo screen are labeled. Dates are generated relative to the seed day in Europe/Paris. Sample content includes all three attendance states, a room change, rescheduled exam, cancelled class, and unconfirmed details.

## Create the first real admin

Set these variables in your local `.env` (never commit it):

```dotenv
ADMIN_EMAIL=you@university.edu
ADMIN_PASSWORD=your-unique-password-at-least-12-characters
ADMIN_NAME=Your Name
CLASS_NAME=Medicine · Class of 2028
CLASS_TIMEZONE=Europe/Paris
```

Then run `npm.cmd run create-admin`. This creates a real administrator and their first class, without exposing a public admin registration endpoint. Remove `ADMIN_PASSWORD` from `.env` afterward. Sign in, open **Manage class**, and create an invitation. Send the generated link or code to students. New accounts always join as students. Existing accounts can join another class with its code. Admins assign editor/admin permissions from the member list and can revoke invitations or remove members. At least one admin must remain in each class.

Create additional classes with **Manage class → Create another class**. Each class has its own timezone, content, invitations, memberships, roles, and read state. Student subgroup restrictions are enforced by the server; editors/admins can manage all subgroups in their assigned class.

Remove demonstration data before production with `npm.cmd run remove-demo`. This deletes demo classes and their content. Demo accounts with real memberships or authored content are preserved; audit those memberships if you used demo admins to create real classes.

## What works

- Authenticated Home, Schedule (agenda/calendar), Exams, and Updates. Search and filters for subject, type, subgroup, and attendance.
- Passwords hashed with salted scrypt; opaque server-side sessions in HttpOnly, SameSite cookies; CSRF tokens and same-origin checks. Auth and invitation attempts are rate limited.
- Server checks membership and role on every request. Students cannot write content or manage permissions. Invitations cannot elevate roles. Private subgroup data is filtered server-side.
- Event dates, times, and locations may be unconfirmed. Attendance defaults to **Unknown**. Cancelled events remain visible. Exams show duration only when start and end are known.
- Mobile event editor, change preview, save confirmation, weekly recurrence (up to 52 occurrences), one-occurrence or entire-series editing.
- Optimistic version checks for events, entire series, and announcements prevent silent overwrites. Every event version records author, time, and changed fields. Admin restoration creates another audited version.
- Announcements have subgroup targeting, priority, expiration, and admin pinning. Announcements can be edited with version checks. Expired announcements leave the persistent update feed intact.
- SQLite stores content, accounts, memberships, invitations, sessions, per-user notification reads, and event history across reloads and restarts.
- Live SSE signals refresh authorized students’ screens. Lost connectivity shows an outdated-information warning; reconnect, window focus, and a 60-second fallback refresh reload data. Live updates do not replace an open editor’s draft.
- “Updated since your last visit” uses a server-stored visit timestamp. Your new changes remain marked for the current visit.

## Verify

```powershell
npm.cmd test
npm.cmd run test:browser
```

The API integration suite uses an isolated temporary database. It checks admin creation and student viewing, actual SSE delivery to another session, room/attendance updates, restart persistence, class/subgroup isolation, blocked student edits, invitations and revocation, personal read state, recurring-series conflicts, restoration, input validation, cancelled/unconfirmed events, CSRF, and last-admin protection.

Browser tests use installed Chrome (override `BROWSER_EXECUTABLE` if needed), a separate temporary demo database, and desktop and 390px mobile viewports. They verify student navigation, admin preview/publishing, another browser session receiving the change, reload persistence, invitation registration, mobile overflow, and calendar navigation. They do not touch your local database.

## Deploy

Use a persistent VM/container with Node.js 24.15+. No database service credentials are required. Do not use an ephemeral or static-only host: SQLite needs a durable writable volume and SSE needs a running server.

1. Deploy the source and run `npm ci --omit=dev` (there are no runtime packages).
2. Mount a persistent volume and set `DATABASE_PATH=/var/lib/medclass/medclass.sqlite`.
3. Set `HOST=0.0.0.0`, `PORT=3000`, `APP_ORIGIN=https://your-domain.example`, and `COOKIE_SECURE=true`.
4. Bootstrap your admin with the command above, then remove the bootstrap password.
5. Run `npm start` under your service manager, with HTTPS terminated by your reverse proxy. Disable proxy buffering for `/api/classes/*/stream`, allow long-lived SSE connections, and set an appropriate read timeout (at least 60 seconds).
6. Back up the SQLite volume. For a file-copy backup, stop the server and copy the database directory including any WAL files. Restrict database volume permissions to the app’s service account.

`Dockerfile` provides a container option. Example (after building `docker build -t medclass .`):

```sh
docker run -d --name medclass -p 3000:3000 \
  -v medclass-data:/app/data \
  -e HOST=0.0.0.0 -e APP_ORIGIN=https://your-domain.example \
  -e COOKIE_SECURE=true medclass
```

Create the admin in that container with `docker exec`, providing the bootstrap variables through your deployment secret mechanism. Keep the database off the public filesystem.

## Scope and limitations

- Optional browser push is **not configured**. There is no pretend permission or delivery flow. Live updates work while the page is connected; announcements and notifications remain available when you return. Push would require a service worker, VAPID credentials, stored subscriptions, and a delivery service.
- This first version supports **weekly** recurrence; custom recurrence rules and overnight events are not implemented. Series changes include past occurrences, explicitly stated in the editor.
- Calendar dates/times are class-local wall-clock values, with a configurable IANA timezone; expiration inputs explicitly use the device timezone. Changing the class timezone reinterprets existing wall-clock times rather than moving events.
- No offline editing, password reset email, email verification, or MFA. An operator can bootstrap an additional admin account if needed. Users should retain their passwords; add an email service/recovery workflow before broad production rollout.
- A single app instance with a SQLite volume is the supported deployment. Multiple instances need a shared database plus cross-instance live-update transport. Rate-limit counters are per process. SSE currently broadcasts refresh signals, not notification payloads.
- Browser and API tests exercise workflows, but do not substitute for a production security review or assistive-technology testing. No public deployment was made from this workspace.
