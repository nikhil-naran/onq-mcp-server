import { afterEach, describe, expect, it } from 'vitest';
import { WindowsFileDelivery } from '@/contexts/onq/infrastructure/WindowsFileDelivery.js';
import { FileDeliveryConfigSchema } from '@/shared-kernel/config/schema.js';

const services: WindowsFileDelivery[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.dispose())); });
async function setup(overrides = {}) {
  const service = new WindowsFileDelivery({ publicBaseUrl: 'https://downloads.example.com', port: 0,
    ttlSeconds: 30, maxBytes: 100, maxFileBytes: 50, maxEntries: 2,
    maxConcurrentRetrievals: 2, maxConcurrentResponses: 2, ...overrides });
  services.push(service);
  await service.start();
  return service;
}
function register(service: WindowsFileDelivery, filename = 'lecture.pdf', data = Buffer.from('%PDF-original')) {
  const published = service.reserve().publish({ data, filename, mimeType: 'application/pdf' });
  return { ...published, url: service.localUrl + new URL(published.downloadUrl).pathname, data };
}

describe('Windows original-file download service', () => {
  it('delivers exact bytes repeatedly with safe Unicode filename, HEAD and no caching', async () => {
    const s = await setup();
    const file = register(s, 'Révision 1.pdf');
    expect(file.downloadUrl).toMatch(/^https:\/\/downloads\.example\.com\/files\/[a-f0-9]{64}\//);
    const head = await fetch(file.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(file.data.length));
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-disposition')).toContain("filename*=UTF-8''R%C3%A9vision%201.pdf");
    expect(head.headers.get('cache-control')).toContain('no-store');
    expect(head.headers.get('x-content-type-options')).toBe('nosniff');
    for (let i = 0; i < 2; i++) {
      const response = await fetch(file.url);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(file.data);
    }
  });

  it('supports closed, open and suffix ranges, rejecting malformed/unsatisfiable ranges', async () => {
    const file = register(await setup(), 'a.pdf', Buffer.from('0123456789'));
    for (const [range, body, contentRange] of [
      ['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=8-', '89', 'bytes 8-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10'],
    ]) {
      const response = await fetch(file.url, { headers: { Range: range! } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(await response.text()).toBe(body);
    }
    for (const range of ['bytes=11-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'potato', 'bytes=999999999999999999999-']) {
      const response = await fetch(file.url, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('enforces expiry on every request and permits a fresh token after expiry', async () => {
    let time = 100_000;
    const s = await setup({ now: () => time, maxEntries: 1 });
    const first = register(s);
    time += 30_000;
    expect((await fetch(first.url)).status).toBe(404);
    expect((await fetch(first.url, { method: 'HEAD' })).status).toBe(404);
    const second = register(s);
    expect(second.downloadUrl).not.toBe(first.downloadUrl);
    expect((await fetch(second.url)).status).toBe(200);
  });

  it('rejects guessed tokens, changed filenames, extra paths, queries and disallowed methods', async () => {
    const s = await setup();
    const f = register(s);
    for (const url of [s.localUrl + '/', s.localUrl + '/config.yaml', f.url + '?token=x',
      f.url.replace('lecture.pdf', 'secret.pdf'), s.localUrl + '/files/' + '0'.repeat(64) + '/lecture.pdf',
      f.url.replace('lecture.pdf', '%ZZ'), f.url.replace('lecture.pdf', '%2Fetc%2Fpasswd')]) {
      expect((await fetch(url)).status).toBe(404);
    }
    expect((await fetch(f.url, { method: 'POST' })).status).toBe(405);
  });

  it('reserves worst-case bytes before downloads and never evicts live links', async () => {
    const s = await setup({ maxBytes: 60, maxEntries: 3 });
    const reservation = s.reserve();
    expect(() => s.reserve()).toThrow(/capacity/);
    reservation.release();
    reservation.release();
    const f = register(s, 'a.pdf', Buffer.alloc(40));
    expect(() => s.reserve()).toThrow(/capacity/);
    expect((await fetch(f.url)).status).toBe(200);
  });

  it('bounds concurrent source retrievals and cache entry count separately', async () => {
    const s = await setup({ maxConcurrentRetrievals: 1, maxEntries: 1 });
    const reservation = s.reserve();
    expect(() => s.reserve()).toThrow(/retrievals are still running/);
    reservation.publish({ data: Buffer.from('x'), filename: 'a.txt', mimeType: 'text/plain' });
    expect(() => s.reserve()).toThrow(/capacity/);
  });

  it('refuses invalid files and allows releasing failed reservations', async () => {
    const s = await setup();
    for (const file of [
      { data: Buffer.alloc(51), filename: 'x.pdf', mimeType: 'application/pdf' },
      { data: Buffer.alloc(0), filename: 'x.pdf', mimeType: 'application/pdf' },
      { data: Buffer.from('x'), filename: '../x.pdf', mimeType: 'application/pdf' },
      { data: Buffer.from('x'), filename: 'x.pdf', mimeType: 'a\r\nb' },
    ]) {
      const reservation = s.reserve();
      expect(() => reservation.publish(file)).toThrow(/registered/);
      reservation.release();
    }
    expect((await fetch(register(s).url)).status).toBe(200);
  });

  it('reports a bind collision and makes all reservations unavailable after shutdown', async () => {
    const s = await setup();
    const reservation = s.reserve();
    const other = new WindowsFileDelivery({ publicBaseUrl: 'https://downloads.example.com',
      port: Number(new URL(s.localUrl).port), ttlSeconds: 30, maxBytes: 100, maxFileBytes: 50,
      maxEntries: 2, maxConcurrentRetrievals: 2, maxConcurrentResponses: 2 });
    services.push(other);
    await expect(other.start()).rejects.toMatchObject({ code: 'delivery_unavailable' });
    await s.dispose();
    expect(() => s.reserve()).toThrow(/not running/);
    expect(() => reservation.publish({ data: Buffer.from('x'), filename: 'x', mimeType: 'text/plain' })).toThrow();
    reservation.release();
  });
});

describe('download configuration', () => {
  it('is opt-in, validates HTTPS origins and bounds memory/TTL/ports', () => {
    expect(FileDeliveryConfigSchema.parse({}).mode).toBe('embedded');
    const valid = { mode: 'download', public_base_url: 'https://downloads.example.com' };
    expect(FileDeliveryConfigSchema.parse(valid).ttl_seconds).toBe(900);
    for (const public_base_url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/files',
      'https://example.com?token=secret', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://pc.local']) {
      expect(FileDeliveryConfigSchema.safeParse({ ...valid, public_base_url }).success).toBe(false);
    }
    for (const extra of [{ port: 80 }, { ttl_seconds: 0 }, { max_cache_bytes: 0 }, { max_entries: 0 }])
      expect(FileDeliveryConfigSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    expect(FileDeliveryConfigSchema.safeParse({ mode: 'download' }).success).toBe(false);
  });
});
