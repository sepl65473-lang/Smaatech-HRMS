async function scanRenderUrls() {
  const candidates = [
    'https://smaatech-hrms-1.onrender.com',
    'https://smaatech-hrms.onrender.com',
    'https://smaatech-hrms-api.onrender.com',
    'https://sepl-hrms.onrender.com',
  ];

  for (const url of candidates) {
    try {
      console.log('Testing:', url);
      const res = await fetch(`${url}/api-docs`, { signal: AbortSignal.timeout(5000) });
      console.log('FOUND ACTIVE SERVICE AT:', url, 'STATUS:', res.status);
      return url;
    } catch (err) {
      console.log('Failed:', url, 'Error:', err.message);
    }
  }
}

scanRenderUrls();
