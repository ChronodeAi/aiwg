import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';

const unavailable = () => Object.assign(new Error('identity_unavailable'), { code: 'identity_unavailable' });

async function credential(file, secret = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || ![0, process.getuid()].includes(info.uid) ||
        (info.mode & (secret ? 0o077 : 0o022)) || info.size < 1 || info.size > 65536) throw unavailable();
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw unavailable();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Backend-only HTTPS transport, pinned to one realm and one workload leaf. */
export function createDesktopIssuerTransport({ issuer, certificateFile, keyFile, caFile, thumbprint, timeoutMs = 5000 }) {
  const realm = new URL(issuer);
  if (realm.protocol !== 'https:' || realm.username || realm.password || realm.search || realm.hash ||
      !/\/realms\/[^/]+$/.test(realm.pathname) || !certificateFile || !keyFile ||
      !/^[A-Za-z0-9_-]{43}$/.test(thumbprint) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new TypeError('Explicit desktop issuer TLS configuration required');
  }
  return async (url, init = {}) => {
    try {
      const target = new URL(url);
      if (target.origin !== realm.origin || !target.pathname.startsWith(`${realm.pathname}/protocol/openid-connect/`) ||
          target.username || target.password || target.search || target.hash || init.signal?.aborted) throw unavailable();
      const [cert, key, ca] = await Promise.all([
        credential(certificateFile), credential(keyFile, true), caFile ? credential(caFile) : undefined,
      ]);
      const leaf = new X509Certificate(cert);
      const pin = Buffer.from(leaf.fingerprint256.replaceAll(':', ''), 'hex').toString('base64url');
      if (pin !== thumbprint || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw unavailable();
      return await new Promise((resolve, reject) => {
        const req = request(target, { method: init.method ?? 'GET', headers: init.headers, cert, key, ca,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false, signal: init.signal }, (res) => {
          const chunks = []; let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) req.destroy(unavailable());
            else chunks.push(chunk);
          });
          res.on('error', () => reject(unavailable()));
          res.on('end', () => {
            if (size > 65536 || res.statusCode >= 300 && res.statusCode < 400) return reject(unavailable());
            resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode }));
          });
        });
        const timer = setTimeout(() => req.destroy(unavailable()), timeoutMs);
        req.on('close', () => clearTimeout(timer));
        req.on('error', () => reject(unavailable()));
        req.end(init.body);
      });
    } catch { throw unavailable(); }
  };
}
