/**
 * Roles and User-Roles Management Routes
 * Endpoints for managing roles and assigning roles to users
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

// ============================================================
// ROLES ENDPOINTS
// ============================================================

/**
 * @swagger
 * tags:
 *   - name: Roles
 *     description: Role management endpoints
 */

/**
 * @swagger
 * /api/roles:
 *   get:
 *     summary: Get all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 */
router.get('/', offlineAuthMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name
      FROM roles
      ORDER BY name
    `);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching roles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch roles'
    });
  }
});

/**
 * @swagger
 * /api/roles/{id}:
 *   get:
 *     summary: Get a role by ID
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Role details
 *       404:
 *         description: Role not found
 */
router.get('/:id', offlineAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT id, name
      FROM roles
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Role not found'
      });
    }

    // Get users with this role
    const usersResult = await db.query(`
      SELECT u.id, u.username, u.full_name
      FROM users u
      JOIN user_roles ur ON u.id = ur.user_id
      WHERE ur.role_id = $1
      ORDER BY u.username
    `, [id]);

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        users: usersResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch role'
    });
  }
});

/**
 * @swagger
 * /api/roles:
 *   post:
 *     summary: Create a new role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Role name (e.g., admin, manager, attendant)
 *     responses:
 *       201:
 *         description: Role created successfully
 *       400:
 *         description: Role already exists or invalid input
 */
router.post('/', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Role name is required'
      });
    }

    const roleName = name.trim().toLowerCase();

    // Check if role already exists
    const existingRole = await db.query(`
      SELECT id FROM roles WHERE LOWER(name) = $1
    `, [roleName]);

    if (existingRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Role already exists'
      });
    }

    const result = await db.query(`
      INSERT INTO roles (name)
      VALUES ($1)
      RETURNING id, name
    `, [roleName]);

    res.status(201).json({
      success: true,
      message: 'Role created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create role'
    });
  }
});

/**
 * @swagger
 * /api/roles/{id}:
 *   put:
 *     summary: Update a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Role updated successfully
 *       404:
 *         description: Role not found
 */
router.put('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Role name is required'
      });
    }

    const roleName = name.trim().toLowerCase();

    // Check if role exists
    const existingRole = await db.query('SELECT id FROM roles WHERE id = $1', [id]);
    if (existingRole.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Role not found'
      });
    }

    // Check if new name conflicts with another role
    const conflictRole = await db.query(`
      SELECT id FROM roles WHERE LOWER(name) = $1 AND id != $2
    `, [roleName, id]);

    if (conflictRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Role name already exists'
      });
    }

    const result = await db.query(`
      UPDATE roles
      SET name = $1
      WHERE id = $2
      RETURNING id, name
    `, [roleName, id]);

    res.json({
      success: true,
      message: 'Role updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update role'
    });
  }
});

/**
 * @swagger
 * /api/roles/{id}:
 *   delete:
 *     summary: Delete a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Role deleted successfully
 *       400:
 *         description: Cannot delete role that is assigned to users
 *       404:
 *         description: Role not found
 */
router.delete('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if role exists
    const existingRole = await db.query('SELECT id, name FROM roles WHERE id = $1', [id]);
    if (existingRole.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Role not found'
      });
    }

    // Check if role is assigned to any users
    const assignedUsers = await db.query(`
      SELECT COUNT(*) as count FROM user_roles WHERE role_id = $1
    `, [id]);

    if (parseInt(assignedUsers.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete role. It is assigned to ${assignedUsers.rows[0].count} user(s). Remove assignments first.`
      });
    }

    await db.query('DELETE FROM roles WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete role'
    });
  }
});

// ============================================================
// USER-ROLES ENDPOINTS
// ============================================================

/**
 * @swagger
 * tags:
 *   - name: UserRoles
 *     description: User role assignment endpoints
 */

/**
 * @swagger
 * /api/roles/users/{userId}/roles:
 *   get:
 *     summary: Get all roles assigned to a user
 *     tags: [UserRoles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of roles assigned to the user
 *       404:
 *         description: User not found
 */
router.get('/users/:userId/roles', offlineAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user exists
    const userResult = await db.query(`
      SELECT id, username, full_name FROM users WHERE id = $1
    `, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user's roles
    const rolesResult = await db.query(`
      SELECT r.id, r.name
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.name
    `, [userId]);

    res.json({
      success: true,
      data: {
        user: userResult.rows[0],
        roles: rolesResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching user roles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user roles'
    });
  }
});

/**
 * @swagger
 * /api/roles/users/{userId}/roles:
 *   post:
 *     summary: Assign a role to a user
 *     tags: [UserRoles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role_id
 *             properties:
 *               role_id:
 *                 type: string
 *                 format: uuid
 *                 description: The ID of the role to assign
 *     responses:
 *       201:
 *         description: Role assigned successfully
 *       400:
 *         description: Role already assigned or invalid input
 *       404:
 *         description: User or role not found
 */
router.post('/users/:userId/roles', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role_id } = req.body;

    if (!role_id) {
      return res.status(400).json({
        success: false,
        error: 'role_id is required'
      });
    }

    // Check if user exists
    const userResult = await db.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if role exists
    const roleResult = await db.query('SELECT id, name FROM roles WHERE id = $1', [role_id]);
    if (roleResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Role not found'
      });
    }

    // Check if already assigned
    const existingAssignment = await db.query(`
      SELECT * FROM user_roles WHERE user_id = $1 AND role_id = $2
    `, [userId, role_id]);

    if (existingAssignment.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Role is already assigned to this user'
      });
    }

    // Assign role
    await db.query(`
      INSERT INTO user_roles (user_id, role_id)
      VALUES ($1, $2)
    `, [userId, role_id]);

    res.status(201).json({
      success: true,
      message: `Role '${roleResult.rows[0].name}' assigned to user '${userResult.rows[0].username}'`
    });
  } catch (error) {
    console.error('Error assigning role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to assign role'
    });
  }
});

/**
 * @swagger
 * /api/roles/users/{userId}/roles/{roleId}:
 *   delete:
 *     summary: Remove a role from a user
 *     tags: [UserRoles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Role removed successfully
 *       404:
 *         description: User, role, or assignment not found
 */
router.delete('/users/:userId/roles/:roleId', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { userId, roleId } = req.params;

    // Check if assignment exists
    const existingAssignment = await db.query(`
      SELECT ur.*, r.name as role_name, u.username
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      JOIN users u ON ur.user_id = u.id
      WHERE ur.user_id = $1 AND ur.role_id = $2
    `, [userId, roleId]);

    if (existingAssignment.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Role assignment not found'
      });
    }

    const assignment = existingAssignment.rows[0];

    // Remove role assignment
    await db.query(`
      DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2
    `, [userId, roleId]);

    res.json({
      success: true,
      message: `Role '${assignment.role_name}' removed from user '${assignment.username}'`
    });
  } catch (error) {
    console.error('Error removing role:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove role'
    });
  }
});

/**
 * @swagger
 * /api/roles/users/{userId}/roles:
 *   put:
 *     summary: Replace all roles for a user (bulk assignment)
 *     tags: [UserRoles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role_ids
 *             properties:
 *               role_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Array of role IDs to assign (replaces existing roles)
 *     responses:
 *       200:
 *         description: Roles updated successfully
 *       404:
 *         description: User not found
 */
router.put('/users/:userId/roles', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role_ids } = req.body;

    if (!Array.isArray(role_ids)) {
      return res.status(400).json({
        success: false,
        error: 'role_ids must be an array'
      });
    }

    // Check if user exists
    const userResult = await db.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Validate all role IDs exist
    if (role_ids.length > 0) {
      const rolesResult = await db.query(`
        SELECT id FROM roles WHERE id = ANY($1)
      `, [role_ids]);

      if (rolesResult.rows.length !== role_ids.length) {
        return res.status(400).json({
          success: false,
          error: 'One or more role IDs are invalid'
        });
      }
    }

    // Remove all existing roles
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);

    // Assign new roles
    for (const roleId of role_ids) {
      await db.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ($1, $2)
      `, [userId, roleId]);
    }

    // Get updated roles
    const updatedRoles = await db.query(`
      SELECT r.id, r.name
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.name
    `, [userId]);

    res.json({
      success: true,
      message: 'User roles updated successfully',
      data: {
        user_id: userId,
        roles: updatedRoles.rows
      }
    });
  } catch (error) {
    console.error('Error updating user roles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user roles'
    });
  }
});

module.exports = router;
