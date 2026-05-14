const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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

async function initializeDatabase() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI environment variable is required');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Check if admin user exists
    const existingAdmin = await User.findOne({ role: 'admin' });

    if (existingAdmin) {
      console.log('ℹ️  Admin user already exists');
      return;
    }

    // Create admin user
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminFirstName = 'Admin';
    const adminLastName = 'User';

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
    console.log(`🔑 Password: ${adminPassword}`);
    console.log('\n⚠️  Please change the admin password after first login!');

  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run if called directly
if (require.main === module) {
  require('dotenv').config({ path: '.env.local' });
  initializeDatabase();
}

module.exports = { initializeDatabase };
