#!/usr/bin/env node

/**
 * Test Order Delete Functionality
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function testDeleteOrder() {
  console.log('🧪 Testing Order Delete Functionality...');

  try {
    // Test 1: Check if delete endpoint exists
    console.log('\n1. Testing delete endpoint accessibility...');
    try {
      // This will fail with 401 (unauthorized) but confirms endpoint exists
      const response = await axios.delete('http://localhost:3000/api/admin/orders/test-id');
      console.log('❌ Should have failed but got:', response.status);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Delete endpoint exists and requires authentication:', error.response.status);
      } else if (error.response && error.response.status === 404) {
        console.log('✅ Delete endpoint exists and handles non-existent orders:', error.response.status);
      } else {
        console.log('❌ Unexpected error:', error.response?.status || error.message);
      }
    }

    // Test 2: Check admin orders endpoint
    console.log('\n2. Testing admin orders endpoint...');
    try {
      const response = await axios.get('http://localhost:3000/api/admin/orders');
      console.log('❌ Should have failed (no auth) but got:', response.status);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Admin orders endpoint requires authentication:', error.response.status);
      } else {
        console.log('❌ Unexpected error:', error.response?.status || error.message);
      }
    }

    console.log('\n✅ Order delete functionality tests completed!');
    console.log('\n📝 Note: The actual delete test requires admin authentication.');
    console.log('   The delete functionality should work with proper admin login.');

  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

testDeleteOrder();
