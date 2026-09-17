# Deploying Full-Time to the internet (free)

This walks through putting Full-Time online — reachable by any browser,
login required — for free, using MongoDB Atlas (database) and Render
(hosting). Takes about 15-20 minutes the first time.

You don't need to know git or the command line for any of this — every
step below uses a website's normal click-through UI.

---

## Step 1 — Create your free MongoDB database

This is where all predictions, accounts, and settings will actually live —
it's what makes your data survive Render restarting the app (which it does
periodically on the free tier).

1. Go to **https://www.mongodb.com/cloud/atlas/register** and sign up
   (email + password, or Google/GitHub login — no credit card asked).
2. You'll be prompted to create a cluster. Choose the **M0 (Free)** tier.
   Pick any cloud provider and region (pick one close to you or close to
   wherever Render will run — doesn't need to match exactly).
3. Once the cluster is created (takes a minute or two), you'll be prompted
   to add a database user. Set a username and password — **write this
   password down**, you'll need it in a moment. (This is separate from
   your Atlas login.)
4. You'll also be prompted for network access. Choose **"Allow access
   from anywhere"** (0.0.0.0/0). This is safe here — the database still
   requires the username/password from the step above; this setting only
   controls which IP addresses are allowed to even attempt a connection,
   and Render's servers use IPs that change, so allowing "anywhere" is the
   normal approach for this kind of small deployment.
5. Once through setup, click **"Connect"** on your cluster, then
   **"Drivers"** (sometimes labeled "Connect your application"). Copy the
   connection string shown — it looks like:
   ```
   mongodb+srv://yourusername:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Replace `<password>` in that string with the actual database user
   password from step 3. **Save this full string somewhere** — this is
   your `MONGODB_URI`, needed in Step 4.

---

## Step 2 — Put the code on GitHub

Render deploys from a GitHub repository. If you already know git, feel
free to use it — otherwise, here's the no-command-line way:

1. Go to **https://github.com/signup** and create a free account, if you
   don't already have one.
2. Once logged in, click the **+** icon (top right) → **"New repository"**.
3. Name it anything (e.g. `full-time`). Set it to **Private** (recommended
   — it's your app, no reason to make it public). Leave everything else
   default. Click **"Create repository"**.
4. On the new (empty) repository page, click **"uploading an existing
   file"** (a link in the setup instructions shown).
5. Unzip the Full-Time folder on your computer, then **drag the entire
   contents** of that folder (not the folder itself — its contents:
   `server.js`, `lib/`, `public/`, `package.json`, etc.) into the upload
   area on the GitHub page.
6. **Important:** do NOT upload your `.env` file — it has your real API
   keys in it, and this repo (even private) shouldn't contain them. GitHub
   should already exclude it if you dragged the folder contents in, since
   `.gitignore` lists it — but double check `.env` isn't in the file list
   before committing. If it's there, remove it from the upload list.
7. Scroll down, add a commit message (e.g. "Initial upload"), and click
   **"Commit changes"**.

Your code is now on GitHub, ready for Render to deploy from.

---

## Step 3 — Create the Render web service

1. Go to **https://dashboard.render.com/register** and sign up (GitHub
   login is the easiest option here — it'll also let Render see your
   repos in the next step).
2. Click **"New +"** → **"Web Service"**.
3. Connect your GitHub account if prompted, then select the repository
   you created in Step 2.
4. Fill in the settings:
   - **Name**: anything (this becomes part of your free URL, e.g.
     `full-time-xyz.onrender.com`)
   - **Region**: any
   - **Branch**: `main` (or whatever your default branch is called)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Don't click "Create Web Service" yet — scroll down to the
   **Environment Variables** section first (Step 4).

---

## Step 4 — Set your environment variables

Still on the same Render setup page, add each of these under
**Environment Variables** (click "Add Environment Variable" for each):

| Key | Value |
|---|---|
| `MONGODB_URI` | The connection string from Step 1 |
| `EXA_API_KEY` | Your Exa key |
| `GEMINI_API_KEY` | Your Gemini key |
| `COHERE_API_KEY` | Your Cohere key (if you have one) |
| `ADMIN_USERNAME` | Whatever username you want as the admin |
| `ADMIN_PASSWORD` | A password you choose (recommended — otherwise one is generated randomly and only shown once, in Render's logs) |
| `NODE_ENV` | `production` |

You can copy these values straight out of your local `.env` file — it's
the same keys, just entered into Render's dashboard instead of a local
file.

Now click **"Create Web Service"**. Render will install dependencies, run
`npm start`, and after a minute or two you'll see a URL like
`https://full-time-xyz.onrender.com` — that's your live site.

---

## Step 5 — First login

1. Open your Render service's **"Logs"** tab (in the Render dashboard).
2. Look for a block like:
   ```
   ======================================================================
   First run detected — created an admin account:
     Username: admin
   ======================================================================
   ```
   If you set `ADMIN_PASSWORD` in Step 4, the password is whatever you
   chose. If you didn't, it's printed right there in the logs — copy it
   now, it's shown only once.
3. Visit your Render URL, and log in with that username/password.
4. Go to **Users & Limits** (sidebar) to create accounts for your friends.

---

## Updating the app later

Whenever you get a new version of the code from me:

1. Go to your GitHub repository → **"Add file"** → **"Upload files"** →
   drag in the updated files (same as Step 2) → commit.
2. Render automatically detects the change and redeploys within a minute
   or two — no action needed on the Render side.

Your MongoDB data is completely unaffected by this — it lives on Atlas,
entirely separate from whatever Render's local filesystem does.

---

## Notes on the free tier

- **Cold starts**: after ~15 minutes with no visitors, Render's free tier
  puts the app to sleep. The next visitor triggers a wake-up that takes
  20-60 seconds before the site responds. This is normal and expected —
  it does NOT lose any data (that's all in MongoDB now), it's just a
  slower first load after a quiet period.
- **MongoDB Atlas free tier (M0)** is free forever, not a trial — 512MB of
  storage, which is far more than a small friend-group prediction history
  will ever use.
- If you ever want to remove the cold-start delay, Render's smallest paid
  tier (~$7/month) keeps the app running continuously. Your MongoDB setup
  doesn't need to change at all for that — it's purely a Render setting.
