import express, { Request, Response } from 'express';
import crypto from 'crypto';
import pool from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { sendInvitationNotification, sendAssignmentNotification } from '../services/notifications';
import { SecretSantaMatcher } from '../utils/secretSantaMatcher';

const router = express.Router();

// Helper function to generate invite token
function generateInviteToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Public route: Get group info from invite token (no auth required)
router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token;

    const result = await pool.query(
      'SELECT id, name, description, image_url FROM groups WHERE invite_token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    const group = result.rows[0];
    res.json({ group: { id: group.id, name: group.name, description: group.description, image_url: group.image_url } });
  } catch (error: any) {
    console.error('Error fetching group from invite token:', error);
    res.status(500).json({ error: 'Failed to fetch group info' });
  }
});

// All routes below require authentication
router.use(authenticateToken);

// Join group via invite token
router.post('/join/:token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const token = req.params.token;

    // Find group by invite token
    const groupResult = await pool.query(
      'SELECT id, name, created_by FROM groups WHERE invite_token = $1',
      [token]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    const group = groupResult.rows[0];
    const groupId = group.id;

    // Check if user is already a member
    const memberCheck = await pool.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: 'You are already a member of this group' });
    }

    // Check if user is the owner
    if (group.created_by === userId) {
      return res.status(400).json({ error: 'You are the owner of this group' });
    }

    // Add user to group
    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, userId]
    );

    // Update any pending invitations to accepted
    await pool.query(
      "UPDATE invitations SET status = 'accepted' WHERE group_id = $1 AND invitee_id = $2 AND status = 'pending'",
      [groupId, userId]
    );

    res.json({ message: 'Successfully joined group', group_id: groupId });
  } catch (error: any) {
    console.error('Error joining group via invite token:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

// Get user's groups (both created and joined)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const result = await pool.query(
      `SELECT DISTINCT g.id, g.name, g.description, g.image_url, g.created_at, g.created_by,
              (1 + COALESCE((SELECT COUNT(*) FROM group_members WHERE group_id = g.id), 0)) as member_count
       FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.created_by = $1 OR gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );

    // Convert member_count from string to number (PostgreSQL returns it as string)
    const groups = result.rows.map((row: any) => ({
      ...row,
      member_count: parseInt(row.member_count, 10),
    }));

    res.json({ groups });
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
              u.username as inviter_username, u.display_name as inviter_display_name
       FROM invitations i
       JOIN groups g ON i.group_id = g.id
       JOIN users u ON i.inviter_id = u.id
       WHERE i.invitee_id = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [userId]
    );

    // Map results to include display_name
    const invitations = result.rows.map((row: any) => ({
      ...row,
      inviter_display_name: row.inviter_display_name || row.inviter_username,
    }));

    res.json({ invitations });
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

// Cancel pending invitation (group owner only, must be before /:id route)
router.delete('/:id/invitations/:invitationId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const invitationId = parseInt(req.params.invitationId);

    if (isNaN(groupId) || isNaN(invitationId)) {
      return res.status(400).json({ error: 'Invalid group ID or invitation ID' });
    }

    // Check if user is owner of the group
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only group owner can cancel invitations' });
    }

    // Get invitation to verify it belongs to this group
    const inviteResult = await pool.query(
      'SELECT id, group_id, status FROM invitations WHERE id = $1',
      [invitationId]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    if (inviteResult.rows[0].group_id !== groupId) {
      return res.status(400).json({ error: 'Invitation does not belong to this group' });
    }

    if (inviteResult.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Can only cancel pending invitations' });
    }

    // Delete the invitation
    await pool.query('DELETE FROM invitations WHERE id = $1', [invitationId]);

    res.json({ message: 'Invitation cancelled successfully' });
  } catch (error: any) {
    console.error('Error cancelling invitation:', error);
    res.status(500).json({ error: 'Failed to cancel invitation' });
  }
});

// Get single group (with members)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user has access to this group (owner or member)
    const accessCheck = await pool.query(
      `SELECT g.id, g.name, g.description, g.image_url, g.created_at, g.created_by
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
      'SELECT id, username, display_name, image_url FROM users WHERE id = $1',
      [group.created_by]
    );

    // Get members (excluding owner, as they'll be added separately)
    const membersResult = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.image_url, gm.joined_at
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    // Combine owner and members, with owner first
    const owner = ownerResult.rows[0];
    const ownerMember = {
      id: owner.id,
      username: owner.username,
      display_name: owner.display_name || owner.username,
      image_url: owner.image_url,
      joined_at: group.created_at, // Use group creation date as joined_at for owner
    };

    const allMembers = [
      ownerMember,
      ...membersResult.rows.map((m: any) => ({
        id: m.id,
        username: m.username,
        display_name: m.display_name || m.username,
        image_url: m.image_url,
        joined_at: m.joined_at,
      })),
    ];

    // Get pending invitations for this group (only if user is owner)
    let pendingInvitations: any[] = [];
    if (group.created_by === userId) {
      // Get member IDs to exclude from pending invitations
      const memberIds = new Set([
        group.created_by,
        ...membersResult.rows.map((m: any) => m.id)
      ]);

      const invitationsResult = await pool.query(
        `SELECT i.id, i.invitee_id, i.created_at,
                u.username, u.display_name
         FROM invitations i
         JOIN users u ON i.invitee_id = u.id
         WHERE i.group_id = $1 AND i.status = 'pending'
         ORDER BY i.created_at DESC`,
        [groupId]
      );

      // Filter out users who are already members
      pendingInvitations = invitationsResult.rows
        .filter((row: any) => !memberIds.has(row.invitee_id))
        .map((row: any) => ({
          id: row.invitee_id,
          username: row.username,
          display_name: row.display_name || row.username,
          invitation_id: row.id,
          invited_at: row.created_at,
        }));
    }

    res.json({
      group: {
        ...group,
        members: allMembers,
        owner: {
          id: owner.id,
          username: owner.username,
          display_name: owner.display_name || owner.username,
        },
        pending_invitations: pendingInvitations,
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
    const { name, description, image_url } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const result = await pool.query(
      'INSERT INTO groups (name, description, image_url, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, description, image_url, created_at, created_by',
      [name.trim(), description?.trim() || null, image_url || null, userId]
    );

    res.status(201).json({ group: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Update group
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const { image_url } = req.body;

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    // Check if group exists and user is the owner
    const groupCheck = await pool.query(
      'SELECT id, created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only the group owner can update the group' });
    }

    // Update group image
    const result = await pool.query(
      'UPDATE groups SET image_url = $1 WHERE id = $2 RETURNING id, name, description, image_url, created_at, created_by',
      [image_url || null, groupId]
    );

    res.json({ group: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Get or generate invite link for a group (owner only)
router.get('/:id/invite-link', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    // Check if group exists and user is the owner
    const groupCheck = await pool.query(
      'SELECT id, created_by, invite_token FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only the group owner can access the invite link' });
    }

    let inviteToken = groupCheck.rows[0].invite_token;

    // Generate token if it doesn't exist
    if (!inviteToken) {
      let tokenGenerated = false;
      let attempts = 0;
      const maxAttempts = 5;

      while (!tokenGenerated && attempts < maxAttempts) {
        inviteToken = generateInviteToken();
        try {
          await pool.query(
            'UPDATE groups SET invite_token = $1 WHERE id = $2',
            [inviteToken, groupId]
          );
          tokenGenerated = true;
        } catch (error: any) {
          // Token collision, try again
          if (error.code === '23505') { // Unique violation
            attempts++;
            continue;
          }
          throw error;
        }
      }

      if (!tokenGenerated) {
        return res.status(500).json({ error: 'Failed to generate invite link. Please try again.' });
      }
    }

    res.json({ invite_token: inviteToken });
  } catch (error: any) {
    console.error('Error getting invite link:', error);
    res.status(500).json({ error: 'Failed to get invite link' });
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

    // Get group name and inviter display name for notification
    const groupResult = await pool.query('SELECT name FROM groups WHERE id = $1', [groupId]);
    const groupName = groupResult.rows[0]?.name || 'a group';
    
    const inviterResult = await pool.query(
      'SELECT display_name, username FROM users WHERE id = $1',
      [userId]
    );
    const inviterDisplayName = inviterResult.rows[0]?.display_name || inviterResult.rows[0]?.username || 'Someone';

    // Check if there's already a pending invitation
    const existingInvite = await pool.query(
      'SELECT id, status FROM invitations WHERE group_id = $1 AND invitee_id = $2',
      [groupId, inviteeId]
    );

    let invitationId: number;

    if (existingInvite.rows.length > 0) {
      const invite = existingInvite.rows[0];
      if (invite.status === 'pending') {
        return res.status(400).json({ error: 'Invitation already sent' });
      }
      // If rejected, update to pending
      invitationId = invite.id;
      await pool.query(
        'UPDATE invitations SET status = $1, inviter_id = $2, created_at = CURRENT_TIMESTAMP WHERE id = $3',
        ['pending', userId, invite.id]
      );
    } else {
      // Create new invitation and get the ID
      const insertResult = await pool.query(
        'INSERT INTO invitations (group_id, inviter_id, invitee_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
        [groupId, userId, inviteeId, 'pending']
      );
      invitationId = insertResult.rows[0].id;
    }

    // Send push notification (don't wait for it)
    sendInvitationNotification(inviteeId, inviterDisplayName, groupName, groupId, invitationId, userId).catch((error) => {
      console.error('Failed to send notification:', error);
    });

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

    // Get exclusions for this group
    const exclusionsResult = await pool.query(
      'SELECT giver_id, excluded_user_id FROM exclusions WHERE group_id = $1',
      [groupId]
    );
    const exclusions = exclusionsResult.rows;
    const exclusionSet = new Set<string>();
    exclusions.forEach((ex: any) => {
      exclusionSet.add(`${ex.giver_id}-${ex.excluded_user_id}`);
    });

    // Use bipartite matching algorithm with exclusions
    const giverIds = members.map((m: any) => m.id);
    const receiverIds = [...giverIds]; // Same set for Secret Santa

    const matcher = new SecretSantaMatcher(giverIds, receiverIds);

    // Add all valid pairings (exclude self and excluded users)
    for (let i = 0; i < giverIds.length; i++) {
      const giverId = giverIds[i];
      for (let j = 0; j < receiverIds.length; j++) {
        const receiverId = receiverIds[j];
        // Skip self-assignment
        if (giverId === receiverId) {
          continue;
        }
        // Skip exclusions
        if (exclusionSet.has(`${giverId}-${receiverId}`)) {
          continue;
        }
        // Add valid pairing
        matcher.addSecretSantaPairing(i, j);
      }
    }

    // Generate pairs
    const pairs = matcher.generateSecretSantaPairs();

    // Check if we got a complete matching
    if (pairs.size < members.length) {
      return res.status(500).json({
        error: 'Failed to create valid assignments with current exclusions. Some members may have too many exclusions. Please try again or adjust exclusions.',
      });
    }

    // Delete existing assignments for this group
    await pool.query('DELETE FROM assignments WHERE group_id = $1', [groupId]);

    // Create new assignments
    for (const [giverId, receiverId] of pairs.entries()) {
      await pool.query(
        'INSERT INTO assignments (group_id, giver_id, receiver_id) VALUES ($1, $2, $3)',
        [groupId, giverId, receiverId]
      );
    }

    // Get group name for notification
    const groupNameResult = await pool.query('SELECT name FROM groups WHERE id = $1', [groupId]);
    const groupName = groupNameResult.rows[0]?.name || 'your group';

    // Send notifications to all members (including owner)
    const memberIds = members.map(m => m.id);
    sendAssignmentNotification(memberIds, groupName, groupId).catch((error) => {
      console.error('Failed to send assignment notifications:', error);
    });

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
      `SELECT a.receiver_id, u.username as receiver_username, u.display_name as receiver_display_name, u.image_url as receiver_image_url
       FROM assignments a
       JOIN users u ON a.receiver_id = u.id
       WHERE a.group_id = $1 AND a.giver_id = $2`,
      [groupId, userId]
    );

    if (assignmentResult.rows.length === 0) {
      return res.json({ assignment: null });
    }

    const row = assignmentResult.rows[0];
    res.json({
      assignment: {
        receiver_id: row.receiver_id,
        receiver_username: row.receiver_username,
        receiver_display_name: row.receiver_display_name || row.receiver_username,
        receiver_image_url: row.receiver_image_url,
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
              giver.display_name as giver_display_name,
              receiver.username as receiver_username,
              receiver.display_name as receiver_display_name
       FROM assignments a
       JOIN users giver ON a.giver_id = giver.id
       JOIN users receiver ON a.receiver_id = receiver.id
       WHERE a.group_id = $1
       ORDER BY giver.username`,
      [groupId]
    );

    // Map results to include display_name
    const assignments = assignmentsResult.rows.map((row: any) => ({
      giver_id: row.giver_id,
      receiver_id: row.receiver_id,
      giver_username: row.giver_username,
      giver_display_name: row.giver_display_name || row.giver_username,
      receiver_username: row.receiver_username,
      receiver_display_name: row.receiver_display_name || row.receiver_username,
    }));

    res.json({ assignments });
  } catch (error: any) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Delete all assignments for a group (owner only)
router.delete('/:id/assignments', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupCheck.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Only group owner can delete assignments' });
    }

    // Delete all assignments for this group
    await pool.query('DELETE FROM assignments WHERE group_id = $1', [groupId]);

    res.json({ message: 'Assignments deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting assignments:', error);
    res.status(500).json({ error: 'Failed to delete assignments' });
  }
});

// Create gift idea
router.post('/:id/gift-ideas', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const { for_user_id, idea, link } = req.body;

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    if (!for_user_id || !idea || idea.trim().length === 0) {
      return res.status(400).json({ error: 'for_user_id and idea are required' });
    }

    // Check if user has access to this group (owner or member)
    const groupCheck = await pool.query(
      `SELECT g.id FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, userId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Check if for_user_id is a member of the group (owner or member)
    const memberCheck = await pool.query(
      `SELECT 1 FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, for_user_id]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Target user is not a member of this group' });
    }

    // Create gift idea
    const result = await pool.query(
      `INSERT INTO gift_ideas (group_id, for_user_id, created_by_id, idea, link)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, group_id, for_user_id, created_by_id, idea, link, created_at, updated_at`,
      [groupId, for_user_id, userId, idea.trim(), link?.trim() || null]
    );

    // Get creator and target user info
    const creatorResult = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [userId]
    );
    const targetResult = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [for_user_id]
    );

    const giftIdea = result.rows[0];
    const creator = creatorResult.rows[0];
    const target = targetResult.rows[0];

    res.status(201).json({
      gift_idea: {
        ...giftIdea,
        created_by: {
          id: creator.id,
          username: creator.username,
          display_name: creator.display_name || creator.username,
        },
        for_user: {
          id: target.id,
          username: target.username,
          display_name: target.display_name || target.username,
        },
      },
    });
  } catch (error: any) {
    console.error('Error creating gift idea:', error);
    res.status(500).json({ error: 'Failed to create gift idea' });
  }
});

// Get gift ideas for a group
router.get('/:id/gift-ideas', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const forUserId = req.query.for_user_id ? parseInt(req.query.for_user_id as string) : null;

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    // Check if user has access to this group (owner or member)
    const groupCheck = await pool.query(
      `SELECT g.id FROM groups g
       LEFT JOIN group_members gm ON g.id = gm.group_id
       WHERE g.id = $1 AND (g.created_by = $2 OR gm.user_id = $2)`,
      [groupId, userId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Get user's assignment to see who they're assigned to
    const assignmentResult = await pool.query(
      'SELECT receiver_id FROM assignments WHERE group_id = $1 AND giver_id = $2',
      [groupId, userId]
    );
    const assignedToUserId = assignmentResult.rows.length > 0 ? assignmentResult.rows[0].receiver_id : null;

    // Build query - show gift ideas based on context
    let query = `
      SELECT gi.id, gi.group_id, gi.for_user_id, gi.created_by_id, gi.idea, gi.link, gi.created_at, gi.updated_at,
             creator.username as creator_username, creator.display_name as creator_display_name,
             target.username as target_username, target.display_name as target_display_name
      FROM gift_ideas gi
      JOIN users creator ON gi.created_by_id = creator.id
      JOIN users target ON gi.for_user_id = target.id
      WHERE gi.group_id = $1
    `;
    const queryParams: any[] = [groupId];

    // Filter logic:
    // 1. If for_user_id is specified, show ideas for that user
    // 2. Otherwise, if user has assignment, show ideas for assigned person
    // 3. Also always show ideas created by the current user
    if (forUserId) {
      query += ' AND gi.for_user_id = $2';
      queryParams.push(forUserId);
    } else if (assignedToUserId) {
      // Show ideas for assigned person OR ideas created by current user
      query += ' AND (gi.for_user_id = $2 OR gi.created_by_id = $3)';
      queryParams.push(assignedToUserId, userId);
    } else {
      // No assignment, show ideas created by current user or for current user
      query += ' AND (gi.created_by_id = $2 OR gi.for_user_id = $2)';
      queryParams.push(userId);
    }

    query += ' ORDER BY gi.created_at DESC';

    const result = await pool.query(query, queryParams);

    // Map results
    const giftIdeas = result.rows.map((row: any) => ({
      id: row.id,
      group_id: row.group_id,
      for_user_id: row.for_user_id,
      created_by_id: row.created_by_id,
      idea: row.idea,
      link: row.link,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: {
        id: row.created_by_id,
        username: row.creator_username,
        display_name: row.creator_display_name || row.creator_username,
      },
      for_user: {
        id: row.for_user_id,
        username: row.target_username,
        display_name: row.target_display_name || row.target_username,
      },
    }));

    res.json({ gift_ideas: giftIdeas });
  } catch (error: any) {
    console.error('Error fetching gift ideas:', error);
    res.status(500).json({ error: 'Failed to fetch gift ideas' });
  }
});

// Update gift idea
router.put('/:id/gift-ideas/:ideaId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const ideaId = parseInt(req.params.ideaId);
    const { idea, link } = req.body;

    if (isNaN(groupId) || isNaN(ideaId)) {
      return res.status(400).json({ error: 'Invalid group ID or idea ID' });
    }

    if (!idea || idea.trim().length === 0) {
      return res.status(400).json({ error: 'Idea is required' });
    }

    // Check if gift idea exists and user is the creator
    const ideaCheck = await pool.query(
      'SELECT id, created_by_id FROM gift_ideas WHERE id = $1 AND group_id = $2',
      [ideaId, groupId]
    );

    if (ideaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Gift idea not found' });
    }

    if (ideaCheck.rows[0].created_by_id !== userId) {
      return res.status(403).json({ error: 'Only the creator can update this gift idea' });
    }

    // Update gift idea
    const result = await pool.query(
      `UPDATE gift_ideas 
       SET idea = $1, link = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, group_id, for_user_id, created_by_id, idea, link, created_at, updated_at`,
      [idea.trim(), link?.trim() || null, ideaId]
    );

    // Get creator and target user info
    const creatorResult = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [userId]
    );
    const targetResult = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [result.rows[0].for_user_id]
    );

    const giftIdea = result.rows[0];
    const creator = creatorResult.rows[0];
    const target = targetResult.rows[0];

    res.json({
      gift_idea: {
        ...giftIdea,
        created_by: {
          id: creator.id,
          username: creator.username,
          display_name: creator.display_name || creator.username,
        },
        for_user: {
          id: target.id,
          username: target.username,
          display_name: target.display_name || target.username,
        },
      },
    });
  } catch (error: any) {
    console.error('Error updating gift idea:', error);
    res.status(500).json({ error: 'Failed to update gift idea' });
  }
});

// Delete gift idea
router.delete('/:id/gift-ideas/:ideaId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const ideaId = parseInt(req.params.ideaId);

    if (isNaN(groupId) || isNaN(ideaId)) {
      return res.status(400).json({ error: 'Invalid group ID or idea ID' });
    }

    // Check if gift idea exists and user is the creator
    const ideaCheck = await pool.query(
      'SELECT id, created_by_id FROM gift_ideas WHERE id = $1 AND group_id = $2',
      [ideaId, groupId]
    );

    if (ideaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Gift idea not found' });
    }

    if (ideaCheck.rows[0].created_by_id !== userId) {
      return res.status(403).json({ error: 'Only the creator can delete this gift idea' });
    }

    // Delete gift idea
    await pool.query('DELETE FROM gift_ideas WHERE id = $1', [ideaId]);

    res.json({ message: 'Gift idea deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting gift idea:', error);
    res.status(500).json({ error: 'Failed to delete gift idea' });
  }
});

// Get exclusions for a group
router.get('/:id/exclusions', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);

    // Check if user is a member of the group
    const memberCheck = await pool.query(
      `SELECT 1 FROM groups WHERE id = $1 AND created_by = $2
       UNION
       SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    // Get exclusions
    const result = await pool.query(
      `SELECT e.id, e.giver_id, e.excluded_user_id,
              giver.username as giver_username, giver.display_name as giver_display_name,
              excluded.username as excluded_username, excluded.display_name as excluded_display_name
       FROM exclusions e
       JOIN users giver ON e.giver_id = giver.id
       JOIN users excluded ON e.excluded_user_id = excluded.id
       WHERE e.group_id = $1
       ORDER BY giver.username, excluded.username`,
      [groupId]
    );

    res.json({ exclusions: result.rows });
  } catch (error: any) {
    console.error('Error fetching exclusions:', error);
    res.status(500).json({ error: 'Failed to fetch exclusions' });
  }
});

// Add an exclusion (owner can set for any member, members can only set for themselves)
router.post('/:id/exclusions', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const { giver_id, excluded_user_id } = req.body;

    if (!excluded_user_id) {
      return res.status(400).json({ error: 'excluded_user_id is required' });
    }

    // Determine who the exclusion is for
    // If giver_id is provided, owner is setting exclusion for that user
    // Otherwise, user is setting exclusion for themselves
    const targetGiverId = giver_id || userId;

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const isOwner = groupCheck.rows[0].created_by === userId;

    // If setting exclusion for someone else, must be owner
    if (targetGiverId !== userId && !isOwner) {
      return res.status(403).json({ error: 'Only group owner can set exclusions for other members' });
    }

    // Check if target giver is a member of the group
    const giverMemberCheck = await pool.query(
      `SELECT 1 FROM groups WHERE id = $1 AND created_by = $2
       UNION
       SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, targetGiverId]
    );

    if (giverMemberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Giver is not a member of this group' });
    }

    // Check if excluded user is a member
    const excludedMemberCheck = await pool.query(
      `SELECT 1 FROM groups WHERE id = $1 AND created_by = $2
       UNION
       SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, excluded_user_id]
    );

    if (excludedMemberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Excluded user is not a member of this group' });
    }

    // Check if trying to exclude self
    if (targetGiverId === excluded_user_id) {
      return res.status(400).json({ error: 'Cannot exclude yourself' });
    }

    // Check if trying to exclude owner
    if (excluded_user_id === groupCheck.rows[0].created_by) {
      return res.status(400).json({ error: 'Cannot exclude the group owner' });
    }

    // Insert bidirectional exclusion (both directions)
    // If A excludes B, then B also excludes A (they won't be assigned to each other)
    try {
      await pool.query('BEGIN');
      
      // Insert exclusion A -> B
      await pool.query(
        'INSERT INTO exclusions (group_id, giver_id, excluded_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [groupId, targetGiverId, excluded_user_id]
      );
      
      // Insert reverse exclusion B -> A
      await pool.query(
        'INSERT INTO exclusions (group_id, giver_id, excluded_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [groupId, excluded_user_id, targetGiverId]
      );
      
      await pool.query('COMMIT');
      res.json({ message: 'Exclusion pair added successfully' });
    } catch (error: any) {
      await pool.query('ROLLBACK');
      if (error.code === '23505') {
        // Unique constraint violation
        res.status(400).json({ error: 'This exclusion pair already exists' });
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    console.error('Error adding exclusion:', error);
    res.status(500).json({ error: 'Failed to add exclusion' });
  }
});

// Remove an exclusion (owner can remove any, members can only remove their own)
router.delete('/:id/exclusions/:exclusionId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const groupId = parseInt(req.params.id);
    const exclusionId = parseInt(req.params.exclusionId);

    // Check if user is owner
    const groupCheck = await pool.query(
      'SELECT created_by FROM groups WHERE id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const isOwner = groupCheck.rows[0].created_by === userId;

    // Check if exclusion exists
    const exclusionCheck = await pool.query(
      'SELECT giver_id FROM exclusions WHERE id = $1 AND group_id = $2',
      [exclusionId, groupId]
    );

    if (exclusionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Exclusion not found' });
    }

    // Only owner can remove exclusions for others
    if (exclusionCheck.rows[0].giver_id !== userId && !isOwner) {
      return res.status(403).json({ error: 'You can only remove your own exclusions' });
    }

    // Delete bidirectional exclusion (both directions)
    // Find the pair and delete both
    const exclusionData = exclusionCheck.rows[0];
    const giverId = exclusionData.giver_id;
    
    // Get excluded_user_id from the exclusion
    const exclusionDetails = await pool.query(
      'SELECT excluded_user_id FROM exclusions WHERE id = $1',
      [exclusionId]
    );
    
    if (exclusionDetails.rows.length === 0) {
      return res.status(404).json({ error: 'Exclusion not found' });
    }
    
    const excludedUserId = exclusionDetails.rows[0].excluded_user_id;
    
    // Find the reverse exclusion
    const reverseExclusion = await pool.query(
      'SELECT id FROM exclusions WHERE group_id = $1 AND giver_id = $2 AND excluded_user_id = $3',
      [groupId, excludedUserId, giverId]
    );
    
    await pool.query('BEGIN');
    
    // Delete the exclusion
    await pool.query('DELETE FROM exclusions WHERE id = $1', [exclusionId]);
    
    // Delete the reverse if it exists
    if (reverseExclusion.rows.length > 0) {
      await pool.query('DELETE FROM exclusions WHERE id = $1', [reverseExclusion.rows[0].id]);
    }
    
    await pool.query('COMMIT');

    res.json({ message: 'Exclusion pair removed successfully' });
  } catch (error: any) {
    console.error('Error removing exclusion:', error);
    res.status(500).json({ error: 'Failed to remove exclusion' });
  }
});

export default router;

