#!/usr/bin/env node

/**
 * =============================================================================
 * COMPREHENSIVE RESELLERCLUB API ENDPOINTS TEST SCRIPT
 * =============================================================================
 * 
 * Purpose: Test all possible ResellerClub API endpoints to identify which ones
 * work and what type of data they return, with special focus on promotional
 * pricing capabilities.
 * 
 * What it tests:
 * - All known ResellerClub API endpoints
 * - Response validation and data structure analysis
 * - Promotional pricing data detection
 * - Endpoint categorization and success/failure tracking
 * 
 * Usage:
 *   node tests/api/test-all-endpoints.js
 * 
 * Expected Output:
 * - List of working vs failed endpoints
 * - Data structure analysis for each working endpoint
 * - Promotional pricing pattern detection
 * - Comprehensive summary and recommendations
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
 * Comprehensive list of all possible ResellerClub API endpoints
 * 
 * This array contains all known ResellerClub API endpoints organized by category.
 * Each endpoint is tested to determine if it's working and what data it returns.
 */
const endpoints = [
  // Products endpoints - Core pricing data
  {
    name: 'Customer Price',
    url: '/api/products/customer-price.json',
    category: 'products',
    description: 'Customer-facing pricing data'
  },
  {
    name: 'Reseller Price',
    url: '/api/products/reseller-price.json',
    category: 'products',
    description: 'Reseller cost pricing data'
  },
  {
    name: 'Promo Price',
    url: '/api/products/promo-price.json',
    category: 'products',
    description: 'Promotional pricing data'
  },
  {
    name: 'Pricing',
    url: '/api/products/pricing.json',
    category: 'products',
    description: 'General pricing information'
  },
  {
    name: 'Price',
    url: '/api/products/price.json',
    category: 'products',
    description: 'Alternative pricing endpoint'
  },

  // Domains endpoints - Domain-specific data
  {
    name: 'Domains Pricing',
    url: '/api/domains/pricing.json',
    category: 'domains',
    description: 'Domain registration pricing'
  },
  {
    name: 'Domains Price',
    url: '/api/domains/price.json',
    category: 'domains',
    description: 'Alternative domain pricing'
  },
  {
    name: 'Domains Available',
    url: '/api/domains/available.json',
    category: 'domains',
    description: 'Domain availability checking'
  },

  // Resellers endpoints - Reseller-specific data
  {
    name: 'Promo Details',
    url: '/api/resellers/promo-details.json',
    category: 'resellers',
    description: 'Detailed promotional information'
  },
  {
    name: 'Reseller Pricing',
    url: '/api/resellers/pricing.json',
    category: 'resellers',
    description: 'Reseller-specific pricing'
  },
  {
    name: 'Reseller Price',
    url: '/api/resellers/price.json',
    category: 'resellers',
    description: 'Alternative reseller pricing'
  },

  // Other possible endpoints - Experimental/unknown
  {
    name: 'Pricing Info',
    url: '/api/pricing.json',
    category: 'other',
    description: 'General pricing information'
  },
  {
    name: 'Price Info',
    url: '/api/price.json',
    category: 'other',
    description: 'Alternative pricing endpoint'
  },
  {
    name: 'Promotions',
    url: '/api/promotions.json',
    category: 'other',
    description: 'Promotional offers and campaigns'
  },
  {
    name: 'Promo',
    url: '/api/promo.json',
    category: 'other',
    description: 'Short promotional endpoint'
  },
];

/**
 * Test a single API endpoint
 * 
 * This function attempts to call a specific ResellerClub API endpoint
 * and analyzes the response to determine if it's working and what
 * type of data it returns.
 * 
 * @param {Object} endpoint - Endpoint configuration object
 * @returns {Promise<Object>} Test result with success status and data
 */
async function testEndpoint(endpoint) {
  try {
    console.log(`🔍 Testing: ${endpoint.name} (${endpoint.url})`);

    const response = await axios.get(`${RESELLERCLUB_API_URL}${endpoint.url}`, {
      params: {
        'auth-userid': RESELLERCLUB_ID,
        'api-key': RESELLERCLUB_SECRET,
        'format': 'json'
      },
      timeout: 10000 // 10 second timeout
    });

    if (response.status === 200) {
      const data = response.data;
      const keys = Object.keys(data);

      console.log(`   ✅ SUCCESS - Status: ${response.status}`);
      console.log(`   📊 Data keys: ${keys.length} (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''})`);

      // Analyze data structure
      const analysis = analyzeDataStructure(data, keys);
      console.log(`   🔍 Analysis: ${analysis.summary}`);

      if (analysis.pricingKeys.length > 0) {
        console.log(`   🎯 Pricing keys: ${analysis.pricingKeys.join(', ')}`);
      }

      if (analysis.promotionalKeys.length > 0) {
        console.log(`   🎉 Promotional keys: ${analysis.promotionalKeys.join(', ')}`);
      }

      console.log('');

      return {
        success: true,
        data,
        keys,
        analysis,
        responseTime: response.headers['x-response-time'] || 'unknown'
      };
    }
  } catch (error) {
    console.log(`   ❌ FAILED - Status: ${error.response?.status || 'Error'}`);
    console.log(`   📝 Message: ${error.response?.data?.message || error.message}`);
    console.log('');

    return {
      success: false,
      error: {
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        code: error.code
      }
    };
  }
}

/**
 * Analyze the structure of API response data
 * 
 * This function examines the response data to identify patterns
 * that indicate pricing information, promotional data, and other
 * useful characteristics.
 * 
 * @param {Object} data - API response data
 * @param {Array} keys - Top-level keys in the data
 * @returns {Object} Analysis results
 */
function analyzeDataStructure(data, keys) {
  const analysis = {
    pricingKeys: [],
    promotionalKeys: [],
    dataTypes: {},
    sampleStructure: null,
    summary: 'Unknown data structure'
  };

  if (keys.length === 0) {
    analysis.summary = 'Empty response';
    return analysis;
  }

  // Analyze the first few items to understand structure
  const sampleKeys = keys.slice(0, 3);
  const sampleItems = sampleKeys.map(key => data[key]);

  // Check for pricing-related keys
  sampleItems.forEach((item, index) => {
    if (typeof item === 'object' && item !== null) {
      const itemKeys = Object.keys(item);

      // Look for pricing indicators
      const pricingIndicators = itemKeys.filter(key =>
        key.toLowerCase().includes('price') ||
        key.toLowerCase().includes('cost') ||
        key.toLowerCase().includes('addnewdomain') ||
        key.toLowerCase().includes('registration') ||
        key.toLowerCase().includes('renewal')
      );

      // Look for promotional indicators
      const promotionalIndicators = itemKeys.filter(key =>
        key.toLowerCase().includes('promo') ||
        key.toLowerCase().includes('discount') ||
        key.toLowerCase().includes('sale') ||
        key.toLowerCase().includes('offer')
      );

      analysis.pricingKeys.push(...pricingIndicators);
      analysis.promotionalKeys.push(...promotionalIndicators);
      analysis.dataTypes[sampleKeys[index]] = typeof item;
    }
  });

  // Remove duplicates
  analysis.pricingKeys = [...new Set(analysis.pricingKeys)];
  analysis.promotionalKeys = [...new Set(analysis.promotionalKeys)];

  // Generate summary
  if (analysis.pricingKeys.length > 0 && analysis.promotionalKeys.length > 0) {
    analysis.summary = 'Pricing data with promotional information';
  } else if (analysis.pricingKeys.length > 0) {
    analysis.summary = 'Pricing data (no promotional info detected)';
  } else if (analysis.promotionalKeys.length > 0) {
    analysis.summary = 'Promotional data (no pricing info detected)';
  } else {
    analysis.summary = 'General data (no pricing/promotional patterns detected)';
  }

  // Store sample structure for detailed analysis
  if (sampleItems.length > 0) {
    analysis.sampleStructure = sampleItems[0];
  }

  return analysis;
}

/**
 * Display comprehensive summary of all test results
 * 
 * @param {Array} results - Array of test results
 */
function displaySummary(results) {
  console.log('📊 COMPREHENSIVE TEST SUMMARY');
  console.log('='.repeat(50));
  console.log('');

  // Categorize results
  const workingEndpoints = results.filter(r => r.success);
  const failedEndpoints = results.filter(r => !r.success);
  const pricingEndpoints = workingEndpoints.filter(r => r.analysis?.pricingKeys.length > 0);
  const promotionalEndpoints = workingEndpoints.filter(r => r.analysis?.promotionalKeys.length > 0);

  // Overall statistics
  console.log(`📈 Overall Statistics:`);
  console.log(`   Total endpoints tested: ${results.length}`);
  console.log(`   Working endpoints: ${workingEndpoints.length}`);
  console.log(`   Failed endpoints: ${failedEndpoints.length}`);
  console.log(`   Success rate: ${((workingEndpoints.length / results.length) * 100).toFixed(1)}%`);
  console.log('');

  // Working endpoints by category
  console.log(`✅ Working Endpoints by Category:`);
  const categories = [...new Set(workingEndpoints.map(r => r.category))];
  categories.forEach(category => {
    const categoryEndpoints = workingEndpoints.filter(r => r.category === category);
    console.log(`   ${category.toUpperCase()}: ${categoryEndpoints.length} endpoints`);
    categoryEndpoints.forEach(endpoint => {
      console.log(`      - ${endpoint.name}: ${endpoint.url}`);
    });
  });
  console.log('');

  // Pricing capabilities
  console.log(`🎯 Pricing Capabilities:`);
  console.log(`   Endpoints with pricing data: ${pricingEndpoints.length}`);
  console.log(`   Endpoints with promotional data: ${promotionalEndpoints.length}`);
  console.log('');

  if (pricingEndpoints.length > 0) {
    console.log(`   📋 Pricing Endpoints:`);
    pricingEndpoints.forEach(endpoint => {
      console.log(`      - ${endpoint.name}: ${endpoint.url}`);
      console.log(`        Pricing keys: ${endpoint.analysis.pricingKeys.join(', ')}`);
    });
    console.log('');
  }

  if (promotionalEndpoints.length > 0) {
    console.log(`   🎉 Promotional Endpoints:`);
    promotionalEndpoints.forEach(endpoint => {
      console.log(`      - ${endpoint.name}: ${endpoint.url}`);
      console.log(`        Promotional keys: ${endpoint.analysis.promotionalKeys.join(', ')}`);
    });
    console.log('');
  }

  // Failed endpoints
  if (failedEndpoints.length > 0) {
    console.log(`❌ Failed Endpoints:`);
    failedEndpoints.forEach(endpoint => {
      console.log(`   - ${endpoint.name}: ${endpoint.url}`);
      console.log(`     Error: ${endpoint.error.message}`);
    });
    console.log('');
  }

  // Recommendations
  console.log(`💡 Recommendations:`);
  if (promotionalEndpoints.length > 0) {
    console.log(`   ✅ Use promotional endpoints for promotional pricing:`);
    promotionalEndpoints.forEach(endpoint => {
      console.log(`      - ${endpoint.name} (${endpoint.url})`);
    });
  } else {
    console.log(`   ⚠️  No promotional endpoints found - check API access level`);
  }

  if (pricingEndpoints.length > 0) {
    console.log(`   ✅ Use pricing endpoints for base pricing:`);
    pricingEndpoints.forEach(endpoint => {
      console.log(`      - ${endpoint.name} (${endpoint.url})`);
    });
  }

  console.log('');
}

/**
 * Main test function that orchestrates testing all endpoints
 * 
 * This function:
 * 1. Validates the environment
 * 2. Tests all endpoints sequentially
 * 3. Analyzes the results
 * 4. Displays comprehensive summary
 */
async function testAllEndpoints() {
  console.log('🔍 Testing All ResellerClub API Endpoints...');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Validate environment
    validateEnvironment();
    displayConfiguration();

    // Test all endpoints
    const results = [];
    console.log(`🧪 Testing ${endpoints.length} endpoints...`);
    console.log('');

    for (const endpoint of endpoints) {
      const result = await testEndpoint(endpoint);
      results.push({ ...endpoint, ...result });
    }

    // Display comprehensive summary
    displaySummary(results);

    console.log('✅ All endpoint tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    await testAllEndpoints();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the comprehensive test
main();
