// Restore pinned local-only speech assets; audio is never sent to these hosts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../AutoScroll/Shared (Extension)/Resources/speech-assets/', import.meta.url);
const { files } = JSON.parse(await readFile(new URL('SOURCES.json', root), 'utf8'));
for (const [name, { url, sha256 }] of Object.entries(files)) {
    const target = new URL(name, root);
    try {
        if (createHash('sha256').update(await readFile(target)).digest('hex') === sha256) continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch: ${name}`);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`Restored ${name}`);
}
console.log('Speech assets verified. Rebuild the extension.');
