import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, createUser, findUserByEmail, findUserByGoogleId, updateUserSubscription } from '../db.js';

describe('Authentication Database Operations', () => {
  // Note: These tests require a MySQL database to be available
  // Skip tests if database is not configured
  let dbAvailable = false;

  beforeEach(async () => {
    try {
      await initDatabase();
      dbAvailable = true;
      
      // Clean up test users before each test - using specific test email pattern
      const { getPool } = await import('../db.js');
      const pool = getPool();
      // Only delete test emails that match our test pattern exactly
      await pool.query(
        'DELETE FROM users WHERE email IN (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'test1@example.com', 'test2@example.com', 'test3@example.com',
          'test4@example.com', 'test5@example.com', 'test6@example.com',
          'test7@example.com', 'test_new@example.com', 'test_existing@example.com'
        ]
      );
    } catch (error) {
      console.log('Database not available for testing:', error.message);
      dbAvailable = false;
    }
  });

  afterEach(async () => {
    if (dbAvailable) {
      // Clean up test users after each test - using specific test email pattern
      const { getPool } = await import('../db.js');
      const pool = getPool();
      // Only delete test emails that match our test pattern exactly
      await pool.query(
        'DELETE FROM users WHERE email IN (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'test1@example.com', 'test2@example.com', 'test3@example.com',
          'test4@example.com', 'test5@example.com', 'test6@example.com',
          'test7@example.com', 'test_new@example.com', 'test_existing@example.com'
        ]
      );
    }
  });

  describe('createUser', () => {
    it('should create a user and return complete user record', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test1@example.com',
        google_id: 'google_test_123',
        name: 'Test User',
        has_subscription: false
      };

      const user = await createUser(userData);

      // Verify user object has all required fields
      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toBe(userData.email);
      expect(user.google_id).toBe(userData.google_id);
      expect(user.name).toBe(userData.name);
      expect(user.has_subscription).toBe(false);
      expect(user.created_at).toBeDefined();
      expect(user.updated_at).toBeDefined();
    });

    it('should create user with default has_subscription=false when not provided', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test2@example.com',
        google_id: 'google_test_456',
        name: 'Test User 2'
      };

      const user = await createUser(userData);

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.has_subscription).toBe(false);
    });

    it('should throw error when creating duplicate email', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test3@example.com',
        google_id: 'google_test_789',
        name: 'Test User 3',
        has_subscription: false
      };

      await createUser(userData);

      // Try to create another user with same email
      const duplicateData = {
        email: 'test3@example.com',
        google_id: 'google_test_999',
        name: 'Duplicate User',
        has_subscription: false
      };

      await expect(createUser(duplicateData)).rejects.toThrow();
    });
  });

  describe('findUserByEmail', () => {
    it('should find user by email', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test4@example.com',
        google_id: 'google_test_111',
        name: 'Test User 4',
        has_subscription: false
      };

      const createdUser = await createUser(userData);
      const foundUser = await findUserByEmail(userData.email);

      expect(foundUser).toBeDefined();
      expect(foundUser.id).toBe(createdUser.id);
      expect(foundUser.email).toBe(userData.email);
    });

    it('should return null for non-existent email', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const user = await findUserByEmail('nonexistent@example.com');
      expect(user).toBeNull();
    });
  });

  describe('findUserByGoogleId', () => {
    it('should find user by Google ID', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test5@example.com',
        google_id: 'google_test_222',
        name: 'Test User 5',
        has_subscription: false
      };

      const createdUser = await createUser(userData);
      const foundUser = await findUserByGoogleId(userData.google_id);

      expect(foundUser).toBeDefined();
      expect(foundUser.id).toBe(createdUser.id);
      expect(foundUser.google_id).toBe(userData.google_id);
    });

    it('should return null for non-existent Google ID', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const user = await findUserByGoogleId('nonexistent_google_id');
      expect(user).toBeNull();
    });
  });

  describe('updateUserSubscription', () => {
    it('should update user subscription status', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test6@example.com',
        google_id: 'google_test_333',
        name: 'Test User 6',
        has_subscription: false
      };

      await createUser(userData);
      await updateUserSubscription(userData.email, true, 'sub_123456');

      const updatedUser = await findUserByEmail(userData.email);
      expect(updatedUser.has_subscription).toBe(true);
      expect(updatedUser.subscription_id).toBe('sub_123456');
    });

    it('should remove subscription when set to false', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const userData = {
        email: 'test7@example.com',
        google_id: 'google_test_444',
        name: 'Test User 7',
        has_subscription: true
      };

      await createUser(userData);
      await updateUserSubscription(userData.email, false, null);

      const updatedUser = await findUserByEmail(userData.email);
      expect(updatedUser.has_subscription).toBe(false);
      expect(updatedUser.subscription_id).toBeNull();
    });
  });

  describe('Google OAuth Flow Simulation', () => {
    it('should handle first-time user authentication', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      const googleProfile = {
        id: 'google_new_user_123',
        emails: [{ value: 'test_new@example.com' }],
        displayName: 'New Test User'
      };

      // Simulate OAuth flow
      let user = await findUserByGoogleId(googleProfile.id);
      expect(user).toBeNull();

      const email = googleProfile.emails[0].value;
      user = await findUserByEmail(email);
      expect(user).toBeNull();

      // Create new user
      user = await createUser({
        email: email,
        google_id: googleProfile.id,
        name: googleProfile.displayName,
        has_subscription: false
      });

      // Verify user was created with valid ID
      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.id).toBeGreaterThan(0);
      expect(user.email).toBe(email);
      expect(user.google_id).toBe(googleProfile.id);
      expect(user.has_subscription).toBe(false);
    });

    it('should handle returning user authentication', async () => {
      if (!dbAvailable) {
        console.log('Skipping test - database not available');
        return;
      }

      // Create existing user
      const existingUser = await createUser({
        email: 'test_existing@example.com',
        google_id: 'google_existing_123',
        name: 'Existing User',
        has_subscription: true
      });

      const googleProfile = {
        id: 'google_existing_123',
        emails: [{ value: 'test_existing@example.com' }],
        displayName: 'Existing User'
      };

      // Simulate OAuth flow for returning user
      const user = await findUserByGoogleId(googleProfile.id);
      
      expect(user).toBeDefined();
      expect(user.id).toBe(existingUser.id);
      expect(user.email).toBe(existingUser.email);
      expect(user.has_subscription).toBe(true);
    });
  });
});
