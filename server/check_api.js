async function testRenderLogin() {
  const url = 'https://smaatech-hrms-1.onrender.com/api/v1/auth/login';
  console.log('Posting login to:', url);
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
    const body = await res.json();
    console.log('Status Code:', status);
    console.log('Response Body:', JSON.stringify(body, null, 2));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

testRenderLogin();
