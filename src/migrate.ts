import pool from './db';

async function migrate() {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add display_name column if it doesn't exist (for existing databases)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'display_name'
        ) THEN
          ALTER TABLE users ADD COLUMN display_name VARCHAR(100);
        END IF;
      END $$;
    `);

    // Add image_url column if it doesn't exist (for existing databases)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'image_url'
        ) THEN
          ALTER TABLE users ADD COLUMN image_url TEXT;
        END IF;
      END $$;
    `);

    // Create groups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        image_url TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add image_url column if it doesn't exist (for existing databases)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'groups' AND column_name = 'image_url'
        ) THEN
          ALTER TABLE groups ADD COLUMN image_url TEXT;
        END IF;
      END $$;
    `);

    // Create group_members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_id)
      )
    `);

    // Create invitations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, invitee_id)
      )
    `);

    // Create assignments table for Secret Santa
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assignments (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        giver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, giver_id)
      )
    `);

    // Create device_tokens table for push notifications
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL,
        platform VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, token)
      )
    `);

    // Create gift_ideas table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gift_ideas (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        for_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idea TEXT NOT NULL,
        link TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add link column if it doesn't exist (for existing databases)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'gift_ideas' AND column_name = 'link'
        ) THEN
          ALTER TABLE gift_ideas ADD COLUMN link TEXT;
        END IF;
      END $$;
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_groups_created_by ON groups(created_by)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_invitations_group_id ON invitations(group_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_invitations_invitee_id ON invitations(invitee_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assignments_group_id ON assignments(group_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assignments_giver_id ON assignments(giver_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assignments_receiver_id ON assignments(receiver_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_ideas_group_id ON gift_ideas(group_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_ideas_for_user_id ON gift_ideas(for_user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_ideas_created_by_id ON gift_ideas(created_by_id)
    `);

    console.log('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();

