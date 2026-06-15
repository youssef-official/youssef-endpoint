import dotenv from 'dotenv';
import fetch from 'node-fetch'; // if node 18+, native fetch is available, but we can just use native fetch
import { PROVIDERS } from './src/providers.js';

dotenv.config();

async function checkProviders() {
  console.log('🔍 Starting Providers Health Check...\n');
  
  for (const provider of PROVIDERS) {
    console.log(`==================================================`);
    console.log(`Checking Provider: ${provider.name}`);
    console.log(`Model: ${provider.model}`);
    console.log(`URL: ${provider.baseUrl}`);
    
    const keys = provider.getApiKeys();
    if (!keys || keys.length === 0) {
      console.log(`❌ Status: Error - No API keys configured in .env\n`);
      continue;
    }
    
    let isWorking = false;
    for (let i = 0; i < keys.length; i++) {
      const apiKey = keys[i];
      console.log(`  ➔ Testing Key ${i + 1}/${keys.length}...`);
      
      const body = {
        model: provider.model,
        messages: [{ role: 'user', content: 'Hello, this is a health check. Reply with "OK".' }],
        max_tokens: 10
      };
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
        
        const response = await fetch(provider.baseUrl, {
          method: 'POST',
          headers: provider.headers(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          console.log(`  ✅ Status: Working (HTTP ${response.status})`);
          isWorking = true;
          break; // move to next provider if one key works
        } else {
          const errorText = await response.text();
          console.log(`  ❌ Status: Failed (HTTP ${response.status})`);
          console.log(`     Error details: ${errorText.substring(0, 150).replace(/\n/g, ' ')}...`);
        }
      } catch (err) {
        console.log(`  ❌ Status: Error - ${err.message}`);
      }
    }
    
    if (!isWorking) {
      console.log(`\n⚠️  WARNING: All keys failed for ${provider.name}!`);
    }
    console.log();
  }
  
  console.log(`==================================================`);
  console.log('✅ Health Check Completed.');
}

checkProviders();
