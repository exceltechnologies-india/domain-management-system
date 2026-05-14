/**
 * Script to simulate a full 8-day service lifecycle in seconds.
 * 
 * Usage: 
 * export CRON_SECRET=your_secret
 * export NEXTAUTH_URL=http://localhost:3000
 * npx ts-node scripts/simulate-lifecycle.ts <serviceId> <serviceType>
 */

import axios from 'axios';

const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL = process.env.NEXTAUTH_URL || 'http://localhost:3000';

if (!CRON_SECRET) {
    console.error("Error: CRON_SECRET environment variable is required.");
    process.exit(1);
}

const serviceId = process.argv[2];
const serviceType = process.argv[3] || 'hosting';

if (!serviceId) {
    console.error("Usage: npx ts-node scripts/simulate-lifecycle.ts <serviceId> [hosting|domain]");
    process.exit(1);
}

async function runSimulation() {
    const startTime = new Date();
    // Start simulation at "today"
    const T = new Date(startTime);
    
    // We assume the service's expiry date is already set to T + 8 days for this test.
    // Or we can set it via a test endpoint if we had one.
    
    const steps = [
        { day: 0, label: "Initial state (8 days left)" },
        { day: 1, label: "Day 1 (7 days left) -> Should trigger 7-day reminder" },
        { day: 5, label: "Day 5 (3 days left) -> Should trigger 3-day reminder" },
        { day: 7, label: "Day 7 (1 day left) -> Should trigger 1-day reminder" },
        { day: 8, label: "Day 8 (0 days left) -> Should trigger Expiry/Grace" },
        { day: 12, label: "Day 12 (Past grace) -> Should trigger Suspension" },
    ];

    console.log(`🚀 Starting lifecycle simulation for ${serviceType} ${serviceId}`);
    console.log(`🔗 URL: ${BASE_URL}`);

    for (const step of steps) {
        const simulatedNow = new Date(T.getTime() + step.day * 24 * 60 * 60 * 1000);
        console.log(`\n--- STEP: ${step.label} ---`);
        console.log(`📅 Simulated Time: ${simulatedNow.toISOString()}`);

        try {
            const response = await axios.post(`${BASE_URL}/api/test/automation/trigger`, {
                serviceId,
                serviceType,
                now: simulatedNow.toISOString()
            }, {
                headers: {
                    'Cookie': 'next-auth.session-token=SIMULATED_ADMIN_TOKEN', // This requires real auth or bypassing it in dev
                    'x-cron-secret': CRON_SECRET // We added this to our trigger endpoint too for convenience
                }
            });

            console.log(`✅ Result:`, response.data.schedulerResult || response.data);

            // Fetch status to verify
            const statusRes = await axios.get(`${BASE_URL}/api/test/automation/status`, {
                params: { serviceId, serviceType, now: simulatedNow.toISOString() },
                headers: { 'x-cron-secret': CRON_SECRET }
            });
            console.log(`📊 Current Status:`, statusRes.data.data);

        } catch (err: any) {
            console.error(`❌ Step failed:`, err.response?.data || err.message);
        }
        
        // Wait a bit between steps to let Cloud Tasks/Workers process (if local, it might be instant)
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n✅ Simulation complete!");
}

runSimulation();
