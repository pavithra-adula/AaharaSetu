// frontend/server.js - run with: node server.js
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if(err){ res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('\n=====================================');
  console.log('  Ration Platform — Frontend Server');
  console.log('=====================================');
  console.log(`  Open: http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop');
  console.log('=====================================\n');
});