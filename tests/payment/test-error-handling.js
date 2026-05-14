#!/usr/bin/env node

/**
 * Test Error Handling for Payment Failures
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function testErrorHandling() {
  console.log('🧪 Testing Payment Error Handling...');

  try {
    // Test 1: Invalid payment verification data
    console.log('\n1. Testing invalid payment verification...');
    try {
      const response = await axios.post('http://localhost:3000/api/payments/verify', {
        razorpay_order_id: 'invalid',
        razorpay_payment_id: 'invalid',
        razorpay_signature: 'invalid',
        cartItems: []
      });
      console.log('❌ Should have failed but got:', response.status);
    } catch (error) {
      if (error.response) {
        console.log('✅ Correctly handled invalid data:', error.response.status, error.response.data.error);
      } else {
        console.log('❌ Unexpected error:', error.message);
      }
    }

    // Test 2: Missing required fields
    console.log('\n2. Testing missing required fields...');
    try {
      const response = await axios.post('http://localhost:3000/api/payments/verify', {
        // Missing all required fields
      });
      console.log('❌ Should have failed but got:', response.status);
    } catch (error) {
      if (error.response) {
        console.log('✅ Correctly handled missing fields:', error.response.status, error.response.data.error);
      } else {
        console.log('❌ Unexpected error:', error.message);
      }
    }

    // Test 3: Unauthorized request
    console.log('\n3. Testing unauthorized request...');
    try {
      const response = await axios.post('http://localhost:3000/api/payments/verify', {
        razorpay_order_id: 'test',
        razorpay_payment_id: 'test',
        razorpay_signature: 'test',
        cartItems: [{ domainName: 'test.com', price: 100, currency: 'INR' }]
      });
      console.log('❌ Should have failed but got:', response.status);
    } catch (error) {
      if (error.response) {
        console.log('✅ Correctly handled unauthorized:', error.response.status, error.response.data.error);
      } else {
        console.log('❌ Unexpected error:', error.message);
      }
    }

    console.log('\n✅ Error handling tests completed!');

  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

testErrorHandling();
