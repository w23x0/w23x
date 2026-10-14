import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const HEADER = 'AVBK1';

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  if (existsSync(root)) walk(root);
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function createEncryptedBackup(dataDir: string, outDir: string, passphrase: string): string {
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {};
  const root = dataDir;
  for (const full of listFilesRecursive(root)) {
    const rel = toPosix(relative(root, full));
    if (!rel || rel.startsWith('..')) continue;
    files[rel] = readFileSync(full).toString('base64');
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    files,
  };
  const plain = Buffer.from(JSON.stringify(manifest), 'utf8');
  const gz = gzipSync(plain);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.concat([Buffer.from(HEADER, 'ascii'), salt, iv, tag, enc]);

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filePath = join(outDir, `avatar-backup-${stamp}.bin`);
  writeFileSync(filePath, out);
  return filePath;
}

function assertSafeRel(rel: string): void {
  if (typeof rel !== 'string' || rel.trim() === '') throw new Error('invalid path in backup');
  if (isAbsolute(rel)) throw new Error('absolute path in backup');
  const norm = rel.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.includes('..')) throw new Error('path escapes base');
  if (parts.includes('') ) throw new Error('invalid path in backup');
}

export function restoreBackup(file: string, targetDir: string, passphrase: string): void {
  // target must not exist or be empty
  if (existsSync(targetDir)) {
    let entries: string[] = [];
    try { entries = readdirSync(targetDir); } catch {}
    if (entries.length > 0) throw new Error('target directory must be empty or non-existent');
  }

  const buf = readFileSync(file);
  if (buf.length < 5 + 16 + 12 + 16) throw new Error('corrupt backup');
  if (buf.subarray(0, 5).toString('ascii') !== HEADER) throw new Error('invalid backup header');

  let off = 5;
  const salt = buf.subarray(off, off + 16); off += 16;
  const iv = buf.subarray(off, off + 12); off += 12;
  const tag = buf.subarray(off, off + 16); off += 16;
  const ct = buf.subarray(off);

  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let gz: Buffer;
  try {
    gz = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('decryption failed (wrong passphrase or tampered)');
  }

  let manifest: any;
  try {
    manifest = JSON.parse(gunzipSync(gz).toString('utf8'));
  } catch {
    throw new Error('invalid backup payload');
  }
  if (manifest?.version !== 1) throw new Error('unsupported backup version');
  if (typeof manifest.files !== 'object' || manifest.files === null) throw new Error('invalid backup manifest');

  // validate all entries first
  const entries = Object.keys(manifest.files);
  for (const rel of entries) {
    assertSafeRel(rel);
  }

  mkdirSync(targetDir, { recursive: true });
  for (const rel of entries) {
    const safe = rel.replace(/\\/g, '/');
    const parts = safe.split('/').filter(Boolean);
    const dest = join(targetDir, ...parts);
    mkdirSync(join(dest, '..'), { recursive: true });
    const b64 = manifest.files[rel];
    const data = Buffer.from(b64, 'base64');
    writeFileSync(dest, data);
  }
}