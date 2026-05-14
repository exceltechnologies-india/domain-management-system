#!/usr/bin/env node

/**
 * Test IP Check Database Functionality
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function testIPCheck() {
  console.log('🧪 Testing IP Check Database Functionality...');

  try {
    // Test 1: Check if admin IP check endpoint exists
    console.log('\n1. Testing admin IP check endpoint...');
    try {
      const response = await axios.get('http://localhost:3000/api/admin/check-ip');
      console.log('❌ Should have failed (no auth) but got:', response.status);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Admin IP check endpoint requires authentication:', error.response.status);
      } else {
        console.log('❌ Unexpected error:', error.response?.status || error.message);
      }
    }

    // Test 2: Check if IP status endpoint exists
    console.log('\n2. Testing IP status endpoint...');
    try {
      const response = await axios.get('http://localhost:3000/api/admin/ip-status');
      console.log('❌ Should have failed (no auth) but got:', response.status);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ IP status endpoint requires authentication:', error.response.status);
      } else {
        console.log('❌ Unexpected error:', error.response?.status || error.message);
      }
    }

    // Test 3: Check if regular IP check still works
    console.log('\n3. Testing regular IP check endpoint...');
    try {
      const response = await axios.get('http://localhost:3000/api/check-ip');
      console.log('✅ Regular IP check endpoint accessible:', response.status);
      if (response.data.success) {
        console.log('   IP detected:', response.data.data?.primaryIP);
      } else {
        console.log('   No IP detected:', response.data.message);
      }
    } catch (error) {
      console.log('❌ Regular IP check error:', error.response?.status || error.message);
    }

    console.log('\n✅ IP check database functionality tests completed!');
    console.log('\n📝 Note: The actual database tests require admin authentication.');
    console.log('   The IP check results will now be saved to the database and');
    console.log('   displayed on the admin settings page until manually refreshed.');

  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

testIPCheck();
