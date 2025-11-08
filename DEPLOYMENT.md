# Deployment Guide for Render

## Setup on Render

### 1. Create PostgreSQL Database

1. Go to Render Dashboard
2. Click "New +" → "PostgreSQL"
3. Name it `geschenk25-db`
4. Copy the **Internal Database URL** (you'll use this in the API service)

### 2. Create Web Service

1. Go to Render Dashboard
2. Click "New +" → "Web Service"
3. Connect your GitHub repository (or deploy from a public Git repo)
4. Configure:
   - **Name**: `geschenk25-api`
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Root Directory**: `geschenk25-api` (if your API is in a subdirectory)

### 3. Environment Variables

Add these in the Render dashboard for your Web Service:

- `DATABASE_URL` - The Internal Database URL from your PostgreSQL database
- `JWT_SECRET` - Generate a random string (e.g., use `openssl rand -hex 32`)
- `NODE_ENV` - Set to `production`
- `PORT` - Render will set this automatically, but you can set it to `10000` if needed

### 4. Run Migrations

After deployment, you need to run migrations. You can do this by:

1. SSH into your Render service (if available), or
2. Add a one-time script that runs migrations on first deploy, or
3. Use Render's shell to run: `npm run build && npm run migrate`

Or create a simple migration endpoint (for development only):

```typescript
// src/migrate-endpoint.ts (temporary, remove after migration)
router.post('/migrate', async (req, res) => {
  // Run migrations
  // Remove this endpoint after running migrations!
});
```

### 5. Update React Native App

Update your `.env` file in the React Native app:

```
EXPO_PUBLIC_API_URL=https://your-api-name.onrender.com
```

## Local Development

1. Install dependencies:
```bash
cd geschenk25-api
npm install
```

2. Create `.env` file:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/geschenk25
JWT_SECRET=your-local-secret-key
PORT=3000
NODE_ENV=development
```

3. Run migrations:
```bash
npm run build
npm run migrate
```

4. Start server:
```bash
npm run dev
```

## API Endpoints

- `POST /api/auth/register` - Register new user
  - Body: `{ username: string, password: string }`
  - Returns: `{ token: string, user: { id, username } }`

- `POST /api/auth/login` - Login
  - Body: `{ username: string, password: string }`
  - Returns: `{ token: string, user: { id, username } }`

- `GET /api/auth/me` - Get current user
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ user: { id, username } }`

- `GET /api/groups` - Get user's groups (requires auth)
- `GET /api/groups/:id` - Get single group (requires auth)
- `POST /api/groups` - Create group (requires auth)
  - Body: `{ name: string, description?: string }`
- `DELETE /api/groups/:id` - Delete group (requires auth)

