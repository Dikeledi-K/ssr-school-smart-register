# SSR – School Smart Register (cloud version)

A phone-friendly web app for daily, period, and food registers, for South African schools from Grade R to 12. All data is kept in Supabase, so any phone can log in. Every school sees only its own data.

```
ssr/
├── web/                      ← the app (upload this folder to any static host)
│   ├── index.html
│   ├── config.js             ← put your Supabase URL + anon key here
│   └── learners_template.csv ← sample CSV for the administrator
└── supabase/
    ├── schema.sql            ← database, security rules, functions (run once)
    └── functions/ssr-admin/  ← admin actions: add/reassign/delete teachers, read photo lists
        └── index.ts
```

## Setup (about 30 minutes)

### 1. Create the Supabase project
1. Go to supabase.com, sign in, and click **New project**. Choose the region closest to South Africa and a strong database password.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**. It should finish with "Success. No rows returned."
   - ⚠ The top of the file drops the SSR tables first. Once real data is in the system, never run it again unless you mean to wipe everything.

### 2. Login settings (Authentication)
- **Authentication → URL Configuration**
  - *Site URL*: the address where you'll host the app, e.g. `https://ssr-yourschool.netlify.app`
  - *Redirect URLs*: add that same address. This makes the administrator's password-reset link come back to the app.
- **Authentication → Providers → Email**: keep it enabled. "Confirm email" can stay on. The administrator just confirms their email once before the first login.
- **Email sending:** Supabase's built-in email only allows a few emails per hour. That's fine for occasional admin password resets. For anything more, add your own SMTP under **Project Settings → Authentication → SMTP** (for example Brevo, Resend, or the school's mail server).

### 3. Deploy the admin function
**Option A: Dashboard (no install).** Go to **Edge Functions → Deploy a new function → Via editor**, name it exactly `ssr-admin`, paste `supabase/functions/ssr-admin/index.ts`, and click **Deploy**.

**Option B: CLI.**
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy ssr-admin
```

**Optional: reading photos of paper class lists.** This needs an Anthropic API key (console.anthropic.com, paid per use; a class list costs a few cents). Add it under **Edge Functions → Secrets** as `ANTHROPIC_API_KEY`. If you skip this, the admin can still add learners by typing or by CSV, and the photo button explains that it isn't switched on.

### 4. Connect the app
Get your **Project URL** and **anon public key** from **Project Settings → API**, then edit `web/config.js`:
```js
SUPABASE_URL: "https://abcd1234.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi...",
```
The anon key is meant to be public. The database rules decide what each login can see.

### 5. Host the app
Any static host works. The easiest options:
- **Netlify Drop**: go to app.netlify.com/drop and drag the `web` folder onto the page. You get a link at once (you can rename it in site settings).
- Or GitHub Pages, Vercel, Cloudflare Pages, or the school's own website.

Then go back to step 2 and set the Site URL and Redirect URL to this address.

### 6. First use
1. The principal opens the link and taps **Register a new school**, entering the school name, a school code (the EMIS number works well), their name, email, and password.
2. Confirm the email if asked, then log in. On the login screen, the administrator types their **email** as the username.
3. **Teachers tab**: add each teacher. The username is surname + initials (e.g. *Baloyi TK*), with a fixed class (e.g. Grade 5A) and a password. The app shows the login details to hand over.
4. **Learners tab**: pick or open a class, then add learners by **Type**, **CSV file**, or **Photo of list**. Every list is shown for checking before it's saved.
5. Teachers open the same link and log in with **school code + username + password**. Tip: "Add to Home screen" makes it behave like an app.

## What each role can do
| | Administrator | Teacher |
|---|---|---|
| Create school, add/reassign/delete teachers, reset teacher passwords | ✔ | ✖ |
| Add, edit, move, delete learners | ✔ | ✖ |
| Daily register (own class, Mon–Fri, no future days) | view only via "today" status | ✔ |
| Period register (chosen subject + up to 10 classes, periods 1–15) | | ✔ |
| Food register (breakfast / main meal, must match learners present) | | ✔ |
| Parent numbers | all classes | own class only, tap to call |
| Reset own password | by email link | ask the admin (or change it under ⚙ when logged in) |

## Rules and how they're enforced
These are enforced in the **database** (Row Level Security + functions), not only on screen, so they hold even if someone tampers with the app.
- **Each school sees only its own data.** Every table is filtered by the logged-in user's school.
- **Teachers can't add, edit, or delete learners**, and can't read the learners table at all. They get names + gender through `class_roster()`, and parent numbers only through `parent_contacts()` (own class only).
- **Contact numbers appear only in the Parents tab.** Registers and PDF/CSV exports contain names only.
- **Teachers can't change their class.** Profiles can only be changed by the admin function. Teachers can only set their subject and period classes.
- **Monday–Friday only**: the database rejects weekend dates. Periods are limited to 1–15.
- **Names are sorted A–Z** (by surname, then name) everywhere.
- **Usernames are unique per school** ("Baloyi T.K" and "baloyi tk" count as the same), and a class can have only one class teacher.
- **Passwords** are stored hashed by Supabase Auth. They're never stored in the app or database tables.

## Things to know
- **Free plan pause:** Supabase pauses a free project after about 7 days with no activity (e.g. school holidays). The data is kept; the admin restores it with one click in the Supabase dashboard. The Pro plan doesn't pause.
- **Backups:** the free plan has no automatic backups. Use the Pro plan or export regularly (Database → Backups).
- **POPIA:** the system holds minors' names and parents' phone numbers. Keep the admin password private and remove teachers who leave (Teachers → Delete). Their saved registers stay.
- **Teacher logins:** behind the scenes, each teacher gets an internal address like `baloyitk.alp01@teachers.ssr.local`. It's never emailed and teachers never see it. That's why only the administrator can reset teacher passwords.
- **Old demo data:** the earlier one-phone demo stored data on the phone only. Learners can be re-entered quickly by CSV or photo.
