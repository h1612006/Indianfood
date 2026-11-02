# Indian Snacks 🥟

An online ordering app for an Indian snacks shop: customers browse the menu with photos, build a basket, check out for pickup or delivery and watch their order progress live. A password-protected kitchen screen shows who ordered what and lets you move each order along.

## Features

**Customers**
- Menu with photos, categories and a unit under each price (per piece, per box, per kg, 20 pieces...)
- Optional item customization (sizes, paid extras, free removals) when an item defines them in `data/menu.json`
- Up to 100 of any item per order
- Basket with quantity controls, saved between visits
- Pickup or delivery, with a delivery fee, a free-delivery threshold and a minimum order
- Checkout with name, phone, address (delivery) and kitchen notes
- Live order tracker (Received → Preparing → Ready / On its way → Done) that updates by itself
- Works on phones and desktops

**Kitchen** (`/admin.html`)
- Password login
- Live board of orders, refreshed every 5 seconds, with a beep for new orders
- One-tap status buttons, cancel and reopen
- Active / Done / All filters

**Security basics**
- Prices are always calculated on the server; anything the browser sends about price is ignored
- Quantities, add-ons and removals are validated against the menu
- Customers can only see their own order's items and status, never other customers' details
- Everything shown on screen is HTML-escaped
- Admin password compared in constant time

## Run it on your computer with Docker (recommended)

Orders are stored in a **Postgres database** that runs in Docker next to the app, and they survive restarts and updates.

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac) or Docker Engine (Linux).

1. Copy the settings file and choose two passwords:
   - Windows PowerShell: `Copy-Item .env.example .env`
   - Mac/Linux: `cp .env.example .env`

   Open `.env` in a text editor and change `ADMIN_PASSWORD` (kitchen screen) and `POSTGRES_PASSWORD` (database). Letters and numbers are safest.
2. Start everything:
   ```
   docker compose up --build
   ```
3. Open http://localhost:3000. The kitchen screen is http://localhost:3000/admin.html.

Useful commands:
- Stop: `Ctrl+C`, or `docker compose down` (orders are kept)
- Start again in the background: `docker compose up -d`
- See logs: `docker compose logs -f app`
- **Delete all orders and start fresh:** `docker compose down -v`
- Look inside the database: `docker compose exec db psql -U spicesmash -c "SELECT id, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10"`

## Run it without Docker (quick tryout)

Requires Node.js 18 or newer. With no database settings, orders are kept in a local file (`data/orders.json`).

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

To use Postgres without Docker for the app, set `DATABASE_URL=postgres://user:password@host:5432/dbname` (or the standard `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) before `npm start`. The `orders` table is created automatically.

If port 3000 is busy, set another one: `$env:PORT=3001` (PowerShell) or `PORT=3001` (Mac/Linux) before `npm start`.

Run the automated tests with `npm test` (add `DATABASE_URL=...` to test against Postgres).

## Publish from GitHub

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `main`:

1. **Tests** the app against a real Postgres.
2. **Builds** the Docker image and publishes it to GitHub's registry (`ghcr.io/h1612006/indianfood`).
3. **Deploys** it to your server over SSH and restarts it, then waits until the health check passes.

GitHub itself can only host static pages, not a server with a database, so step 3 needs **a server with Docker** (any small VPS works: Hetzner, DigitalOcean, AWS Lightsail, Oracle free tier...). Steps 1 and 2 work immediately; step 3 is skipped until you add the secrets below, so nothing breaks while you set up.

### One-time server setup

On a fresh Ubuntu/Debian server (as a user that can run Docker):

1. Install Docker: `curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker $USER` and log in again. The server also needs `curl`.
2. On your own computer, create a key just for deployments:
   ```
   ssh-keygen -t ed25519 -f deploy_key -N ""
   ```
   Add the contents of `deploy_key.pub` to `~/.ssh/authorized_keys` on the server.
3. Open port 3000 (or 80/443 if you add HTTPS) in the server's firewall.

### Add the secrets on GitHub

Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | The server's IP address or domain |
| `DEPLOY_USER` | The SSH user on the server |
| `DEPLOY_SSH_KEY` | The full contents of the private file `deploy_key` |
| `DEPLOY_PORT` | Optional. Only if SSH is not on port 22 |
| `ADMIN_PASSWORD` | Kitchen screen password (choose a strong one) |
| `POSTGRES_PASSWORD` | Database password (letters and numbers) |

Then push to `main` (or open the **Actions** tab → *Test, build and deploy* → **Run workflow**). When it turns green, open `http://YOUR-SERVER:3000`.

Notes:
- `POSTGRES_PASSWORD` is only used the first time the database is created. If you change it later, also run `docker compose down -v` on the server (this erases orders), or change the password inside Postgres.
- The first deploy may leave the package private. That is fine, because the server logs in with the workflow's token to pull it.
- **Use HTTPS before real customers use it.** Plain `http://` sends the kitchen password unencrypted. Put a reverse proxy such as Caddy or Cloudflare in front of port 3000 and use a domain name.
- Back up the database now and then: `docker compose exec -T db pg_dump -U spicesmash spicesmash > backup.sql`

### Install it as a phone app

Open the address on a phone. Android (Chrome): menu → *Install app*. iPhone (Safari): Share → *Add to Home Screen*. (Browsers only offer installation on `https://` addresses or `localhost`, so this works fully once HTTPS is set up.)

### Fastest way to a public link (no server needed)

[`render.yaml`](render.yaml) sets up the app **and** a Postgres database on [Render](https://render.com):

1. Sign in at render.com with GitHub (as the account that owns this repo) and allow access to this repository.
2. **New +** → **Blueprint** → choose this repository.
3. Enter an `ADMIN_PASSWORD` (the kitchen screen password) and click **Apply**.
4. After a few minutes you get a link like `https://spice-smash.onrender.com`. Customers order there; you watch orders arrive at `/admin.html` on the same link.

Free-plan limits (see Render's [free tier page](https://render.com/docs/free)): the app sleeps after 15 minutes without visitors and takes about a minute to wake; the free database expires after 30 days and has no backups. Good for a demo or trial. For a real restaurant, use the Docker route above or a paid plan.

## Change the menu, brand and prices

Everything is in [`data/menu.json`](data/menu.json): brand name, tagline, currency symbol, delivery fee, free-delivery threshold, minimum delivery order, categories and every item. Photos live in [`public/img/`](public/img/). After editing, commit and push; the hosting redeploys by itself (locally, restart the server).

One item looks like this:

```json
{
  "id": "samosa",
  "category": "fried",
  "name": "Samosa",
  "description": "Crisp pastry parcel with a spiced potato and pea filling.",
  "price": 1.30,
  "unit": "per piece",
  "emoji": "🥟",
  "image": "/img/samosa.jpg"
}
```

- `unit` is optional text shown after the price ("per piece", "per box", "20 pieces", "250 g").
- `image` is optional. Without it the `emoji` is shown instead. Put the photo in `public/img/` (a square JPG around 500 px keeps the page fast).
- Optional extras: `"sizes": "standard"` (sizes are defined once under `sizes`), `"addons": [{"id","name","price"}]`, and `"removals": ["Onions"]`.
- `"cardPaymentDemo": true` shows a fake "Card" option (nothing is charged). Leave it `false` until real payments are added.
- Run `npm test` after editing: it checks every item for a missing name, bad price, unknown category or missing photo.

## Project structure

```
server.js          Express API, server-side pricing, admin routes
db.js              Order storage: Postgres (Docker) or a JSON file fallback
data/menu.json     Brand, menu and pricing (edit this)
public/img/        Menu photos
Dockerfile         Builds the app image
docker-compose.yml App + Postgres database (with a saved volume)
.env.example       Copy to .env and set your passwords
.github/workflows/deploy.yml   Test, build image, deploy from GitHub
test/              Automated tests (npm test); fixtures/ holds a sample menu used by the API tests
public/index.html  Customer site
public/app.js      Menu, customization, basket, checkout, order tracker
public/admin.html  Kitchen screen
public/admin.js    Kitchen logic
public/styles.css  Styling
public/sw.js, manifest.webmanifest, *.png   Make it installable as a phone app
render.yaml        Optional quick-demo hosting config for Render
```

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/menu` | Menu and settings |
| POST | `/api/orders` | Place an order |
| GET | `/api/orders/:id` | Track an order (status and items only) |
| GET | `/api/admin/orders` | All orders (needs `x-admin-password` header) |
| PATCH | `/api/admin/orders/:id` | Change status: `received`, `preparing`, `ready`, `completed`, `cancelled` |

## What is intentionally simple (and how to grow it)

- **Payments are a demo.** "Card" records the choice but never charges anything. To take real payments, add Stripe Checkout (or Payment Element) in `POST /api/orders` and only mark the order as paid after Stripe confirms it.
- **Orders are in Postgres, but there is no automatic backup.** Schedule `pg_dump` (see above) or use your host's snapshot feature.
- **One shared admin password.** For several staff members, add proper accounts.
- **No rate limiting.** Add `express-rate-limit` before exposing it publicly.
- **Customer accounts, order history, promo codes and email/SMS notifications** are natural next steps.
