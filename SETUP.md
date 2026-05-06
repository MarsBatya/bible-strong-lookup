# Bible Translation Lookup — Setup Guide

## What this plugin does

- Open the Command Palette → **Search word translation**
- Type any word in English or Russian
- A dropdown appears showing: `776: "мир" (2236)` — Strong's number, lemma, occurrence count
- Select an entry → the **lemma text only** is inserted at your cursor (e.g. `мир`)
- Last 10 searches are saved and re-insertable via **Insert from recent searches**

---

## Prerequisites

- Node.js ≥ 18
- npm ≥ 8
- Obsidian ≥ 0.15.0 (desktop or Android)

---

## Step 1 — Build the plugin

```bash
# In the plugin directory
npm install
npm run build
```

After build, you will have three files needed for the plugin to work:
```
main.js          ← bundled plugin
manifest.json    ← plugin metadata
```

---

## Step 2 — Host the database on GitHub Releases

The 30 MB `.Sqlite3` file is **not** committed to git. Host it as a release asset:

1. Go to your GitHub repo → **Releases** → **Create a new release**
2. Tag it (e.g. `v1.0`)
3. Attach `RST-KJV-v2.Sqlite3` as a release asset
4. Publish

Copy the **direct download URL** — it looks like:
```
https://github.com/YOUR_USER/YOUR_REPO/releases/download/v1.0/RST-KJV-v2.Sqlite3
```

---

## Step 3 — Install the plugin in Obsidian

### Desktop

1. Open your vault folder
2. Create: `.obsidian/plugins/bible-lookup/`
3. Copy into that folder:
   - `main.js`
   - `manifest.json`
4. In Obsidian: **Settings → Community plugins → Installed plugins → reload** → enable **Bible Translation Lookup**

### Android

1. Connect your phone via USB (or use a file manager app)
2. Navigate to your vault → `.obsidian/plugins/bible-lookup/`  
   (create the folder if it doesn't exist)
3. Copy the same three files: `main.js`, `manifest.json`
4. In Obsidian: **Settings → Community plugins → reload** → enable the plugin

> **Tip:** If you use Obsidian Sync, place the plugin files in your vault's `.obsidian/plugins/` folder and let Sync distribute them to Android automatically.

---

## Step 4 — Download the database

1. In Obsidian: **Settings → Bible Translation Lookup**
2. Paste the GitHub Releases URL from Step 2 into the **Database URL** field
3. Click **Download now**
4. Wait ~10–30 seconds for the 30 MB download

The database is saved as `bible.sqlite3` inside the plugin folder. It never leaves your device.

---

## Commands (Command Palette — Ctrl/Cmd+P)

| Command | Action |
|---|---|
| Bible Lookup: Search word translation | Main lookup modal |
| Bible Lookup: Insert from recent searches | Re-insert from last 10 results |
| Bible Lookup: Fetch / update database from GitHub | Re-download the DB |

---

## Performance notes

- sql.js loads the entire 30 MB DB into memory once at startup (~1–3 s one-time cost)
- Per-query time: **< 10 ms** (indexed B-tree lookup, fully in-memory)
- On Android, the startup load may take 3–5 s depending on device; queries remain fast

---

## Updating the database

1. Upload a new `.Sqlite3` file as a new GitHub release asset
2. Update the URL in plugin settings if the path changed
3. Click **Download now** — the old file is replaced

---

## Repo structure

```
bible-lookup-plugin/
├── main.ts           ← source (edit this)
├── manifest.json     ← plugin ID and metadata
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── .gitignore        ← excludes *.sqlite3, main.js
```

Files produced by `npm run build` (not in git):
```
main.js
```

Files fetched at runtime (not in git):
```
bible.sqlite3
```
