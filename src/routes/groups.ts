import express, { Response } from 'express';
import pool from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get user's groups (both created and joined)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const result = await pool.query(
      `SELECT DISTINCT g.id, g.name, g.description, g.created_at, g.created_by 
       FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.created_by = $1 OR gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );

    res.json({ groups: result.rows });
  } catch (error: any) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get pending invitations for current user (must be before /:id route)
router.get('/invitations/pending', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const result = await pool.query(
      `SELECT i.id, i.group_id, i.inviter_id, i.created_at,
              g.name as group_name, g.description as group_description,
              u.username as inviter_username
       FROM invitations i
       JOIN groups g ON i.group_id = g.id
       JOIN users u ON i.inviter_id = u.id
       WHERE i.invitee_id = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [userId]
    );

    res.json({ invitations: result.rows });
  } catch (error: any) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

// Accept invitation (must be before /:id route)
router.post('/invitations/:id/accept', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const invitationId = parseInt(req.params.id);

    // Get invitation
    const inviteResult = await pool.query(
      'SELECT id, group_id, invitee_id, status FROM invitations WHERE id = $1',
      [invitationId]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invitation = inviteResult.rows[0];

    if (invitation.invitee_id !== userId) {
      return res.status(403).json({ error: 'Not authorized to accept this invitation' });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Invitation is not pending' });
    }

    // Add user to group_members
    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [invitation.group_id, userId]
    );

    // Update invitation status
    await pool.query(
      "UPDATE invitations SET status = 'accepted' WHERE id = $1",
      [invitationId]
    );

    res.json({ message: 'Invitation accepted successfully' });
  } catch (error: any) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// Reject invitation (must be before /:id route)
router.post('/invitations/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const invitationId = parseInt(req.params.id);

    // Get invitation
    const inviteResult = await pool.query(
      'SELECT id, invitee_id, status FROM invitations WHERE id = $1',
      [invitationId]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invitation = inviteResult.rows[0];

    if (invitation.invitee_id !== userId) {
      return res.status(403).json({ error: 'Not authorized to reject this invitation' });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Invitation is not pending' });
    }

    // Update invitation status
    await pool.query(
      "UPDATE invitations SET status = 'rejected' WHERE id = $1",
      [invitationId]
    );

    res.json({ message: 'Invitation rejected successfully' });
  } catch (error: any) {
    console.error('Error rejecting invitation:', error);
    res.status(500).json({ error: 'Failed to reject invitation' });
  }
});

// Get single group (with members)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user has access to this group (owner or member)
    const accessCheck = await pool.query(
      `SELECT g.id, g.name, g.description, g.created_at, g.created_by
       FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = accessCheck.rows[0];

    // Get owner info
    const ownerResult = await pool.query(
      'SELECT id, username FROM users WHERE id = $1',
      [group.created_by]
    );

    // Get members (excluding owner, as they'll be added separately)
    const membersResult = await pool.query(
      `SELECT u.id, u.username, gm.joined_at
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    // Combine owner and members, with owner first
    const ownerMember = {
      id: ownerResult.rows[0].id,
      username: ownerResult.rows[0].username,
      joined_at: group.created_at, // Use group creation date as joined_at for owner
    };

    const allMembers = [ownerMember, ...membersResult.rows];

    res.json({
      group: {
        ...group,
        members: allMembers,
        owner: ownerResult.rows[0],
      },
    });
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

// Invite user to group
router.post('/:id/invite', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Check if user is owner or member of the group
    const groupCheck = await pool.query(
      `SELECT g.id, g.created_by FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, userId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Find the user to invite
    const inviteeResult = await pool.query(
      'SELECT id, username FROM users WHERE username = $1',
      [username.toLowerCase().trim()]
    );

    if (inviteeResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const inviteeId = inviteeResult.rows[0].id;

    if (inviteeId === userId) {
      return res.status(400).json({ error: 'Cannot invite yourself' });
    }

    // Check if user is already a member
    const memberCheck = await pool.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, inviteeId]
    );

    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of this group' });
    }

    // Check if there's already a pending invitation
    const existingInvite = await pool.query(
      'SELECT id, status FROM invitations WHERE group_id = $1 AND invitee_id = $2',
      [groupId, inviteeId]
    );

    if (existingInvite.rows.length > 0) {
      const invite = existingInvite.rows[0];
      if (invite.status === 'pending') {
        return res.status(400).json({ error: 'Invitation already sent' });
      }
      // If rejected, update to pending
      await pool.query(
        'UPDATE invitations SET status = $1, inviter_id = $2, created_at = CURRENT_TIMESTAMP WHERE id = $3',
        ['pending', userId, invite.id]
      );
    } else {
      // Create new invitation
      await pool.query(
        'INSERT INTO invitations (group_id, inviter_id, invitee_id, status) VALUES ($1, $2, $3, $4)',
        [groupId, userId, inviteeId, 'pending']
      );
    }

    res.json({ message: 'Invitation sent successfully' });
  } catch (error: any) {
    console.error('Error inviting user:', error);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// Remove member from group (owner only)
router.delete('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const memberId = parseInt(req.params.userId);

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only group owner can remove members' });
    }

    if (memberId === userId) {
      return res.status(400).json({ error: 'Cannot remove yourself from the group' });
    }

    await pool.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, memberId]
    );

    res.json({ message: 'Member removed successfully' });
  } catch (error: any) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Assign Secret Santa pairs (owner only)
router.post('/:id/assign', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only group owner can trigger assignments' });
    }

    // Get all members (including owner)
    const membersResult = await pool.query(
      `SELECT DISTINCT u.id, u.username
       FROM users u
       WHERE (u.id = $1 AND u.id IN (SELECT created_by FROM groups WHERE id = $2))
          OR u.id IN (SELECT user_id FROM group_members WHERE group_id = $2)
       ORDER BY u.id`,
      [userId, groupId]
    );

    const members = membersResult.rows;

    if (members.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 members to create assignments' });
    }

    // Create random pairing (Secret Santa algorithm)
    const shuffled = [...members];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Ensure no one is assigned to themselves
    let validPairing = false;
    let attempts = 0;
    const maxAttempts = 100;

    while (!validPairing && attempts < maxAttempts) {
      validPairing = true;
      for (let i = 0; i < members.length; i++) {
        if (members[i].id === shuffled[i].id) {
          validPairing = false;
          // Reshuffle using Fisher-Yates
          for (let j = shuffled.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
          }
          break;
        }
      }
      attempts++;
    }

    if (!validPairing) {
      return res.status(500).json({ error: 'Failed to create valid assignments. Please try again.' });
    }

    // Delete existing assignments for this group
    await pool.query('DELETE FROM assignments WHERE group_id = $1', [groupId]);

    // Create new assignments
    for (let i = 0; i < members.length; i++) {
      await pool.query(
        'INSERT INTO assignments (group_id, giver_id, receiver_id) VALUES ($1, $2, $3)',
        [groupId, members[i].id, shuffled[i].id]
      );
    }

    res.json({ message: 'Assignments created successfully' });
  } catch (error: any) {
    console.error('Error creating assignments:', error);
    res.status(500).json({ error: 'Failed to create assignments' });
  }
});

// Get current user's assignment for a group
router.get('/:id/assignment', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user has access to this group
    const accessCheck = await pool.query(
      `SELECT g.id FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Get user's assignment
    const assignmentResult = await pool.query(
      `SELECT a.receiver_id, u.username as receiver_username
       FROM assignments a
       JOIN users u ON a.receiver_id = u.id
       WHERE a.group_id = $1 AND a.giver_id = $2`,
      [groupId, userId]
    );

    if (assignmentResult.rows.length === 0) {
      return res.json({ assignment: null });
    }

    res.json({
      assignment: {
        receiver_id: assignmentResult.rows[0].receiver_id,
        receiver_username: assignmentResult.rows[0].receiver_username,
      },
    });
  } catch (error: any) {
    console.error('Error fetching assignment:', error);
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

// Get all assignments for a group (owner only, for verification)
router.get('/:id/assignments', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only group owner can view all assignments' });
    }

    // Get all assignments
    const assignmentsResult = await pool.query(
      `SELECT a.giver_id, a.receiver_id,
              giver.username as giver_username,
              receiver.username as receiver_username
       FROM assignments a
       JOIN users giver ON a.giver_id = giver.id
       JOIN users receiver ON a.receiver_id = receiver.id
       WHERE a.group_id = $1
       ORDER BY giver.username`,
      [groupId]
    );

    res.json({ assignments: assignmentsResult.rows });
  } catch (error: any) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

export default router;

