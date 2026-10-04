import AgoraRTC from 'agora-rtc-sdk-ng';
import AgoraRTM from 'agora-rtm';
import { attachCoachAudio } from './coach-audio.mjs';
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  ChatMessagePriority,
  ChatMessageType,
  TranscriptHelperMode,
  TurnStatus,
} from 'agora-agent-client-toolkit';

const ASSISTANT_RESPONSE_TIMEOUT_MS = 60_000;

export class LearnerCoachHandoff {
  constructor(reportStage = () => {}) {
    this.reportStage = reportStage;
    this.rtc = null;
    this.rtm = null;
    this.voiceAi = null;
    this.waitingResponse = null;
    this.releaseAudio = null;
    this.audioFailure = null;
  }

  // Mental model: join the existing agent channel without another microphone,
  // subscribe to RTM, send the backend-owned request, then await one final reply.
  async requestCoachResponse(credentials) {
    validateCredentials(credentials);
    this.reportStage('Connecting to the private coach channel…');
    this.rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.releaseAudio = attachCoachAudio(
      this.rtc,
      credentials.agent_uid,
      this.reportStage,
      (error) => {
        this.audioFailure = error;
        this.waitingResponse?.cancel(error);
      },
    );
    await this.rtc.join(
      credentials.app_id,
      credentials.channel,
      credentials.rtc_token,
      Number(credentials.client_uid),
    );

    this.rtm = new AgoraRTM.RTM(credentials.app_id, credentials.client_uid);
    await this.rtm.login({ token: credentials.rtm_token });
    this.voiceAi = await AgoraVoiceAI.init({
      rtcEngine: this.rtc,
      rtmEngine: this.rtm,
      renderMode: TranscriptHelperMode.TEXT,
      enableLog: false,
    });

    if (this.audioFailure) throw this.audioFailure;
    this.waitingResponse = waitForAssistantResponse(this.voiceAi, credentials.agent_uid);
    this.voiceAi.subscribeMessage(credentials.channel);
    this.reportStage('The AI coach is preparing your feedback…');
    await this.voiceAi.sendText(credentials.agent_uid, {
      messageType: ChatMessageType.TEXT,
      priority: ChatMessagePriority.INTERRUPTED,
      responseInterruptable: false,
      text: credentials.coach_request,
    });
    return this.waitingResponse.promise;
  }

  async close() {
    this.waitingResponse?.cancel();
    this.releaseAudio?.();
    this.voiceAi?.unsubscribe();
    this.voiceAi?.destroy();
    await Promise.allSettled([
      this.rtm?.logout(),
      this.rtc?.leave(),
    ]);
    this.voiceAi = null;
    this.rtm = null;
    this.rtc = null;
    this.waitingResponse = null;
    this.releaseAudio = null;
    this.audioFailure = null;
  }
}

function waitForAssistantResponse(voiceAi, agentUid) {
  let timer;
  let playbackFallback;
  let transcriptHandler;
  let stateHandler;
  let errorHandler;
  let rejectResponse;
  let finalReply;
  let heardSpeech = false;
  const response = new Promise((resolve, reject) => {
    rejectResponse = reject;
    transcriptHandler = (transcript) => {
      finalReply = [...transcript].reverse().find((item) => (
        String(item.uid) === agentUid
        && item.status === TurnStatus.END
        && item.text?.trim()
      ));
      if (finalReply && !playbackFallback) {
        playbackFallback = setTimeout(() => resolve(finalReply.text.trim()), 20_000);
      }
    };
    stateHandler = (uid, event) => {
      if (String(uid) !== agentUid) return;
      if (event?.state === 'speaking') heardSpeech = true;
      if (event?.state === 'silent' && heardSpeech && finalReply) resolve(finalReply.text.trim());
    };
    errorHandler = (_uid, error) => reject(new Error(error?.message || 'The AI coach reported an error.'));
    voiceAi.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, transcriptHandler);
    voiceAi.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, stateHandler);
    voiceAi.on(AgoraVoiceAIEvents.AGENT_ERROR, errorHandler);
    timer = setTimeout(
      () => reject(new Error('The AI coach did not respond within one minute.')),
      ASSISTANT_RESPONSE_TIMEOUT_MS,
    );
  });
  return {
    promise: response.finally(() => {
      clearTimeout(timer);
      clearTimeout(playbackFallback);
      voiceAi.off(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, transcriptHandler);
      voiceAi.off(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, stateHandler);
      voiceAi.off(AgoraVoiceAIEvents.AGENT_ERROR, errorHandler);
    }),
    cancel: (reason = new Error('The AI coach connection was closed.')) => rejectResponse(reason),
  };
}

function validateCredentials(credentials) {
  const requiredText = [
    'app_id',
    'agent_uid',
    'client_uid',
    'channel',
    'rtc_token',
    'rtm_token',
    'coach_request',
  ];
  if (
    !credentials
    || credentials.delivery !== 'client_rtm_send_text'
    || requiredText.some((field) => typeof credentials[field] !== 'string' || !credentials[field])
    || !/^\d+$/.test(credentials.client_uid)
    || !Number.isSafeInteger(Number(credentials.client_uid))
    || Number(credentials.client_uid) > 4_294_967_295
    || !/^\d+$/.test(credentials.agent_uid)
    || Number(credentials.expires_at) <= Math.floor(Date.now() / 1000) + 15
  ) {
    throw new Error('The backend returned invalid or expired coach credentials.');
  }
}
