# Spice Smash 🔥

A complete fast-food ordering app in the style of the big burger chains: browse a menu, customize items, build a basket, check out for pickup or delivery, and watch your order progress live. A password-protected kitchen screen lets staff move orders along.

Spice Smash is an original brand (burgers with an Indian twist). It does not use any real chain's name, logo or artwork.

## Features

**Customers**
- Menu with categories, veg / spicy tags and calories
- Item customization: sizes, paid extras (bacon, extra patty, "make it a combo"), free removals ("no pickles")
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

## Run it

Requires Node.js 18 or newer.

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

Then open:
- Customer site: http://localhost:3000
- Kitchen screen: http://localhost:3000/admin.html

If you skip `ADMIN_PASSWORD`, the password is `admin123`. Change it before putting this on the internet. Set `PORT` to use a different port.

## Put it online (use it from any device)

The repo includes a [`render.yaml`](render.yaml) so it can be hosted for free on [Render](https://render.com):

1. Create a Render account and choose **Sign in with GitHub**.
2. Click **New +** → **Blueprint**, and pick this repository.
3. When asked for `ADMIN_PASSWORD`, type a password for the kitchen screen. Choose something strong.
4. Click **Apply**. After a few minutes you get a public address like `https://spice-smash.onrender.com`.

Customers open that address. The kitchen screen is at `/admin.html` on the same address.

**Install it as an app:** open the address on a phone. On Android (Chrome) choose menu → *Install app*. On iPhone (Safari) choose Share → *Add to Home Screen*. It then opens full-screen with its own icon.

**Free hosting limits:**
- The free plan goes to sleep after about 15 minutes without visitors, and the first visit afterwards takes up to a minute to wake it.
- On the free plan, saved orders are lost whenever the app restarts or is redeployed. For a real restaurant, use a paid plan with a persistent disk (set the `DATA_DIR` environment variable to the disk's folder) or move orders to a database.

Other hosts such as Railway or Fly.io also work: the start command is `npm start`, the app reads `PORT` from the environment, and the health check is `/healthz`.

## Change the menu, brand and prices

Everything is in [`data/menu.json`](data/menu.json): brand name, tagline, currency symbol, delivery fee, free-delivery threshold, minimum delivery order, categories, sizes and every item with its extras and removals. Restart the server after editing.

To turn it into a different restaurant, change the names, emojis, prices and descriptions in that file. No code changes needed.

## Project structure

```
server.js          Express API, server-side pricing, order storage, admin routes
data/menu.json     Brand, menu and pricing (edit this)
data/orders.json   Created automatically; orders are saved here
public/index.html  Customer site
public/app.js      Menu, customization, basket, checkout, order tracker
public/admin.html  Kitchen screen
public/admin.js    Kitchen logic
public/styles.css  Styling
public/sw.js, manifest.webmanifest, *.png   Make it installable as a phone app
render.yaml        One-click hosting config for Render
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
- **Orders are stored in a JSON file.** Fine for a demo or a single small shop. For real use, move to SQLite or Postgres.
- **One shared admin password.** For several staff members, add proper accounts.
- **No rate limiting.** Add `express-rate-limit` before exposing it publicly.
- **Customer accounts, order history, promo codes and email/SMS notifications** are natural next steps.
