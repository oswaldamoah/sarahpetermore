# SarahPetermore — No Long Talk.

Discreet e-commerce + order, inventory, finance and AI-assistant platform for SarahPetermore and its partner stakeholders (starting with Goldy).

**Stack:** Neon (Postgres + Neon Auth + Data API) · React/Vite on Vercel · Vercel Functions for the assistants, uploads and alerts · Vercel Blob for photos and receipts.

```
web/                  Storefront + admin panel (React, TypeScript, Vite, Tailwind)
web/api/              Vercel Functions: customer-assistant, admin-assistant, upload, notify (+ _lib: AI gateway, DB access)
db/migrations/        Database: schema, business logic (transactional functions), RLS, seed, Data API grants
db/migrate.mjs        Applies the migrations to Neon (npm run migrate)
db/demo_seed.sql      OPTIONAL sample hostels, distributors, products and stock
tests/                35 database checks + 7 end-to-end assistant checks + screenshot harness
screenshots/          What it looks like
```

How the pieces talk:

```
Browser ──(Neon Auth: sign-in, JWT)──────────────► Neon Auth
   │──(Data API + JWT or anonymous token)─────────► Neon Postgres  ◄── RLS + role checks decide everything
   └──(/api/*)──► Vercel Functions ──(owner connection / Data API as the user)──┘
                        └──► AI providers (OpenRouter, Groq, Gemini, Pollinations…)
```

---

## 1. Set up Neon (≈10 minutes)

1. Create a project at [neon.com](https://neon.com). Pick the region closest to Ghana (Frankfurt, `aws-eu-central-1`).
2. **Enable Neon Auth**: project → **Auth** → enable (Managed Better Auth). Under *Configuration*, add your site URL (e.g. `https://sarahpetermore.com`, and `http://localhost:5173` for local dev) to trusted origins / redirect URLs. Set up email delivery there if you want password-reset emails.
3. **Enable the Data API**: project → **Data API** → enable, with **Neon Auth** as the authentication provider. Leave the anonymous role as `anonymous`.
   This creates the `authenticated` and `anonymous` database roles the migrations rely on, so do it *before* step 4.
4. **Run the migrations** from your computer (Node 18+):
   ```bash
   cd db
   npm install
   DATABASE_URL="postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require" npm run migrate
   # add sample data to try things out (skip for a clean launch):
   DATABASE_URL="…" npm run demo-seed
   ```
   Use the **owner** connection string from **Connect**. No terminal? Paste each file from `db/migrations/` into the Neon **SQL Editor**, in order.
5. Back in **Data API**, press **Refresh schema cache** (or `neon data-api refresh-schema --database neondb`). Do this after every migration.

### Make yourself super admin
Deploy the site (section 2), sign up on it (Account → Create an account), then run once in the Neon SQL Editor:
```sql
insert into user_roles (user_id, role)
select id, 'super_admin' from neon_auth."user" where email = 'YOUR@EMAIL.COM';
```
After that, add staff from **Admin → Settings → Staff & roles** (they sign up first, you grant a role).

| Role | Can do |
|---|---|
| Super admin | Everything, incl. settings, AI keys, staff, negative-stock overrides |
| Manager | Orders, products, categories, stakeholders, stock, distributors, reports |
| Inventory manager | Stock, restocks, transfers, distributors, locations |
| Finance manager | Cashflow, expenses, ledger, settlements, payments/refunds |
| Order manager | Orders, enquiries, payments on delivery |

Permissions are enforced inside the database (Row Level Security + a role check in every function), not just by hiding buttons. Visitors use the Data API's `anonymous` role and can only read the shop views and call the public order/tracking functions.

## 2. Deploy on Vercel

1. Push this folder to GitHub and import it in Vercel. Set **Root directory = `web`** (framework: Vite). The functions in `web/api/` deploy automatically.
2. **Storage → Blob → Create store** and connect it to the project (this adds `BLOB_READ_WRITE_TOKEN`).
3. **Settings → Environment Variables** (see `web/.env.example`):

   | Variable | Where to find it |
   |---|---|
   | `VITE_NEON_AUTH_URL` | Neon → Auth → Configuration → Auth URL |
   | `VITE_NEON_DATA_API_URL` | Neon → Data API → API URL |
   | `NEON_DATA_API_URL` | Same Data API URL (server copy) |
   | `DATABASE_URL` | Neon → Connect → owner connection string. **Server only — never prefix with `VITE_`.** |
   | `SITE_URL` | Your site address |

4. Deploy. `web/vercel.json` already handles deep links, gives the assistants 60 seconds, and runs the daily alert job.

Local development: `cd web && cp .env.example .env` (fill it in) → `npm install` → `npx vercel dev` (runs the site and `/api` together; `npm run dev` runs the site only).

## 3. AI models — free, switchable, keys stay on the server
Configured in **Admin → Settings → AI models**. Both assistants try providers in priority order and fall back automatically; if every provider fails, customers still get a working non-AI reply with real products, prices and your contact numbers. Customers never see which model answered.

| Provider (pre-loaded) | Cost | What you need |
|---|---|---|
| OpenRouter free router (`openrouter/free`) | Free | A free key from openrouter.ai/keys (no card). **Recommended first step.** |
| Groq | Free tier | Free key from console.groq.com |
| Gemini | Free tier | Free key from aistudio.google.com |
| Pollinations | Free, no key | Nothing — works out of the box, but rate-limited |

Paste a key into a provider, press **Test**, done. You can add any OpenAI-compatible endpoint, change models when free ones rotate, set daily limits and see usage. Keys sit in a table the browser can't read at all; you can also set them as Vercel env vars instead (`AI_KEY_OPENROUTER`, `AI_KEY_GROQ`, `AI_KEY_GEMINI`).

**Customer assistant ("24/7 Customer Service")** never names a model or provider and never invents prices, stock or orders — it looks everything up. If a customer sincerely asks whether they're talking to a person, it says it's SarahPetermore's automated service and gives the business line; it won't claim to be human. It never places an order on its own: it shows a summary card and the customer taps **Confirm order**.

**Sarah Assistant (admin)** answers questions ("pending orders?", "sales by hostel this month") and takes instructions ("restock Legon North with 20 condoms at GH₵6", or a pasted product list). Every change appears as a preview table and only runs when you press **Confirm** — through the Data API *as you*, so your role limits apply — and is written to the audit log.

## 4. Before you launch (Admin → Settings → Business & delivery)
- Business line, customer-service number, WhatsApp, Snapchat (all start empty).
- Delivery fees (distributor / courier) — default GH₵0.
- Your real hostels (**Locations**), distributors and the hostels each one serves (**Distributors → Hostels**). Mark one distributor as **hub** for courier orders.
- Products (one by one, CSV import, or a pasted list in Sarah Assistant) and opening stock per distributor.
- Optional: **"Accept orders even when stock is not recorded"** to take orders before stock counts are in (you assign stock to those orders later).

## Optional alerts (email / SMS / WhatsApp)
New orders, enquiries, low stock, refunds and transfers always appear in the admin bell (checked every 20 seconds). To also push them out, set any of these in Vercel:
```
RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM          # email
HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET, HUBTEL_SENDER, NOTIFY_SMS_TO   # SMS (Ghana)
NOTIFY_WEBHOOK_URL                                           # e.g. WhatsApp via Make/Zapier
```
Alerts go out the moment an order or enquiry is placed, plus a daily catch-up job. On Vercel's free plan cron runs once a day; for more frequent catch-ups point a free scheduler (e.g. cron-job.org) at `GET /api/notify` with header `Authorization: Bearer <CRON_SECRET>`. Unset channels are skipped. Messages never name products.

---

## How it works

**Ordering:** Shop → Cart → Order → *Where would you like it delivered?* (On campus → UPSA/Legon → hostel, or Off campus) → details (room number for hostels) → review → **Place order**. The database re-prices everything (browser prices are ignored), checks stakeholder/category status and stock, picks a distributor, reserves stock and returns a reference — only then does the customer see the confirmation. Guests don't need an account; signed-in customers can save addresses, see past orders and reorder.

**Distributor choice:** for a served hostel it prefers one distributor who has *everything*; if none does, it splits between that hostel's distributors (can be switched off); if they can't cover it, it ships by courier from central stock and tells the customer. Unlisted hostels and off-campus addresses always say "delivered by courier".

**Who the customer calls:** the delivery distributor's number for your own Classic products. If the order contains partner (Goldy) items, your business line comes first. Goldy's details are never shown. Business line, customer service, WhatsApp and Snapchat are always shown as backup.

**Stock:** counted per product per distributor (on hand − held for open orders = available). Every change — +/−, restock, transfer, order, return, import — is a permanent ledger entry with who and why. +/− changes are reviewed in a before/change/after table before saving. Stock can't go negative unless a super admin overrides with a reason. Transfers leave the source at dispatch and arrive at the destination only when received (or tick "handed over now").

**Order statuses:** Received → Confirmed → Processing → Ready → Out for delivery → Delivered (stock deducted) · Cancelled (held stock released) · Failed delivery · Returned (stock back) · Refund pending · Refunded. Every change records from/to, time, staff member and note.

**Money:** payment on delivery — nothing counts as cash until you record it (marking Delivered offers to record the cash collected). Goldy items: customer pays base + 15%; Goldy's base is a liability (Settlements), only the markup is your revenue. Expenses, restocks, refunds and settlements each post once to the ledger; edits create reversals, never silent changes. Daily reconciliation shows per distributor what was assigned, delivered, expected vs collected, and what stock they should hold.

**Switching things off:** a stakeholder or category set to inactive disappears from the shop, search and both assistants immediately; past orders, stock and money history stay. Switch back on and everything returns.

**Import/export:** stock CSV with exactly `Product Name, Category, Cost Price, Selling Price, Stock Quantity, Unit`; a per-distributor version; every table as CSV/JSON; a full JSON backup; a downloadable template. Imports are previewed, duplicates and bad rows flagged, and nothing is written until you confirm.

**Discretion:** plain-box placeholder instead of product photos by default, generic notifications (no product names), customer order data only visible with reference + matching phone (or the private confirmation link), internal notes never shown to customers, receipts stored privately.

## Testing
```bash
cd tests && npm install && npm test   # 35 database checks (scenarios A–H, K, permissions, Neon identity)
                                      # + 7 end-to-end customer-assistant checks with a scripted model
cd web && npm run build               # strict TypeScript for site + functions, then production build
cd tests && npm run screenshots       # renders the app against the test database (needs a preview build, see preview.mjs)
```

## Known limits / next steps
- Neon's Data API and the `@neondatabase/neon-js` SDK are in **beta** (pinned to `0.9.0-beta`). Upgrade deliberately and re-run the tests.
- Accounts are new on Neon Auth: password reset needs email delivery configured in Neon Auth, and `updateUser` can't change email/password (the app uses the reset-email flow instead).
- The assistants were tested end to end with a scripted model, but not against live AI providers (outbound access was blocked in the build environment). Test both once keys are added.
- Live updates are polling (every 20 s) rather than push.
- Payments are pay-on-delivery; the order/payment model is ready for a MoMo/Paystack gateway later. Distributor logins are prepared (role `distributor`) but not built. No promo-code screen yet.
