const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const state = require('./state');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set (put it in .env)');
  process.exit(1);
}
const SECRET = process.env.JWT_SECRET;
const VERIFY_OPTS = { algorithms: ['HS256'], issuer: 'chatlab' };

// Compared against when the user does not exist, so timing does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('dummy', 10);

async function login(req, res) {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = state.users.find((u) => u.username === username);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sub: user.username, role: user.role }, SECRET, {
    expiresIn: process.env.TOKEN_TTL || '15m',
    issuer: 'chatlab',
    algorithm: 'HS256',
  });
  res.json({ token });
}

function verify(token) {
  return jwt.verify(token, SECRET, VERIFY_OPTS);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.user = verify(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { login, verify, requireAuth };
