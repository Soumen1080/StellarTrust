// Test order creation endpoint
import('node-fetch').then(async ({ default: fetch }) => {
  const dotenv = await import('dotenv');
  dotenv.config();

  const API_URL = 'http://localhost:8080';
  const AUTH_TOKEN = process.env.AUTH_DEV_BEARER || 'dev-local-token';

  console.log('Testing order creation...\n');

  try {
    // First, create two test users (buyer and seller)
    console.log('1. Getting demo wallet identity...');
    
    // Use the auth endpoint to get a session
    const authResponse = await fetch(`${API_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        stellarPublicKey: 'GABC123' // dummy for now
      })
    });
    
    if (!authResponse.ok) {
      console.log('Auth not configured, using dev bearer token');
    }

    // Test create order with dev token
    console.log('\n2. Creating an order...');
    const orderData = {
      sellerId: '00000000-0000-4000-8000-000000000002', // dummy seller ID
      amount: {
        amount: '10000',  // 100.00 in minor units
        currency: 'USD'
      }
    };

    const response = await fetch(`${API_URL}/api/payments/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Idempotency-Key': `test-${Date.now()}`
      },
      body: JSON.stringify(orderData)
    });

    console.log('Response status:', response.status, response.statusText);
    
    const responseText = await response.text();
    console.log('\nResponse body:', responseText);

    if (response.ok) {
      const result = JSON.parse(responseText);
      console.log('\n✓ Order created successfully!');
      console.log('Order ID:', result.order?.id);
      console.log('Order status:', result.order?.status);
      console.log('Amount:', result.order?.amount);
    } else {
      console.log('\n✗ Order creation failed');
      try {
        const error = JSON.parse(responseText);
        console.log('Error:', error);
      } catch (e) {
        console.log('Raw error:', responseText);
      }
    }
  } catch (error) {
    console.error('\n✗ Request error:', error.message);
    console.error(error.stack);
  }
}).catch(err => {
  console.error('Failed to load modules:', err);
  console.error('Make sure node-fetch is installed: npm install node-fetch');
  process.exit(1);
});
