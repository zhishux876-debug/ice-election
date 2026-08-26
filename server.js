require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const VOTES_FILE = path.join(DIR, 'votes.json');
const VOTERS_FILE = path.join(DIR, 'voters.json');

// ===== Supabase Configuration =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ===== In-memory state =====
let votes = {};
let voters = {};
let sseClients = [];

// ===== Keep-alive(Render無料プランのスリープ対策)=====
// Render無料プランは約15分アクセスが無いとスリープするため、
// 10分ごとに自分自身へHTTPリクエストを送ってスリープを防ぐ。
// RENDER_EXTERNAL_URL はRenderが自動で設定する環境変数。
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

function startKeepAlive() {
  if (!KEEP_ALIVE_URL) {
    console.log('ℹ️ KEEP_ALIVE_URL / RENDER_EXTERNAL_URL 未設定のため keep-alive は無効(ローカル実行時は不要)');
    return;
  }
  setInterval(async () => {
    try {
      await fetch(`${KEEP_ALIVE_URL}/healthz`);
    } catch (e) {
      console.error('⚠️ keep-alive ping 失敗:', e.message);
    }
  }, KEEP_ALIVE_INTERVAL_MS);
  console.log(`⏰ keep-alive 有効: ${KEEP_ALIVE_URL}/healthz に10分ごとにping`);
}

// ===== Data Loading =====
async function loadData() {
  if (supabase) {
    try {
      console.log('🔄 Supabaseから投票データを取得中...');
      const { data, error } = await supabase
        .from('ice_votes')
        .select('voter_id, product_id');

      if (error) {
        console.error('⚠️ Supabaseデータ取得エラー:', error.message);
        console.log('👉 SUPABASE_SETUP.md を確認してテーブル作成とRLSポリシーを設定してください。');
        loadLocalData();
        return;
      }

      votes = {};
      voters = {};

      if (data && data.length > 0) {
        data.forEach(row => {
          const { voter_id, product_id } = row;
          votes[product_id] = (votes[product_id] || 0) + 1;
          if (!voters[voter_id]) {
            voters[voter_id] = { votedProducts: [] };
          }
          if (!voters[voter_id].votedProducts.includes(product_id)) {
            voters[voter_id].votedProducts.push(product_id);
          }
        });
      }
      const actualVotersCount = Object.keys(voters).length;
      const totalVoteCount = data ? data.length : 0;
      console.log(`✅ Supabase同期完了: 累計 ${totalVoteCount} 票 / ${actualVotersCount} 名の投票者`);
    } catch (err) {
      console.error('Supabase接続エラー:', err);
      loadLocalData();
    }
  } else {
    console.log('ℹ️ SUPABASE_URL / SUPABASE_KEY が設定されていないため、ローカルJSONファイルを使用します。');
    loadLocalData();
  }
}

function loadLocalData() {
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

function saveLocalVotes() {
  try {
    fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2), 'utf8');
  } catch (e) {
    console.error('ローカル votes.json 保存エラー:', e);
  }
}

function saveLocalVoters() {
  try {
    fs.writeFileSync(VOTERS_FILE, JSON.stringify(voters, null, 2), 'utf8');
  } catch (e) {
    console.error('ローカル voters.json 保存エラー:', e);
  }
}

// ===== Cookie & Voter ID helpers =====
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
  let voterId = req.headers['x-voter-id'] || cookies['voter_id'];
  if (!voterId) {
    voterId = crypto.randomUUID();
  }
  // Cookieをセット（1年間有効）
  res.setHeader('Set-Cookie', `voter_id=${voterId}; Path=/; Max-Age=31536000; SameSite=Lax`);

  if (!voters[voterId]) {
    voters[voterId] = { votedProducts: [], createdAt: new Date().toISOString() };
    if (!supabase) saveLocalVoters();
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Voter-Id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // --- Health check (keep-alive ping先) ---
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

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

      // Check if already voted for this product (in memory)
      const voter = voters[voterId] || { votedProducts: [] };
      if (voter.votedProducts.includes(productId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Already voted for this product' }));
      }

      // Record vote in Supabase if configured
      if (supabase) {
        const { error } = await supabase
          .from('ice_votes')
          .insert([{ voter_id: voterId, product_id: productId }]);

        if (error) {
          // If unique constraint violation (duplicate vote)
          if (error.code === '23505') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Already voted for this product' }));
          }
          console.error('Supabase insert error:', error.message);
          // Fallback to local save
          votes[productId] = (votes[productId] || 0) + 1;
          voter.votedProducts.push(productId);
          saveLocalVotes();
          saveLocalVoters();
        } else {
          // Success in Supabase
          votes[productId] = (votes[productId] || 0) + 1;
          if (!voters[voterId]) {
            voters[voterId] = { votedProducts: [] };
          }
          voters[voterId].votedProducts.push(productId);
        }
      } else {
        // Local file storage
        votes[productId] = (votes[productId] || 0) + 1;
        voter.votedProducts.push(productId);
        saveLocalVotes();
        saveLocalVoters();
      }

      const data = getVoteData();
      data.myVotes = voters[voterId]?.votedProducts || [];

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

async function startServer() {
  await loadData();
  server.listen(PORT, () => {
    console.log(`🍦 アイス総選挙サーバー起動！ http://localhost:${PORT}`);
    if (supabase) {
      console.log(`📡 Supabase連携モード: 有効 (${SUPABASE_URL})`);
    } else {
      console.log(`📁 ローカルファイル保存モード: 有効 (SUPABASE_URL未設定)`);
    }
    console.log(`   投票API:  http://localhost:${PORT}/api/votes`);
    console.log(`   SSE配信:  http://localhost:${PORT}/api/stream`);
    startKeepAlive();
  });
}

// 想定外のエラーでプロセスごと落ちるのを防ぐ
process.on('uncaughtException', err => {
  console.error('⚠️ uncaughtException:', err);
});
process.on('unhandledRejection', reason => {
  console.error('⚠️ unhandledRejection:', reason);
});

startServer();
