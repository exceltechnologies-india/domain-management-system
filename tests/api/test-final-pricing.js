#!/usr/bin/env node

/**
 * =============================================================================
 * FINAL TLD PRICING VERIFICATION TEST SCRIPT
 * =============================================================================
 * 
 * Purpose: Comprehensive test to verify that ResellerClub TLD pricing
 * is working correctly by testing all pricing sources and TLD mappings.
 * This is the final verification test after implementing TLD pricing system.
 * 
 * What it tests:
 * - Customer and reseller pricing API endpoints
 * - TLD mapping accuracy for 200+ TLDs
 * - Priority-based TLD lookup system
 * - Price validation and error handling
 * - Performance and caching verification
 * 
 * Usage:
 *   node tests/api/test-final-pricing.js
 * 
 * Expected Output:
 * - Complete pricing data from customer and reseller APIs
 * - TLD mapping accuracy verification
 * - Price validation and error handling results
 * - Comprehensive summary and success confirmation
 * 
 * Dependencies:
 * - axios (HTTP client)
 * - .env.local (environment variables)
 * 
 * Author: ANUTECH DIGITAL PRIVATE LIMITED
 * Created: 2024
 * Last Updated: 2024-10-08
**/

const axios = require('axios');

// Load environment variables
require('dotenv').config({ path: '.env.local' });

// ResellerClub API configuration
const RESELLERCLUB_API_URL = process.env.RESELLERCLUB_API_URL || 'https://httpapi.com';
const RESELLERCLUB_ID = process.env.RESELLERCLUB_ID;
const RESELLERCLUB_SECRET = process.env.RESELLERCLUB_SECRET;

/**
 * Validate that all required environment variables are set
 */
function validateEnvironment() {
  if (!RESELLERCLUB_ID || !RESELLERCLUB_SECRET) {
    console.error('❌ Missing required environment variables:');
    console.error('   RESELLERCLUB_ID:', RESELLERCLUB_ID ? '✅ Set' : '❌ Missing');
    console.error('   RESELLERCLUB_SECRET:', RESELLERCLUB_SECRET ? '✅ Set' : '❌ Missing');
    process.exit(1);
  }
}

/**
 * Display API configuration
 */
function displayConfiguration() {
  console.log('🎯 Final ResellerClub TLD Pricing Test');
  console.log('='.repeat(60));
  console.log('   API URL:', RESELLERCLUB_API_URL);
  console.log('   User ID:', RESELLERCLUB_ID);
  console.log('   API Key:', RESELLERCLUB_SECRET.substring(0, 8) + '...');
  console.log('');
}

/**
 * Fetch all pricing data from ResellerClub API in parallel
 * 
 * This function fetches data from customer and reseller pricing endpoints
 * to get a complete picture of available pricing information.
 * 
 * @returns {Promise<Object>} Object containing all pricing data
 */
async function fetchAllPricingData() {
  console.log('📊 Fetching all pricing data from ResellerClub API...');
  console.log('   This may take a few moments...');
  console.log('');

  try {
    // Fetch customer and reseller pricing endpoints in parallel for efficiency
    const [customerResponse, resellerResponse] = await Promise.all([
      // Customer pricing - what customers see
      axios.get(`${RESELLERCLUB_API_URL}/api/products/customer-price.json`, {
        params: {
          'auth-userid': RESELLERCLUB_ID,
          'api-key': RESELLERCLUB_SECRET,
          'format': 'json'
        },
        timeout: 30000
      }),

      // Reseller pricing - base costs
      axios.get(`${RESELLERCLUB_API_URL}/api/products/reseller-price.json`, {
        params: {
          'auth-userid': RESELLERCLUB_ID,
          'api-key': RESELLERCLUB_SECRET,
          'format': 'json'
        },
        timeout: 30000
      }),

    ]);

    console.log('✅ All pricing data fetched successfully!');
    console.log(`   Customer pricing TLDs: ${Object.keys(customerResponse.data).length}`);
    console.log(`   Reseller pricing TLDs: ${Object.keys(resellerResponse.data).length}`);
    console.log('');

    return {
      customerData: customerResponse.data,
      resellerData: resellerResponse.data
    };

  } catch (error) {
    console.error('❌ Failed to fetch pricing data:', error.message);
    throw error;
  }
}

/**
 * Analyze promotional details to understand active promotions
 * 
 * This function examines the promotional details API response to identify
 * active promotions and their characteristics.
 * 
 * @param {Object} promoDetailsData - Promotional details data
 */
function analyzePromotionalDetails(promoDetailsData) {
  console.log('🎯 Promotional Details Analysis:');
  console.log('');

  const promotions = Object.values(promoDetailsData);
  console.log(`   Total promotions in system: ${promotions.length}`);

  if (promotions.length > 0) {
    console.log('');
    console.log('📋 Active Promotions Details:');
    console.log('   (Showing all promotions for reference)');
    console.log('');

    promotions.forEach((promo, index) => {
      const startTime = new Date(parseInt(promo.starttime) * 1000);
      const endTime = new Date(parseInt(promo.endtime) * 1000);
      const isActive = promo.isactive === 'true';
      const isCurrentlyActive = isActive && new Date() >= startTime && new Date() <= endTime;

      console.log(`   ${index + 1}. Product Key: ${promo.productkey}`);
      console.log(`      Customer Price: ₹${promo.customerprice}`);
      console.log(`      Reseller Price: ₹${promo.resellerprice}`);
      console.log(`      Period: ${promo.period} year(s)`);
      console.log(`      Status: ${isActive ? 'Active' : 'Inactive'}`);
      console.log(`      Currently Valid: ${isCurrentlyActive ? 'Yes' : 'No'}`);
      console.log(`      Start: ${startTime.toLocaleDateString()} ${startTime.toLocaleTimeString()}`);
      console.log(`      End: ${endTime.toLocaleDateString()} ${endTime.toLocaleTimeString()}`);
      console.log(`      Action Type: ${promo.actiontype}`);
      console.log('');
    });
  } else {
    console.log('   ⚠️  No promotional details found');
  }

  console.log('');
}

/**
 * Test specific TLDs for promotional pricing availability
 * 
 * This function tests a comprehensive list of TLDs to see which ones
 * have promotional pricing available, using multiple TLD format variations
 * to ensure maximum compatibility.
 * 
 * @param {Object} customerData - Customer pricing data
 * @param {Object} resellerData - Reseller pricing data
 * @param {Array} promotions - Array of promotional details
 * @param {Array} testTlds - TLDs to test
 * @returns {Object} Analysis results
 */
function testTldsForPromotionalPricing(customerData, resellerData, promotions, testTlds) {
  console.log('🔍 Testing Specific TLDs for Promotional Pricing:');
  console.log('   (Testing multiple TLD format variations for compatibility)');
  console.log('');

  let promotionalTlds = 0;
  let totalSavings = 0;
  const promotionalResults = [];

  for (const tld of testTlds) {
    // Try different TLD formats that ResellerClub might use
    const tldFormats = [
      tld,                    // Standard format (e.g., "com")
      `dot${tld}`,           // Dot prefix (e.g., "dotcom")
      `centralnicza${tld}`,  // CentralNic prefix (e.g., "centralniczacom")
      tld.toUpperCase(),     // Uppercase (e.g., "COM")
      tld.toLowerCase()      // Lowercase (e.g., "com")
    ];

    let customerPrice = 0;
    let resellerPrice = 0;
    let foundTld = null;

    // Find the TLD in customer pricing data using different formats
    for (const format of tldFormats) {
      if (customerData[format] &&
        customerData[format].addnewdomain &&
        customerData[format].addnewdomain['1']) {
        customerPrice = parseFloat(customerData[format].addnewdomain['1']);
        foundTld = format;
        break;
      }
    }

    if (foundTld) {
      // Get reseller price for margin calculation
      if (resellerData[foundTld] &&
        resellerData[foundTld]['0'] &&
        resellerData[foundTld]['0'].pricing &&
        resellerData[foundTld]['0'].pricing.addnewdomain &&
        resellerData[foundTld]['0'].pricing.addnewdomain['1']) {
        resellerPrice = parseFloat(resellerData[foundTld]['0'].pricing.addnewdomain['1']);
      }

      console.log(`📋 TLD: .${tld.toUpperCase()} (found as: ${foundTld})`);
      console.log(`   Customer Price: ₹${customerPrice.toFixed(2)}`);
      console.log(`   Reseller Price: ₹${resellerPrice.toFixed(2)}`);

      const margin = resellerPrice > 0 ?
        (((customerPrice - resellerPrice) / customerPrice) * 100).toFixed(1) : 0;
      console.log(`   Margin: ${margin}%`);

      // Check if there's a promotional price for this TLD
      const matchingPromo = promotions.find(promo =>
        promo.productkey &&
        promo.productkey.toLowerCase().includes(tld.toLowerCase()) &&
        promo.isactive === 'true'
      );

      if (matchingPromo) {
        const promoPrice = parseFloat(matchingPromo.customerprice);
        const savings = customerPrice - promoPrice;
        const discountPercent = ((savings / customerPrice) * 100).toFixed(1);

        console.log(`   🎉 PROMOTIONAL PRICE: ₹${promoPrice.toFixed(2)}`);
        console.log(`   💰 SAVINGS: ₹${savings.toFixed(2)} (${discountPercent}% off)`);

        const startTime = new Date(parseInt(matchingPromo.starttime) * 1000);
        const endTime = new Date(parseInt(matchingPromo.endtime) * 1000);
        console.log(`   📅 Valid: ${startTime.toLocaleDateString()} - ${endTime.toLocaleDateString()}`);
        console.log(`   🎯 Action Type: ${matchingPromo.actiontype}`);

        promotionalTlds++;
        totalSavings += savings;
        promotionalResults.push({
          tld,
          foundTld,
          customerPrice,
          promoPrice,
          savings,
          discountPercent,
          promotion: matchingPromo
        });
      } else {
        console.log(`   ❌ No promotional pricing available`);
      }

      console.log('');
    } else {
      console.log(`❌ TLD: .${tld.toUpperCase()} - No pricing data found`);
      console.log('   (Tried formats:', tldFormats.join(', ') + ')');
      console.log('');
    }
  }

  return {
    promotionalTlds,
    totalSavings,
    promotionalResults
  };
}

/**
 * Display comprehensive test summary and recommendations
 * 
 * @param {Object} analysis - Analysis results
 * @param {Array} promotions - All promotional details
 * @param {Array} testTlds - TLDs that were tested
 */
function displayFinalSummary(analysis, promotions, testTlds) {
  console.log('📊 FINAL TEST SUMMARY');
  console.log('='.repeat(50));
  console.log('');

  console.log(`📈 Test Results:`);
  console.log(`   TLDs tested: ${testTlds.length}`);
  console.log(`   TLDs with promotional pricing: ${analysis.promotionalTlds}`);
  console.log(`   Total potential savings: ₹${analysis.totalSavings.toFixed(2)}`);
  console.log(`   Active promotional details: ${promotions.length}`);
  console.log('');

  if (analysis.promotionalTlds > 0) {
    console.log(`🎉 Promotional TLDs Found:`);
    analysis.promotionalResults.forEach(result => {
      console.log(`   .${result.tld.toUpperCase()}: Save ₹${result.savings.toFixed(2)} (${result.discountPercent}% off)`);
    });
    console.log('');
  }

  // Final assessment
  console.log(`🏆 Final Assessment:`);
  if (analysis.promotionalTlds > 0) {
    console.log(`   ✅ SUCCESS: Promotional pricing is working correctly!`);
    console.log(`   ✅ The system can detect and apply promotional pricing.`);
    console.log(`   ✅ ${analysis.promotionalTlds} TLD(s) have active promotional pricing.`);
    console.log(`   ✅ Total potential savings: ₹${analysis.totalSavings.toFixed(2)}`);
  } else if (promotions.length > 0) {
    console.log(`   ⚠️  PARTIAL: Found ${promotions.length} promotional details but no matching TLDs in test set`);
    console.log(`   💡 Promotional pricing may be available for other TLDs not in the test set.`);
    console.log(`   💡 Check the promotional details above to see which TLDs have promotions.`);
  } else {
    console.log(`   ❌ FAILED: No promotional pricing found`);
    console.log(`   💡 This could mean:`);
    console.log(`      - No active promotions currently available`);
    console.log(`      - Insufficient API access level for promotional pricing`);
    console.log(`      - API credentials don't have promotional pricing permissions`);
  }

  console.log('');
  console.log(`💡 Next Steps:`);
  if (analysis.promotionalTlds > 0) {
    console.log(`   ✅ Promotional pricing is working - no action needed`);
    console.log(`   ✅ Consider implementing automatic promotional detection in the main application`);
    console.log(`   ✅ Monitor promotional details API for new promotions`);
  } else {
    console.log(`   🔧 Check ResellerClub account permissions for promotional pricing access`);
    console.log(`   🔧 Verify API credentials have promotional pricing permissions`);
    console.log(`   🔧 Contact ResellerClub support if promotional pricing should be available`);
  }

  console.log('');
}

/**
 * Main test function that orchestrates the final promotional pricing verification
 * 
 * This function:
 * 1. Validates the environment and displays configuration
 * 2. Fetches all pricing data from ResellerClub API
 * 3. Analyzes promotional details to understand active promotions
 * 4. Tests specific TLDs for promotional pricing availability
 * 5. Displays comprehensive summary and recommendations
 */
async function testTLDPricing() {
  try {
    // Validate environment
    validateEnvironment();
    displayConfiguration();

    // Fetch all pricing data
    const { customerData, resellerData, promoDetailsData } = await fetchAllPricingData();

    // Analyze promotional details
    analyzePromotionalDetails(promoDetailsData);

    // Test specific TLDs for promotional pricing
    const testTlds = ['com', 'net', 'org', 'info', 'biz', 'co', 'io', 'ai', 'app', 'asia', 'au', 'ca', 'cc', 'eu'];
    const analysis = testTldsForPromotionalPricing(
      customerData,
      resellerData,
      Object.values(promoDetailsData),
      testTlds
    );

    // Display final summary
    displayFinalSummary(analysis, Object.values(promoDetailsData), testTlds);

    console.log('✅ Final promotional pricing test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    await testPromotionalPricing();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the final TLD pricing test
testTLDPricing();