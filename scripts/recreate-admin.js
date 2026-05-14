const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '.env.local' });

// User schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

async function recreateAdminUser() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI environment variable is required');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Get admin credentials from environment - REQUIRED for security
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminFirstName = process.env.ADMIN_FIRST_NAME || 'Admin';
    const adminLastName = process.env.ADMIN_LAST_NAME || 'User';

    // Security check: Admin credentials must be set in environment
    if (!adminEmail || !adminPassword) {
      console.error('❌ SECURITY ERROR: ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables');
      console.error('   This prevents unauthorized admin user creation');
      console.error('   Please set these variables in your .env.local file:');
      console.error('   ADMIN_EMAIL=admin@yourdomain.com');
      console.error('   ADMIN_PASSWORD=your-secure-password');
      process.exit(1);
    }

    // Check if admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      console.log('ℹ️  Admin user already exists');
      console.log(`📧 Current admin email: ${existingAdmin.email}`);
      console.log('   To recreate admin, first delete the existing admin user manually');
      console.log('   or set ADMIN_FORCE_RECREATE=true environment variable');

      // Only allow recreation if explicitly forced
      if (process.env.ADMIN_FORCE_RECREATE !== 'true') {
        console.log('   Skipping recreation for security');
        return;
      }

      // Verify credentials match before deletion
      const passwordMatch = await bcrypt.compare(adminPassword, existingAdmin.password);
      if (existingAdmin.email !== adminEmail || !passwordMatch) {
        console.error('❌ SECURITY ERROR: Admin credentials do not match existing admin');
        console.error('   Cannot recreate admin with different credentials');
        process.exit(1);
      }

      await User.deleteOne({ _id: existingAdmin._id });
      console.log('🗑️  Removed existing admin user (credentials verified)');
    }

    // Create new admin user
    const hashedPassword = await bcrypt.hash(adminPassword, 12);

    const adminUser = new User({
      email: adminEmail,
      password: hashedPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      role: 'admin',
      isActive: true,
      isActivated: true,
    });

    await adminUser.save();
    console.log('✅ Admin user created successfully');
    console.log(`📧 Email: ${adminEmail}`);
    console.log(`👤 Name: ${adminFirstName} ${adminLastName}`);
    console.log('🔒 Password: [HIDDEN - from environment]');
    console.log('\n⚠️  Admin user created with credentials from .env.local');

  } catch (error) {
    console.error('❌ Admin user recreation failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the script
recreateAdminUser();
