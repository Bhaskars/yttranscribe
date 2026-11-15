# Vaani · transcript studio

Paste a YouTube link, get the words out. Vaani reads the video's captions,
translates them into Tamil (or 44 other languages), and lays the result out as
a clean document you can read, copy, download as `.txt` or `.srt`, or print.

- **Tamil by default** — the language picker opens on தமிழ், with 44 others
  (Indian and world languages) one click away.
- **Live progress** — captions and translation stream in as they finish, so
  long videos show passages filling in rather than a spinner.
- **Per-line timestamps** — every passage keeps its place in the video, and the
  `.srt` export carries cue-level timing.
- **Bilingual reading** — flip "Show original" to see the source caption under
  each translated passage.
- **Made to keep** — copy to the clipboard, download `.txt`/`.srt`, or print to
  PDF with a dedicated print stylesheet.

## Requirements

- **Node.js 18.17+** — no npm dependencies, no build step.
- **yt-dlp** (recommended) — the most reliable way to reach YouTube captions.

```bash
# any one of these
pip install -U yt-dlp
pipx install yt-dlp
brew install yt-dlp
```

Without `yt-dlp` the server falls back to YouTube's innertube player API. That
usually works, but YouTube rate-limits it more aggressively, so `yt-dlp` is the
supported path.

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

## How it works

```
browser ──GET /api/process?url=…&lang=ta──▶ server
                                            │
                        yt-dlp / innertube ─┴─▶ video metadata + one caption track
                                            │
                                  caption parser (json3 · VTT · XML)
                                            │
                             rolling-caption de-dupe → paragraphs
                                            │
                    Google translate endpoint (batched, newline-aligned)
                                            │
browser ◀── SSE: meta · stage · progress · done / fail ──┘
```

- The server streams results with **Server-Sent Events**, so the client can
  render each batch of translated passages as soon as it lands.
- Captions are grouped into readable paragraphs, but translation is requested
  line by line so every timestamp keeps its own text.
- Finished transcripts are cached in memory for 45 minutes (`videoId:language`),
  which makes repeat opens instant and avoids hammering YouTube.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `YTDLP_PATH` | `yt-dlp` | Absolute path to the yt-dlp binary |
| `GOOGLE_TRANSLATE_API_KEY` | — | Use the official Google Cloud Translation API instead of the public endpoint |

Example:

```bash
PORT=8080 YTDLP_PATH=/usr/local/bin/yt-dlp npm start
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server status, yt-dlp version, language count |
| `GET /api/languages` | Supported translation languages |
| `GET /api/info?url=…` | Video title, channel, duration, thumbnail, caption track |
| `GET /api/process?url=…&lang=ta` | SSE job stream: `meta`, `stage`, `progress`, `done`, `fail` |

## Project layout

```
server.js           HTTP server, SSE orchestration, cache, static files
lib/youtube.js      URL parsing, yt-dlp + innertube metadata and captions
lib/captions.js     json3 / VTT / XML parsers, de-dupe, paragraph building
lib/translate.js    batched translation with retries and alignment fallback
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
