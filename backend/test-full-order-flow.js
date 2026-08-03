// Complete test: create wallets, authenticate, and create an order
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const API_URL = 'http://localhost:8080';

// Test wallet addresses (testnet format)
const BUYER_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const SELLER_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2';

async function testOrderFlow() {
  console.log('=== StellarTrust Order Creation Test ===\n');

  try {
    // Step 1: Check health
    console.log('1. Checking API health...');
    const health = await fetch(`${API_URL}/health`);
    const healthData = await health.json();
    console.log('✓ API is healthy:', healthData.status);

    // Step 2: Get SEP-10 challenge for buyer
    console.log('\n2. Getting SEP-10 challenge for buyer...');
    const challengeReq = await fetch(`${API_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stellarPublicKey: BUYER_WALLET })
    });

    if (!challengeReq.ok) {
      const error = await challengeReq.text();
      console.log('✗ Challenge failed:', error);
      throw new Error('Failed to get challenge');
    }

    const { challenge, expiresAt } = await challengeReq.json();
    console.log('✓ Got challenge:', challenge.substring(0, 50) + '...');

    // Step 3: In a real scenario, we'd sign the challenge with the wallet
    // For testing, we'll try using the dev bearer token instead
    console.log('\n3. Testing with dev bearer token...');
    
    // First, let's check what auth is configured
    const authCheck = await fetch(`${API_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${process.env.AUTH_DEV_BEARER}` }
    });
    
    console.log('Auth check status:', authCheck.status);
    
    if (authCheck.ok) {
      const me = await authCheck.json();
      console.log('✓ Dev auth works! User:', me);
      
      // Step 4: Create an order
      console.log('\n4. Creating an order...');
      
      // We need a real seller user ID - let's check the database
      // For now, use a placeholder
      const orderData = {
        sellerId: '00000000-0000-0000-0000-000000000002',
        amount: {
          amount: '10000', // $100.00 in minor units
          currency: 'USD'
        }
      };

      const orderReq = await fetch(`${API_URL}/api/payments/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AUTH_DEV_BEARER}`,
          'Idempotency-Key': `test-${Date.now()}`
        },
        body: JSON.stringify(orderData)
      });

      console.log('Order creation status:', orderReq.status, orderReq.statusText);
      const orderResponse = await orderReq.text();
      console.log('Order response:', orderResponse);

      if (orderReq.ok) {
        const order = JSON.parse(orderResponse);
        console.log('\n✓✓✓ ORDER CREATED SUCCESSFULLY! ✓✓✓');
        console.log('Order ID:', order.order?.id);
        console.log('Status:', order.order?.status);
        console.log('Amount:', order.order?.amount);
        console.log('Buyer ID:', order.order?.buyerId);
        console.log('Seller ID:', order.order?.sellerId);
      } else {
        console.log('\n✗✗✗ ORDER CREATION FAILED ✗✗✗');
        try {
          const error = JSON.parse(orderResponse);
          console.log('Error details:', JSON.stringify(error, null, 2));
        } catch (e) {
          console.log('Raw error:', orderResponse);
        }
      }
    } else {
      const authError = await authCheck.text();
      console.log('✗ Dev auth failed:', authError);
      console.log('\nThis means we need to either:');
      console.log('1. Set AUTH_DEMO_WALLET in .env');
      console.log('2. Use real SEP-10 authentication');
      console.log('3. Check if Supabase JWT is overriding dev auth');
    }

  } catch (error) {
    console.error('\n✗✗✗ TEST FAILED ✗✗✗');
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

// Run the test
testOrderFlow();
