async function testLiveLogin() {
  const url = 'https://smaatech-hrms-1.onrender.com/api/v1/auth/login';
  console.log('Testing live login on:', url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@smaatech.co',
        password: 'Admin@123'
      })
    });
    console.log('RESPONSE STATUS:', res.status);
    const text = await res.text();
    console.log('RESPONSE TEXT:', text);
  } catch (err) {
    console.error('ERROR:', err);
  }
}

testLiveLogin();
