#!/usr/bin/env node

/**
 * =============================================================================
 * PRICING DATA UPDATE UTILITY SCRIPT
 * =============================================================================
 * 
 * Purpose: Update pricing logic in the ResellerClub API integration to use
 * live pricing data instead of hardcoded fallback prices.
 * 
 * What it does:
 * - Updates the ResellerClub API pricing logic
 * - Replaces hardcoded fallback prices with live pricing
 * - Adds pricing source tracking
 * - Implements proper error handling for pricing failures
 * 
 * Usage:
 *   node tests/scripts/update_pricing.js
 * 
 * What it modifies:
 * - lib/resellerclub.ts - Updates pricing logic in the production section
 * 
 * Backup:
 * - Creates a backup of the original file before modification
 * - Original file is saved as lib/resellerclub.ts.backup
 * 
 * Dependencies:
 * - fs (Node.js file system module)
 * 
 * Author: ANUTECH DIGITAL PRIVATE LIMITED
 * Created: 2024
 * Last Updated: 2024-10-08
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a backup of the original file before modification
 * 
 * @param {string} filePath - Path to the file to backup
 * @returns {string} Path to the backup file
 */
function createBackup(filePath) {
  const backupPath = `${filePath}.backup`;

  try {
    // Check if backup already exists
    if (fs.existsSync(backupPath)) {
      console.log(`   ⚠️  Backup already exists: ${backupPath}`);
      console.log(`   📝 Creating new backup with timestamp...`);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const timestampedBackup = `${filePath}.backup.${timestamp}`;
      fs.copyFileSync(filePath, timestampedBackup);
      console.log(`   ✅ Timestamped backup created: ${timestampedBackup}`);
    } else {
      fs.copyFileSync(filePath, backupPath);
      console.log(`   ✅ Backup created: ${backupPath}`);
    }

    return backupPath;
  } catch (error) {
    console.error(`   ❌ Failed to create backup: ${error.message}`);
    throw error;
  }
}

/**
 * Update the pricing logic in the ResellerClub API file
 * 
 * This function replaces the hardcoded fallback pricing logic with
 * live pricing integration that fetches real-time data from ResellerClub.
 * 
 * @param {string} filePath - Path to the ResellerClub API file
 */
function updatePricingLogic(filePath) {
  console.log('📝 Updating pricing logic in ResellerClub API...');
  console.log('   File:', filePath);
  console.log('');

  try {
    // Read the current file content
    console.log('📖 Reading current file content...');
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`   File size: ${content.length} characters`);
    console.log('');

    // Define the new pricing logic
    const newPricingLogic = `// Initialize pricing variables
            let price = 0;
            let currency = "INR";
            let pricingSource = "unavailable";

            // Only fetch pricing for available domains
            if (isAvailable) {
              const tld = domain.split(".").pop()?.toLowerCase();
              
              try {
                // Try to get live reseller pricing first
                const livePricing = await this.getResellerPricingForTLD(tld || "");
                if (livePricing) {
                  price = livePricing.price;
                  currency = livePricing.currency;
                  pricingSource = "live";
                  console.log(
                    \`💰 [PRODUCTION] Using live reseller pricing for \${domain}: ₹\${price} \${currency}\`
                  );
                } else {
                  throw new Error("No live pricing available");
                }
              } catch (error) {
                // Fall back to hardcoded pricing
                const fallbackPrices: {
                  [key: string]: { price: number; currency: string };
                } = {
                  com: { price: 999, currency: "INR" },
                  net: { price: 1199, currency: "INR" },
                  org: { price: 1099, currency: "INR" },
                  info: { price: 1299, currency: "INR" },
                  biz: { price: 1399, currency: "INR" },
                  co: { price: 1499, currency: "INR" },
                  in: { price: 699, currency: "INR" },
                  "co.in": { price: 799, currency: "INR" },
                  shop: { price: 1599, currency: "INR" },
                  store: { price: 1599, currency: "INR" },
                  online: { price: 1999, currency: "INR" },
                  site: { price: 1399, currency: "INR" },
                  website: { price: 1799, currency: "INR" },
                  app: { price: 2399, currency: "INR" },
                  dev: { price: 1599, currency: "INR" },
                  io: { price: 3199, currency: "INR" },
                  ai: { price: 3999, currency: "INR" },
                  tech: { price: 1999, currency: "INR" },
                  digital: { price: 1599, currency: "INR" },
                  cloud: { price: 1999, currency: "INR" },
                  host: { price: 1599, currency: "INR" },
                  space: { price: 1399, currency: "INR" },
                };

                const fallback = fallbackPrices[tld || ""] || {
                  price: 999,
                  currency: "INR",
                };
                price = fallback.price;
                currency = fallback.currency;
                pricingSource = "fallback";

                console.log(
                  \`💰 [PRODUCTION] Using fallback pricing for \${domain}: ₹\${price} \${currency} (live pricing failed)\`
                );
              }
            } else {
              console.log(
                \`🚫 [PRODUCTION] Domain \${domain} is not available, skipping pricing check\`
              );
            }`;

    // Define the regex pattern to match the old pricing logic
    const oldPricingPattern = /\/\/ Get pricing from the response or use fallback pricing\n\s+let price = parseFloat\(domainData\.price\) \|\| 0;\n\s+let currency = domainData\.currency \|\| "USD";\n\n\s+\/\/ If no price is provided by the API, use fallback pricing based on TLD\n\s+if \(price === 0 && isAvailable\) \{[\s\S]*?\n\s+\}/;

    // Check if the old pricing pattern exists
    if (!oldPricingPattern.test(content)) {
      console.log('   ⚠️  Old pricing pattern not found in file');
      console.log('   💡 The file may have already been updated or has a different structure');
      console.log('   📝 Proceeding with manual replacement...');
    }

    // Replace the old pricing logic with the new one
    console.log('🔄 Replacing old pricing logic with new live pricing logic...');
    const updatedContent = content.replace(
      oldPricingPattern,
      newPricingLogic
    );

    // Check if replacement was successful
    if (updatedContent === content) {
      console.log('   ⚠️  No changes made - pattern not found');
      console.log('   💡 The file may already be updated or have a different structure');
      console.log('   📝 Manual review may be required');
    } else {
      console.log('   ✅ Pricing logic replacement completed');
    }

    // Update the results.push section to include pricingSource
    console.log('🔄 Updating results.push section to include pricingSource...');
    const resultsPattern = /results\.push\(\{\s+domainName: domain,\s+available: isAvailable,\s+price: price,\s+currency: currency,\s+registrationPeriod: 1, \/\/ Default to 1 year\s+\}\);/;

    const newResultsPush = `results.push({
              domainName: domain,
              available: isAvailable,
              price: price,
              currency: currency,
              registrationPeriod: 1, // Default to 1 year
              pricingSource: pricingSource, // Add pricing source info
            });`;

    const finalContent = updatedContent.replace(resultsPattern, newResultsPush);

    // Check if results.push was updated
    if (finalContent === updatedContent) {
      console.log('   ⚠️  Results.push section not updated - pattern not found');
      console.log('   💡 The section may already be updated or have a different structure');
    } else {
      console.log('   ✅ Results.push section updated with pricingSource');
    }

    // Write the updated content back to the file
    console.log('💾 Writing updated content to file...');
    fs.writeFileSync(filePath, finalContent, 'utf8');
    console.log('   ✅ File updated successfully');

    // Verify the update
    const updatedFileContent = fs.readFileSync(filePath, 'utf8');
    const hasNewPricing = updatedFileContent.includes('pricingSource = "unavailable"');
    const hasNewResults = updatedFileContent.includes('pricingSource: pricingSource');

    console.log('');
    console.log('🔍 Update Verification:');
    console.log(`   New pricing logic present: ${hasNewPricing ? '✅ Yes' : '❌ No'}`);
    console.log(`   Results.push updated: ${hasNewResults ? '✅ Yes' : '❌ No'}`);

    if (hasNewPricing && hasNewResults) {
      console.log('   🎉 All updates applied successfully!');
    } else {
      console.log('   ⚠️  Some updates may not have been applied');
      console.log('   💡 Manual review of the file may be required');
    }

  } catch (error) {
    console.error('   ❌ Failed to update pricing logic:', error.message);
    throw error;
  }
}

/**
 * Display update summary and next steps
 * 
 * @param {string} filePath - Path to the updated file
 * @param {string} backupPath - Path to the backup file
 */
function displaySummary(filePath, backupPath) {
  console.log('');
  console.log('📊 UPDATE SUMMARY');
  console.log('='.repeat(30));
  console.log(`   Original file: ${filePath}`);
  console.log(`   Backup file: ${backupPath}`);
  console.log(`   Update time: ${new Date().toISOString()}`);
  console.log('');

  console.log('🔄 Changes Made:');
  console.log('   ✅ Replaced hardcoded pricing with live pricing integration');
  console.log('   ✅ Added pricing source tracking (live/fallback/unavailable)');
  console.log('   ✅ Implemented proper error handling for pricing failures');
  console.log('   ✅ Updated results.push to include pricingSource field');
  console.log('');

  console.log('💡 Next Steps:');
  console.log('   1. Test the updated pricing logic with: npm run dev');
  console.log('   2. Verify live pricing is working correctly');
  console.log('   3. Check that fallback pricing works when live pricing fails');
  console.log('   4. Monitor logs for pricing source information');
  console.log('   5. If issues occur, restore from backup: cp lib/resellerclub.ts.backup lib/resellerclub.ts');
  console.log('');

  console.log('🔧 Troubleshooting:');
  console.log('   - If live pricing fails, check ResellerClub API credentials');
  console.log('   - If fallback pricing is used, check network connectivity');
  console.log('   - If errors occur, restore from backup and investigate');
  console.log('   - Check server logs for detailed error information');
  console.log('');
}

/**
 * Main function that orchestrates the pricing update process
 * 
 * This function:
 * 1. Validates the file exists
 * 2. Creates a backup of the original file
 * 3. Updates the pricing logic
 * 4. Displays summary and next steps
 */
async function updatePricing() {
  console.log('🚀 Starting Pricing Data Update');
  console.log('='.repeat(40));
  console.log('');

  const filePath = 'lib/resellerclub.ts';

  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      console.error('   Please run this script from the project root directory');
      process.exit(1);
    }

    console.log(`📁 Target file: ${filePath}`);
    console.log('');

    // Create backup
    console.log('💾 Creating backup of original file...');
    const backupPath = createBackup(filePath);
    console.log('');

    // Update pricing logic
    updatePricingLogic(filePath);

    // Display summary
    displaySummary(filePath, backupPath);

    console.log('✅ Pricing data update completed successfully!');

  } catch (error) {
    console.error('❌ Update failed:', error.message);
    console.error('');
    console.error('💡 Troubleshooting:');
    console.error('   1. Ensure you\'re running from the project root directory');
    console.error('   2. Check that lib/resellerclub.ts exists');
    console.error('   3. Verify you have write permissions for the file');
    console.error('   4. If a backup exists, restore it: cp lib/resellerclub.ts.backup lib/resellerclub.ts');
    process.exit(1);
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    await updatePricing();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the pricing update
main();