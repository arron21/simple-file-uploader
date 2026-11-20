# VaultDrop — Monetized Password-Protected Online File Vault

A fast, password-protected file uploader and online file vault built with **Next.js (App Router + TypeScript)**, **Vanilla CSS**, **Vercel Blob (`@vercel/blob`)**, **Stripe Checkout**, and **Google AdSense + Direct Sponsorships**.

---

## Monetization & Retention Architecture

1. **Tiered File Size & Auto-Delete Lifetimes**:
   - **Free Ad-Supported Tier**:
     - Upload files up to **250 MB per file**.
     - Files automatically delete after **1 Week (7 Days)** by default (or **24 Hours** if chosen).
     - Displays Google AdSense / Direct Sponsor banners and a **5-second Sponsored Download Interstitial** before downloads.
   - **Paid Passes & Pro Unlimited**:
     - **$2.99 Large File & 1-Year Pass** *(72-hour pass)*: Upload files over 250 MB (up to **5 TB** via 8 MB multipart chunking), unlock **30-Day** & **1-Year** retention, extend existing files, and enjoy ad-free 0-second downloads.
     - **$6.99 Permanent Archival Pass** *(7-day pass)*: Everything above plus **Permanent (Never Auto-Delete)** file storage.
     - **$9/month VaultDrop Pro Unlimited**: Full monthly membership with **5 TB** uploads, **Permanent** storage, **100% Ad-Free** vault, and a **Portable License Key (`VD1...`)** that works across all your devices.

2. **Triple-Layer Auto-Deletion Engine**:
   - **Native Vercel Blob `ttlDays`**: Automatically sets S3/Blob object expiration (`1`, `7`, `30`, or `365` days; omitted for `Permanent`).
   - **Read & Download Gate**: Expired files are immediately excluded from `/api/files`, rejected with `410 Gone` on `/api/files/download`, and purged asynchronously.
   - **Daily Vercel Cron (`/api/cron/cleanup`)**: Configured in `vercel.json` (`0 3 * * *`) to sweep and purge expired files automatically.

3. **Going Live with Real Payments & Ads on Vercel**:
   - **Accept Real Payments (Stripe)**: Add `STRIPE_SECRET_KEY` (`sk_live_...`) in **Vercel → Settings → Environment Variables**. No manual Stripe Product/Price setup is required—Checkout Sessions are created dynamically! (Until `STRIPE_SECRET_KEY` is added, an Interactive Sandbox Checkout is active for testing, plus `PRO_PROMO_CODE` support).
   - **Run Google AdSense Ads**: Add `NEXT_PUBLIC_ADSENSE_CLIENT_ID` (`ca-pub-...`), `NEXT_PUBLIC_ADSENSE_BANNER_SLOT`, and `NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT` in Vercel. `/ads.txt` is automatically generated and served at `https://your-domain/ads.txt`!
   - **Sell Direct Sponsorships**: Set `NEXT_PUBLIC_SPONSOR_INQUIRY_URL` (e.g., a Stripe Payment Link, Cal.com link, or `mailto:`) for the **"Advertise Here"** link on native ad units.
