async function pingRenderNow() {
  const url = 'https://smaatech-hrms-1.onrender.com/api/v1/auth/login';
  console.log('Testing:', url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@smaatech.co', password: 'Admin@123' })
    });
    console.log('STATUS CODE:', res.status);
    const body = await res.json();
    console.log('RESPONSE BODY:', JSON.stringify(body, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

pingRenderNow();
