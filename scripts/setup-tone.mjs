// Restore pinned local-only tone assets; audio is never sent to these hosts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../AutoScroll/Shared (Extension)/Resources/tone-assets/', import.meta.url);
const { files } = JSON.parse(await readFile(new URL('SOURCES.json', root), 'utf8'));
await mkdir(root, { recursive: true });
for (const [name, { url, sha256 }] of Object.entries(files)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch: ${name}`);
    await writeFile(new URL(name, root), bytes);
}
console.log('Tone assets restored and verified. Rebuild the extension.');
