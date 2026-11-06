// Decode transient media using local files only; FFmpeg never receives a remote URL.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function decodeAudio(bytes) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-watch-oped-'));
    let timeout;
    let child;
    try {
        const input = path.join(directory, 'media.bin');
        await fs.writeFile(input, bytes, { mode: 0o600 });
        child = spawn('ffmpeg', [
            '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input,
            '-vn', '-f', 'f32le', '-ac', '1', '-ar', '8000', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        let size = 0;
        let exceeded = false;
        timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > 3600 * 8000 * 4) { exceeded = true; child.kill('SIGKILL'); }
            else output.push(chunk);
        });
        child.stderr.resume();
        const exit = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        if (exit !== 0 || exceeded || size < 16000 * 4) throw new Error('FFmpeg audio decoding failed or duration exceeded one hour.');
        const pcm = Buffer.concat(output);
        return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    } finally {
        clearTimeout(timeout);
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await fs.rm(directory, { recursive: true, force: true });
    }
}

module.exports = { decodeAudio };
