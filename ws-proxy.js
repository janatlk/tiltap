const http = require('http');
const httpProxy = require('http-proxy');

const proxy = httpProxy.createProxyServer({
  target: 'http://192.168.0.108:5494',
  ws: true,
  changeOrigin: true,
  headers: {
    'Origin': 'http://192.168.0.108:5494'
  }
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
});

const server = http.createServer((req, res) => {
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  req.headers.origin = 'http://192.168.0.108:5494';
  proxy.ws(req, socket, head);
});

server.listen(5495, '0.0.0.0', () => {
  console.log('WebSocket proxy running on port 5495');
});
