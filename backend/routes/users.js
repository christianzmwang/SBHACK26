/**
 * Users API Routes
 * 
 * Handles user creation and lookup for authentication
 */

import express from 'express';
import { query } from '../config/database.js';

const router = express.Router();

/**
 * Upsert a user (create if not exists, return if exists)
 * POST /api/users/upsert
 * 
 * Body: { googleId, email, name, image }
 * Returns: { user: { id, google_id, email, name, image } }
 */
router.post('/upsert', async (req, res) => {
  try {
    const { googleId, email, name, image } = req.body;

    if (!googleId || !email) {
      return res.status(400).json({ error: 'googleId and email are required' });
    }

    // Try to find existing user by google_id
    const existingUser = await query(
      'SELECT * FROM users WHERE google_id = $1',
      [googleId]
    );

    if (existingUser.rows.length > 0) {
      // Update user info if changed
      const updatedUser = await query(
        `UPDATE users 
         SET email = COALESCE($2, email),
             name = COALESCE($3, name),
             image = COALESCE($4, image),
             updated_at = NOW()
         WHERE google_id = $1
         RETURNING *`,
        [googleId, email, name, image]
      );

      return res.json({
        success: true,
        user: updatedUser.rows[0],
        created: false
      });
    }

    // Create new user
    const newUser = await query(
      `INSERT INTO users (google_id, email, name, image)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [googleId, email, name, image]
    );

    res.status(201).json({
      success: true,
      user: newUser.rows[0],
      created: true
    });
  } catch (error) {
    console.error('Error upserting user:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user by Google ID
 * GET /api/users/by-google-id/:googleId
 */
router.get('/by-google-id/:googleId', async (req, res) => {
  try {
    const { googleId } = req.params;

    const result = await query(
      'SELECT * FROM users WHERE google_id = $1',
      [googleId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
