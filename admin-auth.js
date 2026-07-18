const crypto = require('crypto');

// token -> expiry timestamp (ms). In-memory is fine for a single-instance
// Node process; sessions reset on redeploy, which just means you log in again.
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function login(username, password) {
  const validUser = process.env.ADMIN_USER || 'AleksArtPhoto';
  const validPass = process.env.ADMIN_PASS || '2988672';

  if (username !== validUser || password !== validPass) {
    return null;
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValid(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function logout(token) {
  sessions.delete(token);
}

// Express middleware — expects the token in the "admin_token" cookie
function requireAdmin(req, res, next) {
  const token = req.cookies ? req.cookies.admin_token : null;
  if (!isValid(token)) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  next();
}

module.exports = { login, isValid, logout, requireAdmin };
