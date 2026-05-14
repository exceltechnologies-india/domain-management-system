
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.error("❌ .env.local not found at", envPath);
  process.exit(1);
}

const RESELLERCLUB_API_URL = process.env.RESELLERCLUB_API_URL;
const RESELLERCLUB_ID = process.env.RESELLERCLUB_ID;
const RESELLERCLUB_SECRET = process.env.RESELLERCLUB_SECRET;

if (!RESELLERCLUB_API_URL || !RESELLERCLUB_ID || !RESELLERCLUB_SECRET) {
  console.error("❌ Missing ResellerClub env vars");
  process.exit(1);
}

// Import TLD mappings - we need to read the file manually since it's TS
// and we are running in simple JS node environment for stability
const tldMappingsPath = path.resolve(process.cwd(), 'lib/tld-mappings.ts');
let tldMappings = {};

try {
  const fileContent = fs.readFileSync(tldMappingsPath, 'utf8');
  // Extract the object content using regex
  const match = fileContent.match(/export const tldMappings: { \[key: string\]: string } = ({[\s\S]*?});/);
  if (match && match[1]) {
    // loose parsing of the object string
    const objStr = match[1]
      .replace(/([a-zA-Z0-9_\.]+):/g, '"$1":') // quote keys
      .replace(/,\s*}/g, '}') // remove trailing comma
      .replace(/'/g, '"'); // replace single quotes with double quotes

    try {
      tldMappings = JSON.parse(objStr);
    } catch (e) {
      // Fallback: manual parsing line by line
      const lines = match[1].split('\n');
      lines.forEach(line => {
        const partMatch = line.match(/\s*([a-zA-Z0-9_\.]+):\s*"([^"]+)"/);
        if (partMatch) {
          tldMappings[partMatch[1]] = partMatch[2];
        }
      });
    }
  }
} catch (error) {
  console.error("❌ Failed to load TLD mappings:", error.message);
  process.exit(1);
}

const api = axios.create({
  baseURL: RESELLERCLUB_API_URL,
  timeout: 60000, // 60 second timeout
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
  },
});

api.interceptors.request.use((config) => {
  config.params = {
    ...config.params,
    "auth-userid": RESELLERCLUB_ID,
    "api-key": RESELLERCLUB_SECRET,
    "reseller-id": RESELLERCLUB_ID,
  };
  return config;
});

async function main() {
  console.log(`Starting TLD Health Check...`);
  console.log(`Loaded ${Object.keys(tldMappings).length} mappings from lib/tld-mappings.ts`);

  try {
    console.log(`Fetching live pricing...`);
    const [customerRes, resellerRes] = await Promise.all([
      api.get("/api/products/customer-price.json"),
      api.get("/api/products/reseller-price.json"),
    ]);

    const customerPrices = customerRes.data;
    const resellerPrices = resellerRes.data;

    console.log(`Received pricing for ${Object.keys(customerPrices).length} items.`);

    const issues = [];
    const warnings = [];

    // 1. Check all our defined mappings
    for (const [tld, mappedKey] of Object.entries(tldMappings)) {
      // Check if mapped key exists
      if (!customerPrices[mappedKey]) {
        issues.push(`🔴 BROKEN MAPPING: .${tld} -> '${mappedKey}' does not exist in API response.`);
        continue;
      }

      // Check for alternatives (Potential Mismapping)
      // Common patterns: "dotTLD", "domTLD", "thirdleveldotTLD"
      const alternatives = [
        `dot${tld}`,
        `dom${tld}`,
        `thirdleveldot${tld}`,
        tld
      ].filter(k => k !== mappedKey && customerPrices[k]);

      if (alternatives.length > 0) {
        const currentPrice = getPrice(customerPrices[mappedKey]);

        for (const alt of alternatives) {
          const altPrice = getPrice(customerPrices[alt]);

          // Warning if we are using a cheaper price (money loss risk) or much higher price
          if (currentPrice < altPrice) {
            warnings.push(`⚠️  POSSIBLE LOSS: .${tld} maps to '${mappedKey}' (${currentPrice}) but '${alt}' is (${altPrice}). Are we undercharging?`);
          } else if (currentPrice > altPrice) {
            warnings.push(`⚠️  OVERCHARGING?: .${tld} maps to '${mappedKey}' (${currentPrice}) but '${alt}' is (${altPrice}). Should we use the cheaper one?`);
          } else {
            // Equal price, just note it
            // console.log(`ℹ️  .${tld}: '${mappedKey}' == '${alt}' (${currentPrice})`);
          }
        }
      }
    }

    console.log("\n=== REPORT ===");
    if (issues.length === 0 && warnings.length === 0) {
      console.log("✅ All systems go! No broken mappings or critical pricing mismatches found.");
    } else {
      if (issues.length > 0) {
        console.log("\n🛑 CRITICAL ISSUES (Action Required):");
        issues.forEach(i => console.log(i));
      }

      // Add key dumping logic here
      console.log("\n❌ UNMAPPED KEYS (Possible Solutions):");
      const mappedKeys = new Set(Object.values(tldMappings));
      const availableKeys = Object.keys(customerPrices).filter(k => !mappedKeys.has(k)).sort();
      console.log(availableKeys.join("\n"));

      if (warnings.length > 0) {
        console.log("\n⚠️  WARNINGS (Verify these):");
        warnings.forEach(w => console.log(w));
      }
    }

  } catch (err) {
    console.error("❌ Fatal Error:", err.message);
  }
}

function getPrice(priceObj) {
  if (!priceObj) return 0;
  if (typeof priceObj === 'string' || typeof priceObj === 'number') return parseFloat(priceObj);

  // Look for addnewdomain.1
  if (priceObj.addnewdomain && priceObj.addnewdomain[1]) return parseFloat(priceObj.addnewdomain[1]);

  // Fallback search
  return 0;
}

main();
