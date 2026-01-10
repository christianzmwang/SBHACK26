/**
 * Environment Variables Verification Script
 * Run this before deploying to check if all required env vars are set
 * 
 * Usage: node verify-env.js
 */

import dotenv from 'dotenv';
dotenv.config();

const REQUIRED_VARS = [
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'FRONTEND_URL',
];

const OPTIONAL_VARS = [
  'NODE_ENV',
  'PORT',
];

console.log('\n[INFO] Checking Environment Variables...\n');

let hasErrors = false;

// Check required variables
console.log('Required Variables:');
REQUIRED_VARS.forEach(varName => {
  const value = process.env[varName];
  if (!value) {
    console.log(`  [ERROR] ${varName}: MISSING`);
    hasErrors = true;
  } else {
    // Mask sensitive values
    let displayValue = value;
    if (varName.includes('KEY') || varName.includes('SECRET') || varName.includes('PASSWORD')) {
      displayValue = value.substring(0, 10) + '...' + value.substring(value.length - 4);
    } else if (varName === 'DATABASE_URL') {
      displayValue = value.substring(0, 20) + '...' + value.substring(value.length - 10);
    }
    console.log(`  [OK] ${varName}: ${displayValue}`);
  }
});

console.log('\nOptional Variables:');
OPTIONAL_VARS.forEach(varName => {
  const value = process.env[varName];
  if (!value) {
    console.log(`  [WARN] ${varName}: Not set (will use default)`);
  } else {
    console.log(`  [OK] ${varName}: ${value}`);
  }
});

// Validate DATABASE_URL format
if (process.env.DATABASE_URL) {
  console.log('\n[INFO] Database Connection:');
  const dbUrl = process.env.DATABASE_URL;
  
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    console.log('  [OK] Valid PostgreSQL connection string format');
    
    // Check for pgvector requirement
    if (dbUrl.includes('supabase')) {
      console.log('  [OK] Supabase detected');
      console.log('  [INFO] Make sure pgvector extension is enabled in Supabase');
    }
  } else {
    console.log('  [ERROR] Invalid DATABASE_URL format (should start with postgresql://)');
    hasErrors = true;
  }
}

// Validate OPENAI_API_KEY format
if (process.env.OPENAI_API_KEY) {
  console.log('\n[INFO] OpenAI Configuration:');
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (apiKey.startsWith('sk-')) {
    console.log('  [OK] Valid OpenAI API key format');
  } else {
    console.log('  [ERROR] Invalid OPENAI_API_KEY format (should start with sk-)');
    hasErrors = true;
  }
}

// Validate FRONTEND_URL
if (process.env.FRONTEND_URL) {
  console.log('\n[INFO] CORS Configuration:');
  const frontendUrl = process.env.FRONTEND_URL;
  
  if (frontendUrl.startsWith('http://') || frontendUrl.startsWith('https://')) {
    console.log('  [OK] Valid frontend URL format');
    
    if (frontendUrl.endsWith('/')) {
      console.log('  [WARN] URL ends with slash - this might cause CORS issues');
      console.log(`     Consider using: ${frontendUrl.slice(0, -1)}`);
    }
    
    if (frontendUrl.includes('localhost') && process.env.NODE_ENV === 'production') {
      console.log('  [WARN] Using localhost in production - this will not work!');
      hasErrors = true;
    }
  } else {
    console.log('  [ERROR] Invalid FRONTEND_URL format (should start with http:// or https://)');
    hasErrors = true;
  }
}

// Final summary
console.log('\n' + '='.repeat(60));
if (hasErrors) {
  console.log('[ERROR] Configuration has errors - please fix before deploying');
  console.log('='.repeat(60) + '\n');
  process.exit(1);
} else {
  console.log('[OK] All required environment variables are set correctly!');
  console.log('='.repeat(60) + '\n');
  console.log('Ready to deploy!\n');
  process.exit(0);
}
