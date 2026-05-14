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

async function getLicense() {
  console.log('--- DirectAdmin License Info ---');
  try {
    const response = await axios.get(`${DA_URL}/CMD_API_LICENSE`, { auth, timeout: 5000 });
    console.log('License Data:', response.data);
    
    // Also check CMD_API_SYSTEM_INFO for account counts
    console.log('\n--- System Info ---');
    const sysResponse = await axios.get(`${DA_URL}/CMD_API_SYSTEM_INFO`, { auth, timeout: 5000 });
    console.log('System Data:', sysResponse.data);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

getLicense();
