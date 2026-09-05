import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const script = new URL('../dist/playlist-sort.user.js', import.meta.url);
createServer(async (request, response) => {
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
}).listen(8731, '127.0.0.1', () => {
  console.log('Install: http://127.0.0.1:8731/playlist-sort.user.js');
});
