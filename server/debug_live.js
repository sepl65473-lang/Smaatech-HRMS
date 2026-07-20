async function debugLive() {
  const renderUrl = 'https://smaatech-hrms-1.onrender.com/api/v1/auth/login';
  console.log('--- Testing Render endpoint ---', renderUrl);
  try {
    const res = await fetch(renderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@smaatech.co',
        password: 'Admin@123'
      })
    });
    console.log('Render Status:', res.status);
    const text = await res.text();
    console.log('Render Response Text:', text);
  } catch (err) {
    console.error('Render Fetch Error:', err.message);
  }

  const vercelProxyUrl = 'https://smaatech-hrms.vercel.app/api/v1/auth/login';
  console.log('\n--- Testing Vercel Proxy endpoint ---', vercelProxyUrl);
  try {
    const res = await fetch(vercelProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@smaatech.co',
        password: 'Admin@123'
      })
    });
    console.log('Vercel Status:', res.status);
    const text = await res.text();
    console.log('Vercel Response Text:', text.slice(0, 300));
  } catch (err) {
    console.error('Vercel Fetch Error:', err.message);
  }
}

debugLive();
