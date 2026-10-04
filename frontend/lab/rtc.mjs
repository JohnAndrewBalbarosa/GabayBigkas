export function setupRtc({ config, api }) {
  const $ = id => document.getElementById(id);
  let preview;
  let client;
  let tracks = [];
  let screen;
  let busy = false;
  const status = message => { $('rtc-status').textContent = message; };

  // Mental model: acquire local media only on a click, join explicitly, always clean up.
  async function join() {
    if (!config.liveEnabled || !config.rtcReady) { status('Live mode, App ID, and App Certificate are required. Local preview works without keys.'); return; }
    if (client) { status('A session is already active. Leave it before joining again.'); return; }
    stopPreview();
    const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
    AgoraRTC.setLogLevel(4);
    AgoraRTC.disableLogUpload();
    const channel = $('channel').value;
    const uid = Number($('uid').value);
    const requestToken = () => api('/api/token', { type: 'rtc', channel, uid, ttl: 900 });
    const credentials = await requestToken();
    client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    client.on('user-published', async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        if (mediaType === 'audio') user.audioTrack.play();
        if (mediaType === 'video') {
          let container = document.getElementById(`remote-${user.uid}`);
          if (!container) { container = document.createElement('div'); container.id = `remote-${user.uid}`; $('remote-video').append(container); }
          user.videoTrack.play(container);
        }
        status(`Receiving remote ${mediaType}. Check the output to confirm its quality.`);
      } catch { status('Could not subscribe to remote media. Check permissions and the connection.'); }
    });
    client.on('user-left', user => document.getElementById(`remote-${user.uid}`)?.remove());
    client.on('token-privilege-will-expire', async () => {
      try { const renewed = await requestToken(); await client?.renewToken(renewed.token); } catch { status('The token could not be renewed. Leave and join again.'); }
    });
    client.on('connection-state-change', (current, _previous, reason) => status(`RTC: ${current}${reason ? ` (${reason})` : ''}.`));
    try {
      await client.join(credentials.appId, channel, credentials.token, uid);
      tracks = $('media-mode').value === 'video' ? await AgoraRTC.createMicrophoneAndCameraTracks() : [await AgoraRTC.createMicrophoneAudioTrack()];
      await client.publish(tracks);
      tracks.find(track => track.trackMediaType === 'video')?.play($('local-video'));
      status('Joined and publishing. Open a second client in the same channel with a different UID to test sending and receiving.');
    } catch (error) { await leave(); throw error; }
  }

  async function shareScreen() {
    if (!client) { status('Join the live channel first.'); return; }
    if (screen) { status('Screen sharing is already active. Use the browser Stop sharing control to end it.'); return; }
    const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
    screen = await AgoraRTC.createScreenVideoTrack({}, 'disable');
    const camera = tracks.find(track => track.trackMediaType === 'video');
    try {
      if (camera) await client.unpublish(camera);
      await client.publish(screen);
      screen.play($('local-video'));
      screen.on('track-ended', async () => {
        try { if (screen) { await client?.unpublish(screen); screen.close(); screen = null; } if (camera && client) { await client.publish(camera); camera.play($('local-video')); } }
        catch { status('The camera could not be restored. Leave and join again.'); }
      });
      status('Live screen sharing.');
    } catch (error) { screen.close(); screen = null; if (camera) await client.publish(camera); throw error; }
  }

  async function leave() {
    stopPreview();
    for (const track of [...tracks, screen].filter(Boolean)) { track.stop(); track.close(); }
    tracks = []; screen = null;
    if (client) { const previous = client; client = null; previous.removeAllListeners(); await previous.leave(); }
    $('local-video').replaceChildren(); $('remote-video').replaceChildren();
    status('You left the channel and local media is closed. Stop any AI, recording, or transcription tasks separately.');
  }

  function stopPreview() {
    preview?.getTracks().forEach(track => track.stop()); preview = null; $('preview').srcObject = null;
  }

  function bind(id, action) {
    $(id).addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try { await action(); } catch (error) { status(`Operation failed: ${error.code || error.name || 'media error'}. Check device permissions, keys, and the network.`); }
      finally { busy = false; }
    });
  }
  bind('rtc-join', join);
  bind('rtc-screen', shareScreen);
  bind('rtc-leave', leave);
  bind('device-preview', async () => {
    if (client) { status('Leave the live session before starting a local preview.'); return; }
    stopPreview();
    preview = await navigator.mediaDevices.getUserMedia({ audio: true, video: $('media-mode').value === 'video' });
    $('preview').srcObject = preview;
    await $('preview').play();
    await waitForLiveMedia(preview);
    status('Local preview only — media tracks are available. Playback is muted to prevent feedback, and no data was sent to Agora.');
  });
  bind('device-stop', () => { stopPreview(); status('Local preview closed.'); });
  window.addEventListener('pagehide', () => { stopPreview(); for (const track of [...tracks, screen].filter(Boolean)) track.close(); });
}

async function waitForLiveMedia(stream) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stream.getTracks().length > 0 && stream.getTracks().every(track => track.readyState === 'live')) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The local microphone or camera did not become ready.');
}
