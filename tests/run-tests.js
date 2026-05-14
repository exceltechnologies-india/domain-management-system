#!/usr/bin/env node

/**
 * =============================================================================
 * TEST SUITE RUNNER
 * =============================================================================
 * 
 * Purpose: Centralized test runner for all Domain Management System tests
 * 
 * Usage:
 *   node tests/run-tests.js [test-name]
 *   node tests/run-tests.js all
 *   node tests/run-tests.js [category]
 * 
 * Categories:
 *   api      - API endpoint tests
 *   admin    - Admin functionality tests
 *   payment  - Payment system tests
 *   pricing  - Pricing system tests
 *   debug    - Debug tools
 *   scripts  - Utility scripts
 * 
 * Examples:
 *   node tests/run-tests.js                    # Run all tests
 *   node tests/run-tests.js all                # Run all tests
 *   node tests/run-tests.js api                # Run all API tests
 *   node tests/run-tests.js admin              # Run admin tests
 *   node tests/run-tests.js payment            # Run payment tests
 *   node tests/run-tests.js pricing            # Run pricing tests
 *   node tests/run-tests.js debug              # Run debug tools
 *   node tests/run-tests.js test-final-pricing # Run specific test
 * 
 * Author: ANUTECH DIGITAL PRIVATE LIMITED
**/

const { spawn } = require('child_process');
const path = require('path');

/**
 * Available test categories and their scripts
 */
const testCategories = {
  api: [
    'test-pricing.js',
    'test-tld-mappings.js',
    'test-all-endpoints.js',
    'test-simple-pricing.js',
    'test-final-pricing.js',
    'test-eu-pricing.js'
  ],
  admin: [
    'test-ip-check.js',
    'test-delete-order.js'
  ],
  payment: [
    'test-payment-success.js',
    'test-error-handling.js'
  ],
  pricing: [
    'test-ai-pricing.js'
  ],
  scripts: [
    'update_pricing.js'
  ]
};

/**
 * Run a single test script
 * 
 * @param {string} scriptPath - Path to the test script
 * @param {string} category - Category of the test
 * @returns {Promise<boolean>} Success status
 */
async function runTest(scriptPath, category) {
  return new Promise((resolve) => {
    console.log(`\n🧪 Running ${category}/${path.basename(scriptPath)}...`);
    console.log('='.repeat(60));

    const child = spawn('node', [scriptPath], {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${path.basename(scriptPath)} completed successfully`);
        resolve(true);
      } else {
        console.log(`❌ ${path.basename(scriptPath)} failed with exit code ${code}`);
        resolve(false);
      }
    });

    child.on('error', (error) => {
      console.error(`❌ Error running ${path.basename(scriptPath)}:`, error.message);
      resolve(false);
    });
  });
}

/**
 * Run all tests in a category
 * 
 * @param {string} category - Test category to run
 * @returns {Promise<Object>} Results summary
 */
async function runCategory(category) {
  const scripts = testCategories[category];
  if (!scripts) {
    console.error(`❌ Unknown category: ${category}`);
    return { success: 0, failed: 0, total: 0 };
  }

  console.log(`\n🚀 Running ${category.toUpperCase()} tests...`);
  console.log(`📋 Found ${scripts.length} test(s) in ${category} category`);

  let success = 0;
  let failed = 0;

  for (const script of scripts) {
    // Handle different directory structures
    let scriptPath;
    if (category === 'api' || category === 'debug' || category === 'scripts') {
      scriptPath = path.join(__dirname, category, script);
    } else {
      // New categories: admin, payment, pricing
      scriptPath = path.join(__dirname, category, script);
    }

    const result = await runTest(scriptPath, category);

    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  return { success, failed, total: scripts.length };
}

/**
 * Run all available tests
 * 
 * @returns {Promise<Object>} Overall results summary
 */
async function runAllTests() {
  console.log('\n🚀 Running ALL tests...');
  console.log('='.repeat(50));

  let totalSuccess = 0;
  let totalFailed = 0;
  let totalTests = 0;

  for (const category of Object.keys(testCategories)) {
    const results = await runCategory(category);
    totalSuccess += results.success;
    totalFailed += results.failed;
    totalTests += results.total;
  }

  return { success: totalSuccess, failed: totalFailed, total: totalTests };
}

/**
 * Run a specific test by name
 * 
 * @param {string} testName - Name of the test to run
 * @returns {Promise<boolean>} Success status
 */
async function runSpecificTest(testName) {
  // Find the test in all categories
  for (const [category, scripts] of Object.entries(testCategories)) {
    for (const script of scripts) {
      const scriptName = path.basename(script, '.js');
      if (scriptName === testName) {
        const scriptPath = path.join(__dirname, category, script);
        return await runTest(scriptPath, category);
      }
    }
  }

  console.error(`❌ Test not found: ${testName}`);
  console.log('\n📋 Available tests:');

  for (const [category, scripts] of Object.entries(testCategories)) {
    console.log(`\n   ${category.toUpperCase()}:`);
    scripts.forEach(script => {
      const scriptName = path.basename(script, '.js');
      console.log(`     - ${scriptName}`);
    });
  }

  return false;
}

/**
 * Display help information
 */
function displayHelp() {
  console.log('\n📖 Domain Management System Test Suite');
  console.log('='.repeat(45));
  console.log('');
  console.log('Usage:');
  console.log('  node tests/run-tests.js [command]');
  console.log('');
  console.log('Commands:');
  console.log('  all                    Run all tests');
  console.log('  api                    Run all API tests');
  console.log('  admin                  Run admin functionality tests');
  console.log('  payment                Run payment system tests');
  console.log('  pricing                Run pricing system tests');
  console.log('  debug                  Run debug tools');
  console.log('  scripts                Run utility scripts');
  console.log('  <test-name>            Run specific test');
  console.log('  help                   Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  node tests/run-tests.js                    # Run all tests');
  console.log('  node tests/run-tests.js api                # Run API tests');
  console.log('  node tests/run-tests.js test-final-pricing # Run specific test');
  console.log('');
  console.log('Available Tests:');

  for (const [category, scripts] of Object.entries(testCategories)) {
    console.log(`\n   ${category.toUpperCase()}:`);
    scripts.forEach(script => {
      const scriptName = path.basename(script, '.js');
      console.log(`     - ${scriptName}`);
    });
  }

  console.log('');
}

/**
 * Display test results summary
 * 
 * @param {Object} results - Test results
 * @param {string} category - Category name (optional)
 */
function displayResults(results, category = '') {
  const { success, failed, total } = results;

  console.log('\n📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(30));

  if (category) {
    console.log(`Category: ${category.toUpperCase()}`);
  } else {
    console.log('Overall Results:');
  }

  console.log(`   Total Tests: ${total}`);
  console.log(`   Successful: ${success} ✅`);
  console.log(`   Failed: ${failed} ❌`);
  console.log(`   Success Rate: ${total > 0 ? ((success / total) * 100).toFixed(1) : 0}%`);

  if (failed > 0) {
    console.log('\n💡 Next Steps:');
    console.log('   - Check individual test output for error details');
    console.log('   - Verify environment variables are set correctly');
    console.log('   - Ensure the main application is running (for API tests)');
    console.log('   - Review test documentation for troubleshooting tips');
  } else {
    console.log('\n🎉 All tests passed successfully!');
  }

  console.log('');
}

/**
 * Main function that processes command line arguments and runs tests
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'all';

  // Handle help command
  if (command === 'help' || command === '--help' || command === '-h') {
    displayHelp();
    process.exit(0);
  }

  let results;

  try {
    // Determine which tests to run
    if (command === 'all') {
      results = await runAllTests();
    } else if (testCategories[command]) {
      results = await runCategory(command);
    } else {
      // Try to run as specific test name
      const success = await runSpecificTest(command);
      results = { success: success ? 1 : 0, failed: success ? 0 : 1, total: 1 };
    }

    // Display results
    displayResults(results, command === 'all' ? '' : command);

    // Exit with appropriate code
    process.exit(results.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ Test runner failed:', error.message);
    process.exit(1);
  }
}

// Run the test suite
main();
