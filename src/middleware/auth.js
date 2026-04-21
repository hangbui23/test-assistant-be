import jwt from 'jsonwebtoken';
import { jwtConfig } from '../config/index.js';

export default function auth(req, res, next) {
  // ✅ BỎ QUA preflight request
  if (req.method === "OPTIONS") {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (req.method === 'OPTIONS') {
  return next();
}

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Debug log: print received token
  console.log('[AUTH] Received token:', token);

  if (!token) {
    console.error('[AUTH] No token provided');
    return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  }
  try {
    const payload = jwt.verify(token, jwtConfig.secret);
    req.user = {
      userId: payload.sub,
      email: payload.email,
      name: payload.name
    };
    next();
  } catch (error) {
    // Debug log: print jwt.verify error
    console.error('[AUTH] JWT verify error:', error);
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }
}

// Function to issue access token
export function issueAccessToken(user) {
  return jwt.sign(
    { 
      sub: String(user._id), 
      email: user.email, 
      name: user.name 
    }, 
    jwtConfig.secret, 
    { 
      expiresIn: jwtConfig.accessTokenTtlSec 
    }
  );
}

// Function to issue refresh token
export function issueRefreshToken(user) {
  return jwt.sign(
    { 
      sub: String(user._id), 
      type: 'refresh' 
    }, 
    jwtConfig.secret, 
    { 
      expiresIn: jwtConfig.refreshTokenTtlSec 
    }
  );
}