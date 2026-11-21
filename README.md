# Vaani · transcript studio

Paste a YouTube link — or upload a video of your own — and get the words out.
Vaani reads the captions or listens with Whisper, translates into Tamil (or 44
other languages), and lays the result out as a clean document you can read,
copy, download as `.txt` or `.srt`, or print.

- **Tamil by default** — the language picker opens on தமிழ், with 44 others
  (Indian and world languages) one click away.
- **Links or files** — YouTube captions for links; local Whisper speech
  recognition for uploads. Uploaded files are temporary: they are deleted as
  soon as the document is ready.
- **Live progress** — captions, transcription and translation stream in as they
  finish, so long videos show passages filling in rather than a spinner.
- **Per-line timestamps** — every passage keeps its place in the video, and the
  `.srt` export carries cue-level timing.
- **Bilingual reading** — flip "Show original" to see the source caption under
  each translated passage.
- **Made to keep** — copy to the clipboard, download `.txt`/`.srt`, or print to
  PDF with a dedicated print stylesheet.

## Requirements

- **Node.js 18.17+** — no npm dependencies, no build step.
- **yt-dlp** (recommended) — the most reliable way to reach YouTube captions.
- **ffmpeg** and **Whisper** (optional) — only needed to transcribe uploaded
  video or audio files.

```bash
# any one of these
pip install -U yt-dlp
pipx install yt-dlp
brew install yt-dlp

# uploads
brew install ffmpeg                 # macOS (Ubuntu: sudo apt install ffmpeg)
pip install -U openai-whisper
```

Without `yt-dlp` the server falls back to YouTube's innertube player API. That
usually works, but YouTube rate-limits it more aggressively, so `yt-dlp` is the
supported path. Without Whisper, YouTube links still work and the upload panel
explains what is missing.

## Run it

```bash
cd youtubetranscriber
npm start
```

Open <http://localhost:4173>, paste a link such as
`https://www.youtube.com/watch?v=aircAruvnKk`, pick a language, and press
**Transcribe & translate**.

For development with auto-restart:

```bash
npm run dev
```

## Uploading a video or audio file

Switch to **Upload a file** in the panel and drop in an MP4, MOV, WEBM, MKV,
MP3, WAV, M4A, AAC, OGG or FLAC. The server:

1. streams the upload straight into a temporary folder (it is never written to
   a database or a public folder),
2. extracts a mono 16 kHz audio track with ffmpeg,
3. deletes the original upload as soon as the audio is out,
4. transcribes the audio with Whisper, and
5. deletes the temporary audio as soon as the document is ready.

The default limit is **500 MB** locally. It is enforced on the client (with the
size shown in the upload panel) and on the server, and can be changed with
`MAX_UPLOAD_MB`. On Vercel the limit is 4 MB because of the platform's request
body cap — uploads also need Whisper, which the deployment does not bundle, so
the upload panel tells you to run Vaani locally instead.

The first transcription downloads the chosen Whisper model into
`~/.cache/whisper` (about 140 MB for the default `base` model). If that download
is blocked by a TLS-inspecting proxy, fetch the model once with `curl` or set
`WHISPER_MODEL_DIR` to a folder that already contains it.

## Putting it online with uploads

Vercel only runs the YouTube flow: serverless functions cap request bodies at
about 4.5 MB and cannot bundle ffmpeg or Whisper. To use 500 MB uploads from a
public URL, run Vaani on a container host, or expose your own machine with a
tunnel. For a quick tunnel:

```bash
VAANI_USER=vaani VAANI_PASS='choose-a-password' npm start
cloudflared tunnel --url http://127.0.0.1:4173
```

The printed `https://…trycloudflare.com` URL then serves the full app with
uploads. Keep the machine awake while the tunnel is in use, and stop it with
`pkill -f "cloudflared tunnel"`. Basic auth is optional but recommended for any
public tunnel, since the upload endpoint accepts large files.

## How it works

```
YouTube: browser ──GET /api/process?url=…&lang=ta──▶ server
                                                     │
                                     yt-dlp / innertube
                                                     │
                                     caption parser (json3 · VTT · XML)
                                                     │
Upload:  browser ──POST /api/upload?lang=ta──▶ temp file ──▶ ffmpeg ──▶ Whisper
                                                     │
                                     rolling-caption de-dupe → paragraphs
                                                     │
                           Google translate endpoint (batched, newline-aligned)
                                                     │
browser ◀── SSE: meta · stage · progress · done / fail ──┘
```

- The server streams results with **Server-Sent Events**, so the client can
  render each batch of translated passages as soon as it lands. Uploads use the
  same event stream over the POST response.
- Captions are grouped into readable paragraphs, but translation is requested
  line by line so every timestamp keeps its own text.
- Finished YouTube transcripts are cached in memory for 45 minutes
  (`videoId:language`), which makes repeat opens instant and avoids hammering
  YouTube. Uploads are not cached because the source file is deleted.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `YTDLP_PATH` | `yt-dlp` | Absolute path to the yt-dlp binary |
| `GOOGLE_TRANSLATE_API_KEY` | — | Use the official Google Cloud Translation API instead of the public endpoint |
| `YOUTUBE_COOKIES_B64` | — | Base64 Netscape cookie file, for hosts YouTube challenges |
| `YOUTUBE_COOKIES` | — | Same cookies as raw text (alternative to base64) |
| `YTDLP_PROXY` | — | HTTP/SOCKS proxy passed to yt-dlp (`http://user:pass@host:port`) |
| `MAX_UPLOAD_MB` | `500` (4 on Vercel) | Largest accepted upload |
| `VAANI_USER` / `VAANI_PASS` | — | Optional HTTP basic auth, for tunnels and public hosts |
| `WHISPER_BIN` | `whisper` | Path to the Whisper CLI |
| `WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium` or `large-v3` |
| `WHISPER_MODEL_DIR` | `~/.cache/whisper` | Where model files live |
| `WHISPER_TIMEOUT_MS` | 90 min | Hard limit for one transcription |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Audio tools used for uploads |

Example:

```bash
PORT=8080 YTDLP_PATH=/usr/local/bin/yt-dlp npm start
```

## Deploying to Vercel

The repo is ready for Vercel: `public/` is served as a static site, `api/[...path].js`
wraps the same HTTP handler, and the build downloads standalone Linux `yt-dlp`
binaries (arm64 and x86_64) into the function bundle.

```bash
npx vercel --prod
```

**YouTube usually blocks cloud IPs.** From Vercel, caption requests are
typically answered with “Sign in to confirm you’re not a bot”; Vaani then shows a
*YouTube blocked this server* message. Captions are fetched from this
deployment’s network, so the fix is to give yt-dlp credentials or a proxy:

1. **Cookies (recommended).** Export YouTube cookies in Netscape format (for
   example with the “Get cookies.txt LOCALLY” browser extension), then add an
   environment variable in Vercel:

   ```bash
   base64 -i cookies.txt | tr -d '\n' | pbcopy   # copy, then paste into Vercel
   ```

   Name it `YOUTUBE_COOKIES_B64` and redeploy. Raw cookie text also works via
   `YOUTUBE_COOKIES`. Treat these cookies like a password, and re-export them
   when they expire.

2. **Proxy.** Set `YTDLP_PROXY` to a proxy yt-dlp can use, such as
   `http://user:pass@host:port` or `socks5://host:port`.

Also note that a Hobby Vercel function stops at 60 seconds, so very long videos
may not finish in one request there. Running the app locally has no such limit.

Uploads are **not available on Vercel** out of the box: the function bundle has
no ffmpeg or Whisper, and the platform caps request bodies at about 4.5 MB. The
upload panel detects this and explains that files need the local app. Everything
else — the static site, the URL flow, and the streaming protocol — is shared.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server status, yt-dlp/Whisper/ffmpeg availability, upload limit |
| `GET /api/languages` | Supported translation languages |
| `GET /api/info?url=…` | Video title, channel, duration, thumbnail, caption track |
| `GET /api/process?url=…&lang=ta` | SSE job stream: `meta`, `stage`, `progress`, `done`, `fail` |
| `POST /api/upload?lang=ta&name=…` | Body is the raw file; answers with the same SSE stream |

## Project layout

```
server.js           HTTP server, SSE orchestration, upload handling, cache
lib/youtube.js      URL parsing, yt-dlp + innertube metadata and captions
lib/captions.js     json3 / VTT / XML parsers, de-dupe, paragraph building
lib/translate.js    batched translation with retries and alignment fallback
lib/transcribe.js   ffmpeg audio extraction + Whisper speech recognition
lib/languages.js    the 45 supported languages
public/             the interface (HTML, CSS, vanilla JS, no framework)
```

## Limitations

- The video must have captions — manual or YouTube's auto-generated track.
  Videos with speech but no caption track cannot be transcribed.
- YouTube occasionally rate-limits caption downloads (HTTP 429). The app asks
  you to wait a minute and retries with alternate extractor settings.
- Translation is machine translation. It is good for gist and reading, not for
  anything where wording is load-bearing. Verify quotes and technical terms
  against the original (the bilingual toggle makes this easy).
- Captions are segmented by the uploader or by YouTube's speech recognition, so
  a translated sentence can occasionally span two passages.
- The cache is in memory: restarting the server clears it, and nothing is
  written to disk.
- Only one video is processed per request; playlists are rejected.

## License

MIT
