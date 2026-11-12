# VaultDrop — Password-Protected Online File Uploader & Vault

A fast, password-protected file uploader and online file vault built with **Next.js (App Router + TypeScript)**, **Vanilla CSS**, and **Vercel Blob (`@vercel/blob`)** with an automatic **Local Disk Fallback** for zero-config local development.

Anyone with the shared password can log in, immediately drag-and-drop or paste files to upload them online, preview files in the browser, and download them from anywhere.

---

## Features

- **Single Shared Password Gate**: Stateless `HMAC-SHA256` signed `httpOnly` cookie session (`vault_session`). Changing `APP_PASSWORD` immediately invalidates all existing sessions.
- **Dual-Mode Storage Engine (`src/lib/storage.ts`)**:
  - **Vercel Blob (`@vercel/blob`)**: Automatically active whenever `BLOB_READ_WRITE_TOKEN` is present. Supports both standard multipart uploads and direct client-to-blob uploads (`@vercel/blob/client`) for large files.
  - **Local Disk Fallback (`.local-vault/`)**: Automatically active in local development when `BLOB_READ_WRITE_TOKEN` is not set.
- **Multi-File Drag-and-Drop & Clipboard Paste**:
  - Drop files onto the upload zone or anywhere on the window.
  - Paste screenshots or copied files directly with `Ctrl+V` / `Cmd+V`.
  - Real-time per-file progress bars.
- **Authenticated Downloads & In-Browser Previews**:
  - Every file list, upload, preview, and download request is protected by the session cookie.
  - Built-in preview modal for images, PDFs, video, audio, and code/text files.
  - Search by filename/MIME type, filter by file category, sort by date/name/size, and switch between **Archival Table View** and **Visual Grid View**.

---

## Deploying to Vercel

1. **Import Repository into Vercel**:
   - Push this repository to GitHub and import it at [vercel.com/new](https://vercel.com/new).
2. **Connect Vercel Blob Storage**:
   - In your Vercel project dashboard, go to the **Storage** tab → **Create Database / Store** → select **Blob** (`Vercel Blob`).
   - Connect the Blob store to your project. Vercel will automatically inject the `BLOB_READ_WRITE_TOKEN` environment variable into your environments.
3. **Set Your Password**:
   - In your Vercel project dashboard, go to **Settings** → **Environment Variables**.
   - Add `APP_PASSWORD` with your desired shared password (e.g. `my-secret-password`).
   - *(Optional)* Add `SESSION_SECRET` with a random string for signing cookies.
4. **Redeploy**:
   - Trigger a deployment (or push a commit). Your password-protected online file vault is live!

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Configure custom password in .env.local
cp .env.example .env.local
# Edit APP_PASSWORD in .env.local (defaults to "vault2026" if unset)

# 3. Start the development server
npm run dev
```

Open `http://localhost:3000`, unlock with your password (default `vault2026`), and start uploading and downloading files immediately.
