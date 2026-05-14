const mongoose = require('mongoose');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: '.env.local' });

// Simple Schema definitions to avoid importing complex model files
const PendingDomainSchema = new mongoose.Schema({
  domainName: String,
  resellerClubOrderId: String,
}, { collection: 'pendingdomains' });

const PendingDomain = mongoose.models.PendingDomain || mongoose.model('PendingDomain', PendingDomainSchema);

async function deleteOrder(orderId) {
  const url = `${process.env.RESELLERCLUB_API_URL}/api/domains/delete.json`;
  try {
    const response = await axios.post(url, null, {
      params: {
        'auth-userid': process.env.RESELLERCLUB_ID,
        'api-key': process.env.RESELLERCLUB_SECRET,
        'order-id': orderId
      }
    });
    return response.data;
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

async function getOrderId(domainName) {
  const url = `${process.env.RESELLERCLUB_API_URL}/api/domains/orderid.json`;
  try {
    const response = await axios.get(url, {
      params: {
        'auth-userid': process.env.RESELLERCLUB_ID,
        'api-key': process.env.RESELLERCLUB_SECRET,
        'domain-name': domainName
      }
    });
    return response.data; // Usually just the ID as a string or a JSON object
  } catch (error) {
    return null;
  }
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not defined');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to Database');

  const domainName = 'anutechweb.com';
  console.log(`Checking for ${domainName}...`);

  const pendingRecord = await PendingDomain.findOne({ domainName });
  let orderId = pendingRecord ? pendingRecord.resellerClubOrderId : null;

  if (!orderId) {
    console.log('Order ID not found in database. Searching via ResellerClub API...');
    const apiOrderId = await getOrderId(domainName);
    if (apiOrderId && typeof apiOrderId !== 'object') {
        orderId = apiOrderId;
        console.log(`Found Order ID via API: ${orderId}`);
    } else if (apiOrderId && apiOrderId.status === 'error') {
        console.log('API search failed:', apiOrderId.message);
    } else {
        console.log('Could not find Order ID via API search.');
    }
  } else {
    console.log(`Found Order ID in database: ${orderId}`);
  }

  if (orderId) {
    console.log(`Initiating deletion for Order ID: ${orderId}...`);
    const result = await deleteOrder(orderId);
    console.log('Deletion Result:', JSON.stringify(result, null, 2));

    if (result.status === 'success' || result.status === 'Success' || (result.actionstatus && result.actionstatus.toLowerCase().includes('success'))) {
        console.log('SUCCESS: Order cancelled at ResellerClub.');
        if (pendingRecord) {
            await PendingDomain.deleteOne({ _id: pendingRecord._id });
            console.log('Local PendingDomain record removed.');
        }
    } else {
        console.log('FAILURE: Could not cancel order at ResellerClub.');
    }
  } else {
    console.log('ABORTED: No Order ID available for deletion.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
