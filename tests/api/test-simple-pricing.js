#!/usr/bin/env node

/**
 * =============================================================================
 * SIMPLE PROMOTIONAL PRICING TEST SCRIPT
 * =============================================================================
 * 
 * Purpose: Test the existing working ResellerClub API endpoints to verify
 * promotional pricing capabilities and compare different pricing sources.
 * 
 * What it tests:
 * - Customer pricing API (current implementation)
 * - Reseller pricing API (cost basis)
 * - Promo pricing API (direct promotional prices)
 * - Promotional details API (active promotions metadata)
 * - Cross-comparison of pricing sources
 * 
 * Usage:
 *   node tests/api/test-simple-promo.js
 * 
 * Expected Output:
 * - Pricing data from all working endpoints
 * - Promotional pricing comparison and analysis
 * - Active promotional details summary
 * - Savings calculations and recommendations
 * 
 * Dependencies:
 * - axios (HTTP client)
 * - .env.local (environment variables)
 * 
 * Author: ANUTECH DIGITAL PRIVATE LIMITED
 * Created: 2024
 * Last Updated: 2024-10-08
 */

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
  console.log('🔧 ResellerClub API Configuration:');
  console.log('   API URL:', RESELLERCLUB_API_URL);
  console.log('   User ID:', RESELLERCLUB_ID);
  console.log('   API Key:', RESELLERCLUB_SECRET.substring(0, 8) + '...');
  console.log('');
}

/**
 * Test customer pricing API endpoint
 * 
 * This is the endpoint currently used in the application for
 * customer-facing pricing information.
 * 
 * @returns {Promise<Object>} Customer pricing data
 */
async function testCustomerPricing() {
  console.log('📊 Test 1: Customer Pricing API...');

  try {
    const response = await axios.get(`${RESELLERCLUB_API_URL}/api/products/customer-price.json`, {
      params: {
        'auth-userid': RESELLERCLUB_ID,
        'api-key': RESELLERCLUB_SECRET,
        'format': 'json'
      },
      timeout: 30000
    });

    console.log('✅ Customer pricing fetched successfully');
    console.log('   TLDs available:', Object.keys(response.data).length);
    console.log('   Sample TLDs:', Object.keys(response.data).slice(0, 5));
    console.log('');

    return response.data;
  } catch (error) {
    console.error('❌ Customer pricing failed:', error.message);
    throw error;
  }
}

/**
 * Test reseller pricing API endpoint
 * 
 * This endpoint provides the base cost pricing that resellers pay,
 * without any markup or promotional discounts.
 * 
 * @returns {Promise<Object>} Reseller pricing data
 */
async function testResellerPricing() {
  console.log('📊 Test 2: Reseller Pricing API...');

  try {
    const response = await axios.get(`${RESELLERCLUB_API_URL}/api/products/reseller-price.json`, {
      params: {
        'auth-userid': RESELLERCLUB_ID,
        'api-key': RESELLERCLUB_SECRET,
        'format': 'json'
      },
      timeout: 30000
    });

    console.log('✅ Reseller pricing fetched successfully');
    console.log('   TLDs available:', Object.keys(response.data).length);
    console.log('');

    return response.data;
  } catch (error) {
    console.error('❌ Reseller pricing failed:', error.message);
    throw error;
  }
}

/**
 * Test promotional pricing API endpoint
 * 
 * This endpoint provides direct promotional pricing information
 * for TLDs that have active promotions.
 * 
 * @returns {Promise<Object>} Promotional pricing data
 */
async function testPromoPricing() {
  console.log('📊 Test 3: Promo Pricing API...');

  try {
    const response = await axios.get(`${RESELLERCLUB_API_URL}/api/products/promo-price.json`, {
      params: {
        'auth-userid': RESELLERCLUB_ID,
        'api-key': RESELLERCLUB_SECRET,
        'format': 'json'
      },
      timeout: 30000
    });

    console.log('✅ Promo pricing fetched successfully');
    console.log('   TLDs available:', Object.keys(response.data).length);
    console.log('   Sample TLDs:', Object.keys(response.data).slice(0, 5));
    console.log('');

    return response.data;
  } catch (error) {
    console.error('❌ Promo pricing failed:', error.message);
    throw error;
  }
}

/**
 * Test promotional details API endpoint
 * 
 * This endpoint provides detailed information about active promotions
 * including validity periods, promotional prices, and metadata.
 * 
 * @returns {Promise<Object>} Promotional details data
 */
async function testPromoDetails() {
  console.log('📊 Test 4: Promotional Details API...');

  try {
    const response = await axios.get(`${RESELLERCLUB_API_URL}/api/resellers/promo-details.json`, {
      params: {
        'auth-userid': RESELLERCLUB_ID,
        'api-key': RESELLERCLUB_SECRET,
        'format': 'json'
      },
      timeout: 30000
    });

    console.log('✅ Promotional details fetched successfully');
    console.log('   Promotions available:', Object.keys(response.data).length);
    console.log('');

    return response.data;
  } catch (error) {
    console.error('❌ Promotional details failed:', error.message);
    throw error;
  }
}

/**
 * Analyze promotional pricing by comparing different pricing sources
 * 
 * This function compares customer pricing, reseller pricing, and promotional
 * pricing to identify TLDs with active promotional discounts.
 * 
 * @param {Object} customerData - Customer pricing data
 * @param {Object} resellerData - Reseller pricing data
 * @param {Object} promoData - Promotional pricing data
 * @param {Array} sampleTlds - TLDs to analyze
 */
function analyzePromotionalPricing(customerData, resellerData, promoData, sampleTlds) {
  console.log('🔍 Analyzing Promotional Pricing...');
  console.log('');

  let promotionalTlds = 0;
  let totalSavings = 0;
  const promotionalDetails = [];

  // Analyze each TLD
  for (const tld of sampleTlds) {
    const customerTld = customerData[tld];
    const resellerTld = resellerData[tld];
    const promoTld = promoData[tld];

    console.log(`📋 TLD: .${tld.toUpperCase()}`);

    // Extract pricing information
    if (customerTld && customerTld.addnewdomain && customerTld.addnewdomain['1']) {
      const customerPrice = parseFloat(customerTld.addnewdomain['1']);
      const resellerPrice = resellerTld?.addnewdomain?.['1'] ?
        parseFloat(resellerTld.addnewdomain['1']) : 0;
      const promoPrice = promoTld?.addnewdomain?.['1'] ?
        parseFloat(promoTld.addnewdomain['1']) : 0;

      console.log(`   Customer Price: ₹${customerPrice.toFixed(2)}`);
      console.log(`   Reseller Price: ₹${resellerPrice.toFixed(2)}`);
      console.log(`   Promo Price: ₹${promoPrice.toFixed(2)}`);

      // Check for promotional pricing
      if (promoPrice > 0 && promoPrice < customerPrice) {
        const savings = customerPrice - promoPrice;
        const discountPercent = ((savings / customerPrice) * 100).toFixed(1);

        console.log(`   🎉 PROMOTIONAL: Save ₹${savings.toFixed(2)} (${discountPercent}% off)`);
        console.log('');

        promotionalTlds++;
        totalSavings += savings;
        promotionalDetails.push({
          tld,
          customerPrice,
          promoPrice,
          savings,
          discountPercent
        });
      } else {
        console.log(`   ❌ No promotional pricing available`);
        console.log('');
      }
    } else {
      console.log(`   ❌ No pricing data available`);
      console.log('');
    }
  }

  return {
    promotionalTlds,
    totalSavings,
    promotionalDetails
  };
}

/**
 * Analyze active promotional details
 * 
 * This function examines the promotional details API response to identify
 * active promotions and their characteristics.
 * 
 * @param {Object} promoDetailsData - Promotional details data
 */
function analyzeActivePromotions(promoDetailsData) {
  console.log('🎯 Active Promotional Details Analysis:');
  console.log('');

  // Filter for active promotions
  const activePromotions = Object.values(promoDetailsData).filter((promo) => {
    return promo.isactive === 'true' && promo.productkey;
  });

  console.log(`   Total active promotions: ${activePromotions.length}`);

  if (activePromotions.length > 0) {
    console.log('   Sample active promotions:');

    activePromotions.slice(0, 5).forEach((promo, index) => {
      const startTime = new Date(parseInt(promo.starttime) * 1000);
      const endTime = new Date(parseInt(promo.endtime) * 1000);

      console.log(`   ${index + 1}. ${promo.productkey}`);
      console.log(`      Customer Price: ₹${promo.customerprice}`);
      console.log(`      Valid: ${startTime.toLocaleDateString()} - ${endTime.toLocaleDateString()}`);
      console.log(`      Action Type: ${promo.actiontype}`);
      console.log('');
    });

    // Group by TLD
    const tldGroups = {};
    activePromotions.forEach(promo => {
      const tld = promo.productkey.replace(/^(dot|centralnicza)/i, '').toLowerCase();
      if (!tldGroups[tld]) tldGroups[tld] = [];
      tldGroups[tld].push(promo);
    });

    console.log(`   TLDs with active promotions: ${Object.keys(tldGroups).length}`);
    console.log(`   TLDs: ${Object.keys(tldGroups).join(', ')}`);
  } else {
    console.log('   ⚠️  No active promotions found');
  }

  console.log('');
}

/**
 * Display comprehensive test summary
 * 
 * @param {Object} analysis - Analysis results
 * @param {number} activePromotions - Number of active promotions
 * @param {Array} sampleTlds - TLDs that were tested
 */
function displaySummary(analysis, activePromotions, sampleTlds) {
  console.log('📊 COMPREHENSIVE TEST SUMMARY');
  console.log('='.repeat(50));
  console.log('');

  console.log(`📈 Pricing Analysis:`);
  console.log(`   TLDs tested: ${sampleTlds.length}`);
  console.log(`   TLDs with promotional pricing: ${analysis.promotionalTlds}`);
  console.log(`   Total potential savings: ₹${analysis.totalSavings.toFixed(2)}`);
  console.log(`   Active promotional details: ${activePromotions}`);
  console.log('');

  if (analysis.promotionalTlds > 0) {
    console.log(`🎉 Promotional TLDs Found:`);
    analysis.promotionalDetails.forEach(detail => {
      console.log(`   .${detail.tld.toUpperCase()}: Save ₹${detail.savings.toFixed(2)} (${detail.discountPercent}% off)`);
    });
    console.log('');
  }

  // Provide recommendations
  console.log(`💡 Recommendations:`);
  if (analysis.promotionalTlds > 0) {
    console.log(`   ✅ Promotional pricing is working correctly`);
    console.log(`   ✅ Use promo pricing API for promotional TLDs`);
    console.log(`   ✅ Consider implementing automatic promotional detection`);
  } else if (activePromotions > 0) {
    console.log(`   ⚠️  Promotional details available but no direct promo pricing`);
    console.log(`   💡 Use promotional details API for promotional information`);
  } else {
    console.log(`   ❌ No promotional pricing or details found`);
    console.log(`   💡 Check API access level and active promotions`);
  }

  console.log('');
}

/**
 * Main test function that orchestrates all promotional pricing tests
 * 
 * This function:
 * 1. Tests all four pricing API endpoints
 * 2. Analyzes promotional pricing by comparing sources
 * 3. Examines active promotional details
 * 4. Displays comprehensive summary and recommendations
 */
async function testPromotionalPricing() {
  console.log('🎯 Testing ResellerClub Promotional Pricing...');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Validate environment
    validateEnvironment();
    displayConfiguration();

    // Test all pricing endpoints
    const customerData = await testCustomerPricing();
    const resellerData = await testResellerPricing();
    const promoData = await testPromoPricing();
    const promoDetailsData = await testPromoDetails();

    // Sample TLDs for analysis
    const sampleTlds = ['com', 'net', 'org', 'info', 'biz', 'co', 'io', 'ai', 'app', 'asia', 'au', 'ca', 'cc', 'eu'];

    // Analyze promotional pricing
    const analysis = analyzePromotionalPricing(customerData, resellerData, promoData, sampleTlds);

    // Analyze active promotional details
    const activePromotions = Object.values(promoDetailsData).filter((promo) => {
      return promo.isactive === 'true' && promo.productkey;
    }).length;

    analyzeActivePromotions(promoDetailsData);

    // Display comprehensive summary
    displaySummary(analysis, activePromotions, sampleTlds);

    console.log('✅ All promotional pricing tests completed successfully!');

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

// Run the promotional pricing test
main();
