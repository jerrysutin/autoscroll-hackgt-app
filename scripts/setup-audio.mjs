// Restore the exact bundled model/runtime. No package installation or runtime CDN access.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = new URL('../AutoScroll/Shared (Extension)/Resources/audio-assets/', import.meta.url);
const sources = JSON.parse(await readFile(new URL('SOURCES.json', assets), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function download(url, expected) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch: ${url}`);
    return bytes;
}
await mkdir(new URL('yamnet/', assets), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'autoscroll-audio-'));
try {
    const archive = join(temporary, 'yamnet.tar.gz');
    await writeFile(archive, await download(sources.model.url, sources.model.archiveSha256));
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (members.some(member => !/^model\.json$|^group1-shard[1-4]of4\.bin$/.test(member))) throw new Error('Unexpected model archive contents.');
    execFileSync('tar', ['-xzf', archive, '-C', fileURLToPath(new URL('yamnet/', assets))]);
    const files = {
        'tf.min.js': sources.runtime.url,
        'TENSORFLOW-LICENSE.txt': 'https://raw.githubusercontent.com/tensorflow/tfjs/tfjs-v4.22.0/LICENSE',
        'yamnet/LICENSE.txt': 'https://raw.githubusercontent.com/tensorflow/models/master/LICENSE',
        'yamnet/yamnet_class_map.csv': 'https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv'
    };
    for (const [path, url] of Object.entries(files)) {
        await writeFile(new URL(path, assets), await download(url, sources.files[path]));
    }
    for (const [path, hash] of Object.entries(sources.files)) {
        if (sha256(await readFile(new URL(path, assets))) !== hash) throw new Error(`Asset verification failed: ${path}`);
    }
    console.log('Audio assets restored and verified. Rebuild the extension in Xcode.');
} finally {
    await rm(temporary, { recursive: true, force: true });
}
