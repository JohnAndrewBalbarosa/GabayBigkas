export function readConfig(env = process.env) {
  const keys = ['AGORA_APP_ID', 'AGORA_APP_CERTIFICATE', 'AGORA_CUSTOMER_ID', 'AGORA_CUSTOMER_SECRET', 'AGORA_CONVO_TOKEN', 'AGORA_CHAT_HOST', 'AGORA_CHAT_TOKEN', 'AGORA_WHITEBOARD_TOKEN', 'AGORA_EDUCATION_TOKEN'];
  const values = Object.fromEntries(keys.map(key => [key, env[key]?.trim() ?? '']));
  const payloadSecrets = Object.fromEntries(Object.entries(env).filter(([key]) => /^LAB_SECRET_[A-Z\d_]+$/.test(key)));
  return { ...values, payloadSecrets, liveEnabled: env.AGORA_LIVE_ENABLED === 'true', whiteboardRegion: env.AGORA_WHITEBOARD_REGION || 'us-sv', port: Number(env.PORT || 4317) };
}

export function credentialRequirements(product, operation) {
  const auth = product.auth;
  if (operation?.security?.length && operation.security.every(s => Object.keys(s).every(k => /hmac/i.test(k)))) return ['UNSUPPORTED_HMAC_AUTH'];
  if (auth === 'whiteboard') return ['AGORA_WHITEBOARD_TOKEN'];
  if (auth === 'chat') return ['AGORA_CHAT_HOST', 'AGORA_CHAT_TOKEN'];
  if (auth === 'education') return ['AGORA_EDUCATION_TOKEN'];
  if (auth === 'specialized') return ['SPECIALIZED_SETUP'];
  return ['AGORA_CUSTOMER_ID', 'AGORA_CUSTOMER_SECRET'];
}

export function missingCredentials(config, product, operation) {
  if (product.auth === 'convo' && config.AGORA_CONVO_TOKEN) return [];
  return credentialRequirements(product, operation).filter(key => !config[key]);
}

export function publicConfig(config) {
  return { liveEnabled: config.liveEnabled, appId: config.AGORA_APP_ID, credentials: Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('AGORA_')).map(([key, value]) => [key, Boolean(value)])), rtcReady: /^[a-f\d]{32}$/i.test(config.AGORA_APP_ID) && /^[a-f\d]{32}$/i.test(config.AGORA_APP_CERTIFICATE) };
}
