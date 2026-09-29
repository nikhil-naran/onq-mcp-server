import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { setInterval, clearInterval } from 'node:timers';
import { FileDeliveryError } from '../domain/FileDelivery.js';
import type { FileDelivery, FileDeliveryReservation } from '../domain/FileDelivery.js';

export interface WindowsFileDeliveryOptions {
  publicBaseUrl: string;
  port: number;
  ttlSeconds: number;
  maxBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxConcurrentRetrievals: number;
  maxConcurrentResponses: number;
  /** Injectable clock; tokens still use cryptographic randomness. */
  now?: () => number;
}

interface Entry {
  data: Buffer;
  filename: string;
  mimeType: string;
  expires: number;
  readers: number;
}

/** Loopback-only original-byte service. No filesystem, LMS credentials or request logging. */
export class WindowsFileDelivery implements FileDelivery {
  private readonly entries = new Map<string, Entry>();
  private readonly server: Server;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private ready = false;
  private bytes = 0;
  private reservations = 0;
  private responses = 0;
  private readonly origin: string;

  constructor(private readonly options: WindowsFileDeliveryOptions) {
    const url = new URL(options.publicBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Download public URL must be an HTTPS origin without credentials, path, query or fragment.');
    this.origin = url.origin;
    this.now = options.now ?? Date.now;
    this.server = createServer({ maxHeaderSize: 8192 }, (req, res) => this.handle(req, res));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxRequestsPerSocket = 100;
    this.server.maxConnections = 64;
    // Never log malformed request bytes or URLs: they can contain bearer tokens.
    this.server.on('clientError', (_err, socket) => socket.destroy());
    this.server.on('close', () => { this.ready = false; });
    this.server.on('error', () => { this.ready = false; });
  }

  async start(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const failed = () => {
        this.server.removeListener('listening', listening);
        reject(new FileDeliveryError('delivery_unavailable', 'Download listener could not bind to its loopback port.'));
      };
      const listening = () => {
        this.server.removeListener('error', failed);
        this.ready = true;
        resolve();
      };
      this.server.once('error', failed);
      this.server.once('listening', listening);
      this.server.listen(this.options.port, '127.0.0.1');
    });
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** Actual loopback address, useful for the synthetic probe and local tests. */
  get localUrl(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Download service is not listening.');
    return `http://127.0.0.1:${address.port}`;
  }

  reserve(): FileDeliveryReservation {
    if (!this.ready) throw new FileDeliveryError('delivery_unavailable', 'Download service is not running.');
    this.sweep();
    if (this.reservations >= this.options.maxConcurrentRetrievals)
      throw new FileDeliveryError('delivery_busy', 'Original-file retrievals are still running. Retry this file after those retrievals finish.');
    if (this.entries.size + this.reservations >= this.options.maxEntries ||
        this.bytes + (this.reservations + 1) * this.options.maxFileBytes > this.options.maxBytes)
      throw new FileDeliveryError('delivery_capacity_exceeded', 'Temporary download capacity is full. Retry after existing links expire.');
    this.reservations++;
    let active = true;
    const release = () => {
      if (active) { active = false; this.reservations--; }
    };
    return {
      release,
      publish: ({ data, filename, mimeType }) => {
        if (!active || !this.ready)
          throw new FileDeliveryError('delivery_unavailable', 'Download reservation is no longer available.');
        if (!data.length || data.length > this.options.maxFileBytes || /[\r\n]/.test(mimeType) ||
            !filename || /[/\\]/.test(filename) || [...filename].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
          throw new FileDeliveryError('delivery_unavailable', 'Original file cannot be registered for download.');
        const token = randomBytes(32).toString('hex');
        const expires = this.now() + this.options.ttlSeconds * 1000;
        // Ownership of this freshly fetched Buffer transfers to the cache. No extra copy.
        this.entries.set(token, { data, filename, mimeType, expires, readers: 0 });
        this.bytes += data.length;
        release();
        return { downloadUrl: `${this.origin}/files/${token}/${encodeURIComponent(filename)}`,
          expiresAt: new Date(expires).toISOString() };
      },
    };
  }

  private sweep(): void {
    for (const [token, entry] of this.entries) {
      // In-flight buffers count against the cap until their response releases them.
      if (entry.expires <= this.now() && entry.readers === 0) {
        this.entries.delete(token);
        this.bytes -= entry.data.length;
      }
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const fail = (status: number) => { res.statusCode = status; res.end(); };
    // Match the raw request target: reject queries, traversal, absolute URLs and extra routes.
    const match = /^\/files\/([a-f0-9]{64})\/([^/?#]+)$/.exec(req.url ?? '');
    if (!match) return fail(404);
    let filename: string;
    try { filename = decodeURIComponent(match[2]!); } catch { return fail(404); }
    const entry = this.entries.get(match[1]!);
    if (!entry || entry.expires <= this.now() || filename !== entry.filename) {
      this.sweep();
      return fail(404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return fail(405);
    }
    if (this.responses >= this.options.maxConcurrentResponses) return fail(503);
    let start = 0;
    let end = entry.data.length - 1;
    // RFC range semantics apply to GET. HEAD returns metadata for the entire original.
    if (req.method === 'GET' && req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) {
        res.setHeader('Content-Range', `bytes */${entry.data.length}`);
        return fail(416);
      }
      if (!range[1]) {
        const suffix = Number(range[2]);
        start = Math.max(0, entry.data.length - suffix);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) start = entry.data.length;
      } else {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), end) : end;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.data.length) {
        res.setHeader('Content-Range', `bytes */${entry.data.length}`);
        return fail(416);
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.data.length}`);
    }
    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    const ascii = entry.filename.replace(/[^A-Za-z0-9._ -]/g, '_');
    const encoded = encodeURIComponent(entry.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
    entry.readers++;
    this.responses++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.readers--;
      this.responses--;
      this.sweep();
    };
    res.once('close', release);
    res.once('finish', release);
    res.setTimeout(60_000, () => res.destroy());
    res.end(req.method === 'HEAD' ? undefined : entry.data.subarray(start, end + 1));
  }

  async dispose(): Promise<void> {
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    if (this.server.listening) {
      await new Promise<void>(resolve => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
    }
    this.entries.clear();
    this.bytes = 0;
  }
}
