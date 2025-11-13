import { Expo } from 'expo-server-sdk';
import pool from '../db';

const expo = new Expo();

export async function sendInvitationNotification(
  inviteeId: number,
  inviterDisplayName: string,
  groupName: string,
  groupId: number,
  invitationId: number,
  inviterId: number
) {
  try {
    // Safety check: ensure inviteeId != inviterId
    if (inviteeId === inviterId) {
      console.log(`Skipping notification: inviteeId (${inviteeId}) equals inviterId (${inviterId})`);
      return;
    }

    // Get all device tokens for the invitee, but exclude tokens that are also registered for the inviter
    // This prevents the inviter from receiving notifications when they share a device with the invitee
    const tokensResult = await pool.query(
      `SELECT dt.token, dt.user_id 
       FROM device_tokens dt
       WHERE dt.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM device_tokens dt2 
         WHERE dt2.token = dt.token AND dt2.user_id = $2
       )`,
      [inviteeId, inviterId]
    );

    if (tokensResult.rows.length === 0) {
      console.log(`No device tokens found for invitee user ${inviteeId} (excluding tokens shared with inviter ${inviterId})`);
      return;
    }

    // Filter to valid Expo push tokens
    const tokens = tokensResult.rows
      .map((row: any) => row.token)
      .filter(Expo.isExpoPushToken);

    if (tokens.length === 0) {
      console.log(`No valid Expo push tokens found for invitee user ${inviteeId}`);
      return;
    }

    // Log for debugging
    console.log(`Sending invitation notification to invitee ${inviteeId} (inviter: ${inviterId}), ${tokens.length} token(s)`);

    // Create the notification messages
    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: 'New Group Invitation',
      body: `${inviterDisplayName} invited you to join "${groupName}"`,
      data: { type: 'invitation', groupName, groupId, invitationId },
    }));

    // Send notifications in chunks
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }

    console.log(`Sent ${tickets.length} push notifications for invitation`);
  } catch (error) {
    console.error('Error sending invitation notification:', error);
  }
}

export async function sendAssignmentNotification(
  userIds: number[],
  groupName: string,
  groupId: number
) {
  try {
    if (userIds.length === 0) {
      return;
    }

    // Get all device tokens for all users
    const tokensResult = await pool.query(
      'SELECT DISTINCT user_id, token FROM device_tokens WHERE user_id = ANY($1)',
      [userIds]
    );

    if (tokensResult.rows.length === 0) {
      console.log(`No device tokens found for users: ${userIds.join(', ')}`);
      return;
    }

    const tokens = tokensResult.rows
      .map((row: any) => row.token)
      .filter(Expo.isExpoPushToken);

    if (tokens.length === 0) {
      console.log(`No valid Expo push tokens found for users: ${userIds.join(', ')}`);
      return;
    }

    // Create the notification messages
    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: 'Secret Santa Assignments Ready!',
      body: `Assignments have been created for "${groupName}"`,
      data: { type: 'assignment', groupName, groupId },
    }));

    // Send notifications in chunks
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }

    console.log(`Sent ${tickets.length} push notifications for assignments`);
  } catch (error) {
    console.error('Error sending assignment notification:', error);
  }
}

