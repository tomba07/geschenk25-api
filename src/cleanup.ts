import pool from './db';

async function cleanup() {
  try {
    console.log('Starting cleanup...');

    // Delete all assignments
    const assignmentsResult = await pool.query('DELETE FROM assignments');
    console.log(`Deleted ${assignmentsResult.rowCount} assignment(s)`);

    // Delete all invitations
    const invitationsResult = await pool.query('DELETE FROM invitations');
    console.log(`Deleted ${invitationsResult.rowCount} invitation(s)`);

    // Delete all group members
    const groupMembersResult = await pool.query('DELETE FROM group_members');
    console.log(`Deleted ${groupMembersResult.rowCount} group member(s)`);

    // Delete all groups
    const groupsResult = await pool.query('DELETE FROM groups');
    console.log(`Deleted ${groupsResult.rowCount} group(s)`);

    // Note: device_tokens are kept (user-related, not group-related)

    console.log('Cleanup completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }
}

cleanup();

