#!/usr/bin/env node

/**
 * =============================================================================
 * EU TLD PROMOTIONAL PRICING TEST SCRIPT
 * =============================================================================
 * 
 * Purpose: Test the domain search API specifically for .eu TLD promotional
 * pricing to verify that the integration is working correctly end-to-end.
 * 
 * What it tests:
 * - Domain search API endpoint functionality
 * - .eu TLD promotional pricing detection
 * - Promotional price display and metadata
 * - End-to-end promotional pricing workflow
 * 
 * Usage:
 *   node tests/api/test-eu-pricing.js
 * 
 * Prerequisites:
 * - Main application must be running on localhost:3000
 * - .env.local must contain valid ResellerClub API credentials
 * 
 * Expected Output:
 * - Domain search API response with promotional pricing
 * - Promotional price details and metadata
 * - Success confirmation or error details
 * 
 * Dependencies:
 * - axios (HTTP client)
 * - Running Next.js application
 * 
 * Author: ANUTECH DIGITAL PRIVATE LIMITED
 * Created: 2024
 * Last Updated: 2024-10-08
 */

const axios = require('axios');

/**
 * Test EU TLD promotional pricing through the domain search API
 * 
 * This function tests the complete promotional pricing workflow by:
 * 1. Making a domain search request for .eu TLD
 * 2. Verifying the API response structure
 * 3. Checking for promotional pricing data
 * 4. Displaying detailed promotional information
 */
async function testEuPricing() {
  console.log('🔍 Testing .eu TLD Promotional Pricing via Domain Search API');
  console.log('='.repeat(70));
  console.log('');

  try {
    console.log('📡 Making domain search request...');
    console.log('   Domain: anutech');
    console.log('   TLD: eu');
    console.log('   Endpoint: http://localhost:3000/api/domains/search');
    console.log('');

    // Make POST request to domain search API
    const response = await axios.post('http://localhost:3000/api/domains/search', {
      domain: 'anutech',
      tlds: 'eu'
    }, {
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Domain search request successful!');
    console.log(`   Response Status: ${response.status}`);
    console.log(`   Response Time: ${response.data.responseTime || 'Unknown'}`);
    console.log(`   Request ID: ${response.data.requestId || 'Unknown'}`);
    console.log('');

    // Display raw response for debugging
    console.log('📊 Raw API Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('');

    // Analyze domain search results
    if (response.data.domains && response.data.domains.length > 0) {
      const domain = response.data.domains[0];

      console.log('🎯 Domain Search Result Analysis:');
      console.log('='.repeat(40));
      console.log(`   Domain Name: ${domain.domainName}`);
      console.log(`   Available: ${domain.available ? 'Yes' : 'No'}`);
      console.log(`   Price: ₹${domain.price}`);
      console.log(`   Currency: ${domain.currency}`);
      console.log(`   Registration Period: ${domain.registrationPeriod} year(s)`);
      console.log(`   Pricing Source: ${domain.pricingSource}`);
      console.log('');

      // Check promotional pricing details
      if (domain.isPromotional) {
        console.log('🎉 PROMOTIONAL PRICING DETECTED!');
        console.log('='.repeat(35));
        console.log(`   Is Promotional: ${domain.isPromotional}`);
        console.log(`   Original Price: ₹${domain.originalPrice}`);
        console.log(`   Promotional Price: ₹${domain.price}`);

        const savings = domain.originalPrice - domain.price;
        const discountPercent = ((savings / domain.originalPrice) * 100).toFixed(1);
        console.log(`   Savings: ₹${savings.toFixed(2)} (${discountPercent}% off)`);
        console.log('');

        // Display promotional details if available
        if (domain.promotionalDetails) {
          console.log('📋 Promotional Details:');
          console.log(`   Source: ${domain.promotionalDetails.source}`);
          console.log(`   Original Customer Price: ₹${domain.promotionalDetails.originalCustomerPrice}`);
          console.log(`   Promotional Price: ₹${domain.promotionalDetails.promotionalPrice}`);
          console.log(`   Discount: ₹${domain.promotionalDetails.discount}`);

          if (domain.promotionalDetails.startTime && domain.promotionalDetails.endTime) {
            const startTime = new Date(parseInt(domain.promotionalDetails.startTime) * 1000);
            const endTime = new Date(parseInt(domain.promotionalDetails.endTime) * 1000);
            console.log(`   Valid Period: ${startTime.toLocaleDateString()} - ${endTime.toLocaleDateString()}`);
          }

          if (domain.promotionalDetails.actionType) {
            console.log(`   Action Type: ${domain.promotionalDetails.actionType}`);
          }

          if (domain.promotionalDetails.period) {
            console.log(`   Period: ${domain.promotionalDetails.period} year(s)`);
          }
        }
      } else {
        console.log('❌ No promotional pricing detected');
        console.log('   This could mean:');
        console.log('   - No active promotions for .eu TLD');
        console.log('   - Promotional pricing is disabled');
        console.log('   - API integration issue');
      }

      console.log('');
      console.log('📊 Test Summary:');
      console.log(`   Domain: ${domain.domainName}`);
      console.log(`   Promotional: ${domain.isPromotional ? 'Yes' : 'No'}`);
      console.log(`   Price: ₹${domain.price}`);
      if (domain.isPromotional) {
        console.log(`   Original: ₹${domain.originalPrice}`);
        console.log(`   Savings: ₹${(domain.originalPrice - domain.price).toFixed(2)}`);
      }

    } else {
      console.log('❌ No domain results found in response');
      console.log('   This could indicate:');
      console.log('   - Domain search API error');
      console.log('   - Invalid request format');
      console.log('   - Server-side processing issue');
    }

    console.log('');
    console.log('✅ EU TLD promotional pricing test completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('');

    if (error.response) {
      console.error('📊 Error Details:');
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Status Text: ${error.response.statusText}`);
      console.error(`   Response Data:`, error.response.data);
    } else if (error.request) {
      console.error('🌐 Network Error:');
      console.error('   No response received from server');
      console.error('   Possible causes:');
      console.error('   - Server is not running on localhost:3000');
      console.error('   - Network connectivity issues');
      console.error('   - Firewall blocking the request');
    } else {
      console.error('🔧 Configuration Error:');
      console.error('   Error setting up the request');
      console.error('   Check your test configuration');
    }

    console.error('');
    console.error('💡 Troubleshooting Steps:');
    console.error('   1. Ensure the main application is running: npm run dev');
    console.error('   2. Check that the server is accessible at http://localhost:3000');
    console.error('   3. Verify .env.local contains valid ResellerClub API credentials');
    console.error('   4. Check server logs for detailed error information');

    throw error;
  }
}

/**
 * Main execution function
 * 
 * This function runs the EU TLD promotional pricing test and handles
 * any errors that occur during execution.
 */
async function main() {
  try {
    await testEuPricing();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the EU TLD promotional pricing test
main();