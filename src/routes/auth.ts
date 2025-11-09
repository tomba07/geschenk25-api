import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db';

const router = express.Router();

// Register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }

    // Check if username already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const { display_name } = req.body;
    const displayName = display_name?.trim() || null;

    // Create user
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, username, display_name, created_at',
      [username.toLowerCase().trim(), passwordHash, displayName]
    );

    const user = result.rows[0];

    // Generate JWT token
    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      secret,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
      },
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const result = await pool.query('SELECT id, username, password_hash, display_name FROM users WHERE username = $1', [
      username.toLowerCase().trim(),
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate JWT token
    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      secret,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Search users by username (requires authentication)
router.get('/search', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    jwt.verify(token, secret);

    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 1) {
      return res.json({ users: [] });
    }

    const searchTerm = `%${q.toLowerCase().trim()}%`;
    const result = await pool.query(
      'SELECT id, username, display_name FROM users WHERE username LIKE $1 ORDER BY username LIMIT 20',
      [searchTerm]
    );

    // Map results to include display_name or fallback to username
    const users = result.rows.map((row: any) => ({
      id: row.id,
      username: row.username,
      display_name: row.display_name || row.username,
    }));

    res.json({ users });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('User search error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Verify token (for checking if user is authenticated)
router.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const decoded: any = jwt.verify(token, secret);

    // Get fresh user data
    const result = await pool.query('SELECT id, username, display_name, created_at FROM users WHERE id = $1', [decoded.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
      },
    });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Failed to verify token' });
  }
});

// Update display name
router.put('/profile/display-name', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const decoded: any = jwt.verify(token, secret);

    const { display_name } = req.body;
    
    if (display_name !== undefined) {
      if (typeof display_name !== 'string') {
        return res.status(400).json({ error: 'Display name must be a string' });
      }
      
      if (display_name.length > 100) {
        return res.status(400).json({ error: 'Display name must be 100 characters or less' });
      }
    }

    const displayName = display_name?.trim() || null;

    const result = await pool.query(
      'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, username, display_name',
      [displayName, decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
      },
    });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Update display name error:', error);
    res.status(500).json({ error: 'Failed to update display name' });
  }
});

// Register device token for push notifications
router.post('/device-token', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const decoded: any = jwt.verify(token, secret);

    const { device_token, platform } = req.body;

    if (!device_token || !platform) {
      return res.status(400).json({ error: 'Device token and platform are required' });
    }

    if (!['ios', 'android'].includes(platform.toLowerCase())) {
      return res.status(400).json({ error: 'Platform must be "ios" or "android"' });
    }

    // Upsert device token
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, token)
       DO UPDATE SET platform = $3, updated_at = CURRENT_TIMESTAMP`,
      [decoded.userId, device_token, platform.toLowerCase()]
    );

    res.json({ message: 'Device token registered successfully' });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Register device token error:', error);
    res.status(500).json({ error: 'Failed to register device token' });
  }
});

export default router;

