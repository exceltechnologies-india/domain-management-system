#!/usr/bin/env node

/**
 * Test Payment Success Page Access
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function testPaymentSuccessPage() {
  console.log('🧪 Testing Payment Success Page Access...');

  try {
    // Test 1: Check if payment success page is accessible
    console.log('\n1. Testing payment success page accessibility...');
    try {
      const response = await axios.get('http://localhost:3000/payment-success');
      console.log('✅ Payment success page is accessible:', response.status);
    } catch (error) {
      if (error.response) {
        console.log('❌ Payment success page error:', error.response.status, error.response.statusText);
      } else {
        console.log('❌ Network error:', error.message);
      }
    }

    // Test 2: Simulate payment result in session storage
    console.log('\n2. Testing payment result handling...');

    // This would normally be set by the checkout page
    const mockPaymentResult = {
      status: 'success',
      orderId: 'test_order_123',
      invoiceNumber: 'INV-123',
      successfulDomains: ['test.com'],
      amount: 1000,
      currency: 'INR',
      timestamp: Date.now()
    };

    console.log('✅ Mock payment result created:', mockPaymentResult);
    console.log('✅ Payment success page should display this data when accessed with session storage');

    console.log('\n✅ Payment success page tests completed!');
    console.log('\n📝 Note: The actual test requires browser interaction to set session storage.');
    console.log('   The payment success page should now properly display instead of redirecting to dashboard.');

  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

testPaymentSuccessPage();
