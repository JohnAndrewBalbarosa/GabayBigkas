import tokenLibrary from 'agora-token';
import { pathToFileURL } from 'node:url';

export function mintSessionTokens({ appId, appCertificate, channel, clientUid, agentUid, ttl = 600 }) {
  if (!/^[a-f\d]{32}$/i.test(appId ?? '') || !/^[a-f\d]{32}$/i.test(appCertificate ?? '')) throw new Error('Missing Agora app credentials');
  if (!/^coach-[a-f\d]{32}$/.test(channel ?? '') || !/^[1-9]\d{0,9}$/.test(clientUid ?? '') || !/^[1-9]\d{0,9}$/.test(agentUid ?? '')) throw new Error('Invalid channel identity');
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 600) throw new Error('Invalid token lifetime');
  const { RtcTokenBuilder, RtmTokenBuilder, RtcRole } = tokenLibrary;
  return {
    client_rtc_token: RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channel, Number(clientUid), RtcRole.PUBLISHER, ttl, ttl),
    client_rtm_token: RtmTokenBuilder.buildToken(appId, appCertificate, clientUid, ttl),
    agent_token: RtcTokenBuilder.buildTokenWithRtm(appId, appCertificate, channel, agentUid, RtcRole.PUBLISHER, ttl, ttl),
    server_token: RtcTokenBuilder.buildTokenWithRtm(appId, appCertificate, channel, agentUid, RtcRole.PUBLISHER, ttl, ttl),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 4096) throw new Error('Oversized token request');
    }
    const request = JSON.parse(input);
    const tokens = mintSessionTokens({ ...request, appId: process.env.AGORA_APP_ID, appCertificate: process.env.AGORA_APP_CERTIFICATE });
    process.stdout.write(JSON.stringify(tokens));
  } catch {
    process.stderr.write('Agora token generation failed\n');
    process.exitCode = 1;
  }
}
