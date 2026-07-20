async function testVercelProxy() {
  const url = 'https://smaatech-hrms.vercel.app/api/v1/auth/login';
  console.log('Posting login to Vercel proxy:', url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@smaatech.co',
        password: 'Admin@123'
      })
    });
    const status = res.status;
    const text = await res.text();
    console.log('STATUS:', status);
    console.log('RESPONSE:', text);
  } catch (err) {
    console.error('ERROR:', err);
  }
}

testVercelProxy();
