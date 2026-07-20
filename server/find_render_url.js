async function scanAllPossibleUrls() {
  const candidates = [
    'https://smaatech-hrms-1.onrender.com',
    'https://smaatech-hrms.onrender.com',
    'https://smaatech-hrms-api.onrender.com',
    'https://sepl-hrms.onrender.com',
    'https://smaatech-hrms-server.onrender.com',
    'https://smaatech-hrms-backend.onrender.com',
    'https://smaatech-hrms-web.onrender.com',
    'https://smaatech-hrms-api-1.onrender.com',
    'https://smaatech-hrms-srv.onrender.com',
    'https://smaatech-hrms-2.onrender.com'
  ];

  console.log('Scanning Render URLs...');
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@test.com', password: '123' }),
        signal: AbortSignal.timeout(3000)
      });
      console.log(`FOUND RESPONDING SERVICE AT: ${url} | Status: ${res.status}`);
      const text = await res.text();
      console.log(`Response snippet: ${text.slice(0, 150)}`);
      return url;
    } catch (err) {
      // ignore failures
    }
  }
  console.log('Scanning finished.');
}

scanAllPossibleUrls();
