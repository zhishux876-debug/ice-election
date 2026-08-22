const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const VOTES_FILE = path.join(DIR, 'votes.json');
const VOTERS_FILE = path.join(DIR, 'voters.json');

// ===== In-memory state =====
let votes = {};
let voters = {};
let sseClients = [];

// ===== File I/O =====
function loadData() {
  try {
    if (fs.existsSync(VOTES_FILE)) {
      votes = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8'));
    }
  } catch { votes = {}; }
  try {
    if (fs.existsSync(VOTERS_FILE)) {
      voters = JSON.parse(fs.readFileSync(VOTERS_FILE, 'utf8'));
    }
  } catch { voters = {}; }
}

function saveVotes() {
  fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2), 'utf8');
}

function saveVoters() {
  fs.writeFileSync(VOTERS_FILE, JSON.stringify(voters, null, 2), 'utf8');
}

loadData();

// ===== Cookie helpers =====
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function getOrCreateVoterId(req, res) {
  const cookies = parseCookies(req);
  let voterId = cookies['voter_id'];
  if (!voterId) {
    voterId = crypto.randomUUID();
    res.setHeader('Set-Cookie', `voter_id=${voterId}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  if (!voters[voterId]) {
    voters[voterId] = { votedProducts: [], createdAt: new Date().toISOString() };
    saveVoters();
  }
  return voterId;
}

// ===== SSE =====
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

// ===== API helpers =====
function getVoteData() {
  const actualVotersCount = Object.values(voters).filter(v => v.votedProducts && v.votedProducts.length > 0).length;
  return {
    votes,
    totalVoters: actualVotersCount,
    totalVotes: Object.values(votes).reduce((a, b) => a + b, 0)
  };
}

function getResults() {
  const actualVotersCount = Object.values(voters).filter(v => v.votedProducts && v.votedProducts.length > 0).length;
  const entries = Object.entries(votes)
    .map(([id, count]) => ({ id, votes: count }))
    .sort((a, b) => b.votes - a.votes);
  entries.forEach((e, i) => e.rank = i + 1);
  return {
    results: entries,
    totalVoters: actualVotersCount,
    totalVotes: Object.values(votes).reduce((a, b) => a + b, 0)
  };
}

// ===== Read request body =====
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ===== MIME types =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===== Server =====
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // --- API Routes ---
    if (pathname === '/api/votes' && req.method === 'GET') {
      const voterId = getOrCreateVoterId(req, res);
      const data = getVoteData();
      data.myVotes = voters[voterId]?.votedProducts || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    if (pathname === '/api/vote' && req.method === 'POST') {
      const voterId = getOrCreateVoterId(req, res);
      const body = await readBody(req);
      const productId = body.productId;

      if (!productId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'productId is required' }));
      }

      // Check if already voted for this product
      const voter = voters[voterId];
      if (voter.votedProducts.includes(productId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Already voted for this product' }));
      }

      // Record vote
      votes[productId] = (votes[productId] || 0) + 1;
      voter.votedProducts.push(productId);
      saveVotes();
      saveVoters();

      const data = getVoteData();
      data.myVotes = voter.votedProducts;

      // Broadcast to SSE clients
      broadcastSSE({ type: 'vote', productId, votes: votes[productId], totalVotes: data.totalVotes, totalVoters: data.totalVoters });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    if (pathname === '/api/results' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getResults()));
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', ...getVoteData() })}\n\n`);
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // --- Static Files ---
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(DIR, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(content);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');

  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

server.listen(PORT, () => {
  console.log(`🍦 アイス総選挙サーバー起動！ http://localhost:${PORT}`);
  console.log(`   投票API:  http://localhost:${PORT}/api/votes`);
  console.log(`   SSE配信:  http://localhost:${PORT}/api/stream`);
});
