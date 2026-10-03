import tokenLibrary from 'agora-token';

export function issueToken(config, input) {
  if (!config.liveEnabled) throw Object.assign(new Error('I-enable muna ang live mode sa .env.'), { status: 409 });
  if (!/^[a-f\d]{32}$/i.test(config.AGORA_APP_ID) || !/^[a-f\d]{32}$/i.test(config.AGORA_APP_CERTIFICATE)) throw Object.assign(new Error('Kailangan ang valid Agora App ID at App Certificate sa .env.'), { status: 409 });
  const ttl = input.ttl ?? 900;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw Object.assign(new Error('TTL must be 60–3600 seconds.'), { status: 400 });
  const user = String(input.uid ?? '');
  if (!/^[a-zA-Z\d_-]{1,64}$/.test(user)) throw Object.assign(new Error('Kailangan ang valid user ID.'), { status: 400 });
  let token;
  if (input.type === 'rtc') {
    if (!Number.isInteger(input.uid) || input.uid < 1 || input.uid > 4294967295) throw Object.assign(new Error('RTC UID must be 1–4294967295.'), { status: 400 });
    if (!/^[a-zA-Z\d_-]{1,64}$/.test(input.channel ?? '')) throw Object.assign(new Error('Channel: 1–64 letters, digits, dash, o underscore.'), { status: 400 });
    if (!['publisher', 'subscriber'].includes(input.role ?? 'publisher')) throw Object.assign(new Error('Invalid RTC role.'), { status: 400 });
    const role = input.role === 'subscriber' ? tokenLibrary.RtcRole.SUBSCRIBER : tokenLibrary.RtcRole.PUBLISHER;
    token = tokenLibrary.RtcTokenBuilder.buildTokenWithUid(config.AGORA_APP_ID, config.AGORA_APP_CERTIFICATE, input.channel, input.uid, role, ttl, ttl);
  } else if (input.type === 'rtm') token = tokenLibrary.RtmTokenBuilder.buildToken(config.AGORA_APP_ID, config.AGORA_APP_CERTIFICATE, user, ttl);
  else if (input.type === 'chat') token = tokenLibrary.ChatTokenBuilder.buildUserToken(config.AGORA_APP_ID, config.AGORA_APP_CERTIFICATE, user, ttl);
  else throw Object.assign(new Error('Token type: rtc, rtm, o chat.'), { status: 400 });
  return { token, appId: config.AGORA_APP_ID, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), uid: input.uid };
}
