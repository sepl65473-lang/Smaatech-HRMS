async function pingEndpoints() {
  const base = 'https://smaatech-hrms-1.onrender.com';
  console.log('Pinging:', base);

  try {
    const resDocs = await fetch(`${base}/api-docs`, { signal: AbortSignal.timeout(10000) });
    console.log('/api-docs status:', resDocs.status);
  } catch (err) {
    console.error('/api-docs failed:', err.message);
  }
}

pingEndpoints();
