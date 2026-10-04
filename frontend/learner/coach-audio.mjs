export function attachCoachAudio(rtc, agentUid, reportStage, onFailure) {
  const onPublished = async (user, mediaType) => {
    if (mediaType !== 'audio' || String(user.uid) !== agentUid) return;
    try {
      await rtc.subscribe(user, 'audio');
      if (!user.audioTrack) throw new Error('Missing coach audio track');
      user.audioTrack.play();
      reportStage('Playing your Agora voice guide…');
    } catch {
      onFailure(new Error('The Agora voice guide could not play. Check your audio connection.'));
    }
  };
  rtc.on('user-published', onPublished);
  return () => rtc.off('user-published', onPublished);
}
