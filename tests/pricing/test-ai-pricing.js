#!/usr/bin/env node

/**
 * Test AI TLD Pricing
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function testAIPricing() {
  console.log('🧪 Testing .ai TLD pricing...');

  try {
    const api = axios.create({
      baseURL: process.env.RESELLERCLUB_API_URL,
      timeout: 30000,
    });

    api.interceptors.request.use((config) => {
      config.params = {
        ...config.params,
        'auth-userid': process.env.RESELLERCLUB_ID,
        'api-key': process.env.RESELLERCLUB_SECRET,
        'reseller-id': process.env.RESELLERCLUB_ID,
      };
      return config;
    });

    // Test the pricing logic manually
    const response = await api.get('/api/products/customer-price.json');
    const customerData = response.data;

    const tld = 'ai';
    const cleanTld = tld.startsWith('.') ? tld.substring(1) : tld;
    const tldMappings = { ai: 'dotai' };
    const foundTld = tldMappings[cleanTld];

    if (foundTld && customerData[foundTld]) {
      const customerPricing = customerData[foundTld];
      console.log('🔍 Customer pricing data:', JSON.stringify(customerPricing, null, 2));

      let customerPrice = 0;
      let registrationPeriod = 1;

      if (customerPricing.addnewdomain && customerPricing.addnewdomain["1"]) {
        customerPrice = parseFloat(customerPricing.addnewdomain["1"]);
        registrationPeriod = 1;
        console.log('✅ Found 1-year pricing:', customerPrice);
      } else if (customerPricing.addnewdomain && customerPricing.addnewdomain["2"]) {
        customerPrice = parseFloat(customerPricing.addnewdomain["2"]);
        registrationPeriod = 2;
        console.log('✅ Found 2-year pricing:', customerPrice);
      }

      console.log('📊 Final result:');
      console.log(`   Price: ₹${customerPrice}`);
      console.log(`   Registration Period: ${registrationPeriod} years`);
    } else {
      console.log('❌ TLD not found in pricing data');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testAIPricing();
