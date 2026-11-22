// 最小转发代理（仅用于开发测试代理功能）：HTTPS 走 CONNECT 隧道，HTTP 直接转发
// 用法: node scripts/dev-proxy.mjs [端口=9390]
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.argv[2] || 9390);

const server = http.createServer((req, res) => {
  const u = new URL(req.url);
  const up = http.request(
    { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end('proxy error');
  });
  req.pipe(up);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const up = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
  });
  up.on('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });
  clientSocket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`dev proxy on http://127.0.0.1:${PORT}`));
