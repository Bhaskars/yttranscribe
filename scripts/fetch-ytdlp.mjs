// Downloads standalone Linux yt-dlp builds for the Vercel function bundle.
// Vercel Functions currently run arm64, but we keep both architectures so the
// app also works if the project is switched back to x86_64.
// Runs during the Vercel build; local development keeps using the PATH binary.
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BIN = path.join(process.cwd(), 'bin');
const RELEASE = process.env.YTDLP_RELEASE || 'latest';
const BASE = process.env.YTDLP_DOWNLOAD_BASE || `https://github.com/yt-dlp/yt-dlp/releases/${RELEASE}/download`;

const TARGETS = [
  { file: 'yt-dlp-x64', asset: 'yt-dlp_linux' },
  { file: 'yt-dlp-arm64', asset: 'yt-dlp_linux_aarch64' }
];

async function present(target) {
  try {
    const info = await stat(target);
    return info.size > 1_000_000;
  } catch {
    return false;
  }
}

await mkdir(BIN, { recursive: true });

for (const { file, asset } of TARGETS) {
  const target = path.join(BIN, file);
  if (await present(target)) {
    console.log(`${file} already downloaded`);
    continue;
  }

  const url = `${BASE}/${asset}`;
  console.log(`Downloading ${asset}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`Download failed for ${asset}: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(target, buffer);
  await chmod(target, 0o755);
  console.log(`${file} ready (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}
