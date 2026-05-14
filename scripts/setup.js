#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const questions = [
  {
    key: 'MONGODB_URI',
    question: 'Enter your MongoDB Atlas connection string: ',
    default: 'mongodb+srv://username:password@cluster.mongodb.net/domain-management'
  },
  {
    key: 'NEXTAUTH_SECRET',
    question: 'Enter NextAuth secret (generate a random string): ',
    default: 'your-nextauth-secret-key-' + Math.random().toString(36).substring(2, 15)
  },
  {
    key: 'NEXTAUTH_URL',
    question: 'Enter your application URL: ',
    default: 'http://localhost:3000'
  },
  {
    key: 'RESELLERCLUB_ID',
    question: 'Enter your ResellerClub ID: ',
    default: 'your-resellerclub-id'
  },
  {
    key: 'RESELLERCLUB_SECRET',
    question: 'Enter your ResellerClub Secret: ',
    default: 'your-resellerclub-secret'
  },
  {
    key: 'RESELLERCLUB_API_URL',
    question: 'Enter ResellerClub API URL: ',
    default: 'https://httpapi.com/api'
  },
  {
    key: 'RAZORPAY_KEY_ID',
    question: 'Enter your Razorpay Key ID: ',
    default: 'your-razorpay-key-id'
  },
  {
    key: 'RAZORPAY_KEY_SECRET',
    question: 'Enter your Razorpay Key Secret: ',
    default: 'your-razorpay-key-secret'
  },
  {
    key: 'SMTP_HOST',
    question: 'Enter SMTP host (Gmail: smtp.gmail.com): ',
    default: 'smtp.gmail.com'
  },
  {
    key: 'SMTP_PORT',
    question: 'Enter SMTP port (Gmail: 587): ',
    default: '587'
  },
  {
    key: 'SMTP_SECURE',
    question: 'Is SMTP secure? (Gmail: false): ',
    default: 'false'
  },
  {
    key: 'SMTP_USER',
    question: 'Enter your Gmail address: ',
    default: 'your-gmail@gmail.com'
  },
  {
    key: 'SMTP_PASS',
    question: 'Enter your Gmail App Password: ',
    default: 'your-app-password'
  },
  {
    key: 'FROM_EMAIL',
    question: 'Enter sender email (same as SMTP_USER): ',
    default: 'your-gmail@gmail.com'
  },
  {
    key: 'FROM_NAME',
    question: 'Enter sender name: ',
    default: 'Domain Management System'
  },
  {
    key: 'ADMIN_EMAIL',
    question: 'Enter admin email: ',
    default: 'admin@example.com'
  },
  {
    key: 'ADMIN_PASSWORD',
    question: 'Enter admin password: ',
    default: 'admin123'
  }
];

async function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question.question, (answer) => {
      resolve(answer || question.default);
    });
  });
}

async function setup() {
  console.log('🚀 Setting up Domain Management System...\n');

  const envVars = {};

  for (const question of questions) {
    const answer = await askQuestion(question);
    envVars[question.key] = answer;
  }

  // Create .env.local file
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.writeFileSync('.env.local', envContent);

  console.log('\n✅ Environment variables saved to .env.local');
  console.log('\n📋 Next steps:');
  console.log('1. Run: npm install');
  console.log('2. Run: npm run dev');
  console.log('3. Open: http://localhost:3000');
  console.log('\n🔧 Don\'t forget to:');
  console.log('- Set up your MongoDB Atlas database');
  console.log('- Configure ResellerClub API credentials');
  console.log('- Set up Razorpay account and get API keys');
  console.log('- Update the admin credentials in your database');

  rl.close();
}

setup().catch(console.error);
