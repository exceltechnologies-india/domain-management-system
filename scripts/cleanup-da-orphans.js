const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Load env
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const DA_URL = process.env.DIRECTADMIN_URL;
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER;
const API_KEY = process.env.DIRECTADMIN_API_KEY;

const auth = {
  username: ADMIN_USER,
  password: API_KEY
};

async function deleteUser(username) {
  const payload = new URLSearchParams({
    action: 'delete',
    confirmed: 'Confirm',
    delete: 'yes',
    select0: username
  });

  try {
    const response = await axios.post(
      `${DA_URL}/CMD_API_SELECT_USERS`,
      payload.toString(),
      {
        auth,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );
    return response.data;
  } catch (error) {
    throw new Error(`Deletion of ${username} failed: ${error.message}`);
  }
}

async function run() {
  const orphans = ['ttgr6jne', 'ttgrgm6jme', 'u18wyi3c', 'u16wyi3c'];
  console.log('--- DirectAdmin Orphan Cleanup ---');

  for (const user of orphans) {
    console.log(`\nProcessing: ${user}`);
    try {
      const result = await deleteUser(user);
      console.log(`Result for ${user}:`, result);
    } catch (err) {
      console.log(`Skipped ${user}: ${err.message}`);
    }
  }

  // Verify current user count
  console.log('\nVerifying current users...');
  try {
    const usersRes = await axios.get(`${DA_URL}/CMD_API_SHOW_USERS`, { auth, timeout: 5000 });
    console.log('Current Users:', usersRes.data);
  } catch (err) {
    console.error('Final check failed:', err.message);
  }

  process.exit(0);
}

run();
