import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { WindowsFileDelivery } from '../build/contexts/onq/infrastructure/WindowsFileDelivery.js';

const [publicBaseUrl, port = '8766'] = process.argv.slice(2);
if (!publicBaseUrl) throw new Error('Usage: download-probe.mjs HTTPS_ORIGIN [PORT]');
// A real two-page PDF with a last-page diagram, created without private course data.
function probePdf() {
  const pages = [
    'BT /F1 24 Tf 60 740 Td (OnQ download probe - page 1) Tj ET',
    'BT /F1 24 Tf 60 740 Td (Last page: ORCHID-471) Tj ET\n0 0 1 rg 60 500 120 90 re f\n1 0 0 rg 300 500 120 90 re f\n0 0 0 RG 180 545 m 300 545 l S',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    ...pages.flatMap((stream, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const service = new WindowsFileDelivery({ publicBaseUrl, port: Number(port), ttlSeconds: 900,
  maxBytes: 128 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024, maxEntries: 16,
  maxConcurrentRetrievals: 2, maxConcurrentResponses: 16 });
await service.start();
const data = probePdf();
const link = service.reserve().publish({ data, filename: 'onq-download-probe.pdf', mimeType: 'application/pdf' });
process.stdout.write(JSON.stringify({ ...link, byte_length: data.length, sha256: createHash('sha256').update(data).digest('hex') }, null, 2) + '\n');
process.stdout.write('Ask ChatGPT to download this synthetic PDF, verify its checksum, and describe the last-page text and diagram. Ctrl+C stops the probe and revokes the link.\n');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.dispose(); process.exit(0); });
