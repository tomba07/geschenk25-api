import express, { Response } from 'express';
import pool from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get user's groups
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const result = await pool.query(
      'SELECT id, name, description, created_at, created_by FROM groups WHERE created_by = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({ groups: result.rows });
  } catch (error: any) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get single group
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    const result = await pool.query(
      'SELECT id, name, description, created_at, created_by FROM groups WHERE id = $1 AND created_by = $2',
      [groupId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json({ group: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// Create group
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, description } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const result = await pool.query(
      'INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id, name, description, created_at, created_by',
      [name.trim(), description?.trim() || null, userId]
    );

    res.status(201).json({ group: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Delete group
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    const result = await pool.query(
      'DELETE FROM groups WHERE id = $1 AND created_by = $2 RETURNING id',
      [groupId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json({ message: 'Group deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

export default router;

