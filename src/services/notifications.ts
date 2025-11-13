import { Expo } from 'expo-server-sdk';
import pool from '../db';

const expo = new Expo();

export async function sendInvitationNotification(
  inviteeId: number,
  inviterDisplayName: string,
  groupName: string
) {
  try {
    // Get all device tokens for the invitee
    const tokensResult = await pool.query(
      'SELECT token FROM device_tokens WHERE user_id = $1',
      [inviteeId]
    );

    if (tokensResult.rows.length === 0) {
      console.log(`No device tokens found for user ${inviteeId}`);
      return;
    }

    const tokens = tokensResult.rows.map((row: any) => row.token).filter(Expo.isExpoPushToken);

    if (tokens.length === 0) {
      console.log(`No valid Expo push tokens found for user ${inviteeId}`);
      return;
    }

    // Create the notification messages
    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: 'New Group Invitation',
      body: `${inviterDisplayName} invited you to join "${groupName}"`,
      data: { type: 'invitation', groupName },
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

