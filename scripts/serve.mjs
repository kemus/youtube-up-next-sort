import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

const script = new URL('../dist/playlist-sort.user.js', import.meta.url);
const handler = async (request, response) => {
  if (request.url !== '/playlist-sort.user.js') {
    response.writeHead(404).end('Open /playlist-sort.user.js');
    return;
  }
  try {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(script));
  } catch {
    response.writeHead(500).end('Run npm run build first.');
  }
};

// Localhost, plus this machine's Tailscale addresses (100.64.0.0/10) so other
// devices on the tailnet can install too. Nothing listens on other networks.
const tailnet = address => {
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
};
const hosts = ['127.0.0.1', ...Object.values(networkInterfaces()).flat()
  .filter(entry => entry.family === 'IPv4' && tailnet(entry.address))
  .map(entry => entry.address)];
for (const host of hosts) {
  createServer(handler).listen(8731, host, () => {
    console.log(`Install: http://${host}:8731/playlist-sort.user.js`);
  });
}
