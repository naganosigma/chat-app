const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── 設定 ──────────────────────────────────────────────────
// 管理者パスワード（環境変数で変更推奨）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const MAX_HISTORY    = 200;
const PORT           = process.env.PORT || 3000;

// ── 招待コード管理 ─────────────────────────────────────────
// Map<code, { id, label, maxUses, usedCount, expiresAt, createdAt }>
const inviteCodes = new Map();

// デフォルト招待コードを1件作成しておく
function createCode({ label = '招待コード', maxUses = 0, expiresInHours = 0 } = {}) {
  const code = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
  inviteCodes.set(code, {
    id:        uuidv4(),
    label,
    maxUses,           // 0 = 無制限
    usedCount: 0,
    expiresAt: expiresInHours > 0 ? Date.now() + expiresInHours * 3600000 : null,
    createdAt: Date.now(),
  });
  return code;
}
// 起動時にデフォルトコードを1件作成
const defaultCode = createCode({ label: 'デフォルト', maxUses: 0 });
console.log(`🔑 デフォルト招待コード: ${defaultCode}`);

// ── ストレージ ─────────────────────────────────────────────
let chatHistory = [];
const onlineUsers = new Map(); // socketId → { username, id }

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// ── ファイルアップロード設定 ───────────────────────────────
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    /jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname).toLowerCase())
      ? cb(null, true) : cb(new Error('画像ファイルのみ'));
  },
});

// ── ミドルウェア ───────────────────────────────────────────
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

// ── 管理者認証ミドルウェア ─────────────────────────────────
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (pw === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: '管理者パスワードが正しくありません' });
}

// ══════════════════════════════════════════════════════════
// 管理者 API
// ══════════════════════════════════════════════════════════

// 管理者ログイン確認
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'パスワードが正しくありません' });
  }
});

// 招待コード一覧取得
app.get('/admin/codes', adminAuth, (req, res) => {
  const list = Array.from(inviteCodes.entries()).map(([code, info]) => ({
    code,
    ...info,
    expired: info.expiresAt ? Date.now() > info.expiresAt : false,
    exhausted: info.maxUses > 0 && info.usedCount >= info.maxUses,
  })).sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// 招待コード作成
app.post('/admin/codes', adminAuth, (req, res) => {
  const { label, maxUses = 0, expiresInHours = 0 } = req.body;
  const code = createCode({ label: label || '招待コード', maxUses: Number(maxUses), expiresInHours: Number(expiresInHours) });
  res.json({ code, ...inviteCodes.get(code) });
});

// 招待コード削除
app.delete('/admin/codes/:code', adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!inviteCodes.has(code)) return res.status(404).json({ error: 'コードが見つかりません' });
  inviteCodes.delete(code);
  res.json({ success: true });
});

// オンラインユーザー一覧
app.get('/admin/users', adminAuth, (req, res) => {
  res.json(Array.from(onlineUsers.values()));
});

// ── チャット API ───────────────────────────────────────────

// 招待コードで参加
app.post('/join', (req, res) => {
  const { code } = req.body;
  const key  = (code || '').toUpperCase();
  const info = inviteCodes.get(key);

  if (!info) return res.status(403).json({ error: 'コードが正しくありません' });
  if (info.expiresAt && Date.now() > info.expiresAt)
    return res.status(403).json({ error: 'このコードは有効期限切れです' });
  if (info.maxUses > 0 && info.usedCount >= info.maxUses)
    return res.status(403).json({ error: 'このコードは使用回数の上限に達しています' });

  info.usedCount++;
  res.json({ success: true });
});

// 画像アップロード
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// ── Socket.io ──────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('user:join', ({ username }) => {
    onlineUsers.set(socket.id, { id: socket.id, username });
    socket.emit('history', chatHistory);
    io.emit('users:update', Array.from(onlineUsers.values()));
    broadcastAndSave(buildMessage({ type: 'system', text: `${username} が参加しました` }));
  });

  socket.on('chat:message', ({ text, imageUrl }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    broadcastAndSave(buildMessage({ type: imageUrl ? 'image' : 'text', text, imageUrl, username: user.username, userId: user.id }));
  });

  // WebRTC シグナリング
  socket.on('call:offer',  ({ targetId, offer, callerName }) => io.to(targetId).emit('call:incoming',  { callerId: socket.id, callerName, offer }));
  socket.on('call:answer', ({ targetId, answer })            => io.to(targetId).emit('call:answered',  { answer }));
  socket.on('call:ice',    ({ targetId, candidate })         => io.to(targetId).emit('call:ice',       { candidate }));
  socket.on('call:reject', ({ targetId })                    => io.to(targetId).emit('call:rejected'));
  socket.on('call:end',    ({ targetId })                    => io.to(targetId).emit('call:ended'));

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      io.emit('users:update', Array.from(onlineUsers.values()));
      broadcastAndSave(buildMessage({ type: 'system', text: `${user.username} が退室しました` }));
    }
  });
});

// ── ヘルパー ───────────────────────────────────────────────
function buildMessage({ type, text, imageUrl, username, userId }) {
  return { id: uuidv4(), type, text: text||'', imageUrl: imageUrl||null, username: username||'システム', userId: userId||null, timestamp: Date.now() };
}
function broadcastAndSave(msg) {
  io.emit('chat:message', msg);
  chatHistory.push(msg);
  if (chatHistory.length > MAX_HISTORY) chatHistory = chatHistory.slice(-MAX_HISTORY);
}

// ── 起動 ──────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ シグマChat起動中 → http://localhost:${PORT}`);
  console.log(`🔑 デフォルト招待コード: ${defaultCode}`);
  console.log(`🔐 管理者パスワード: ${ADMIN_PASSWORD}`);
  console.log(`📋 管理画面: http://localhost:${PORT}/admin.html`);
});
