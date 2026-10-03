const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function normalizeLearnerFeedback(payload) {
  if (!payload || payload.status !== 'ready') return null;
  if (!Array.isArray(payload.words_to_practice) || !Array.isArray(payload.youtube_resources)) return null;
  if (typeof payload.coach_message !== 'string' || payload.coach_message.length > 2000) return null;
  const words = payload.words_to_practice.map(normalizePracticeWord);
  const resources = payload.youtube_resources.map(normalizeYoutubeResource);
  if (words.length > 10 || resources.length > 5 || words.includes(null) || resources.includes(null)) return null;
  return { words, coachMessage: payload.coach_message, resources };
}

export function youtubeEmbedUrl(videoId) {
  return YOUTUBE_VIDEO_ID.test(videoId) ? `https://www.youtube-nocookie.com/embed/${videoId}` : null;
}

export function renderLearnerFeedback(root, payload) {
  const feedback = normalizeLearnerFeedback(payload);
  const words = root.querySelector('#practice-words');
  const coach = root.querySelector('#ai-coach-response');
  const resources = root.querySelector('#youtube-resources');
  words.replaceChildren();
  resources.replaceChildren();
  if (!feedback) {
    words.textContent = 'No reviewed word results yet.';
    coach.textContent = 'No validated AI coach feedback available yet.';
    resources.textContent = 'No recommended practice lessons available yet.';
    return;
  }
  words.replaceChildren(...feedback.words.map(renderPracticeWord));
  if (!feedback.words.length) words.textContent = 'No words marked for additional practice.';
  coach.textContent = feedback.coachMessage;
  resources.replaceChildren(...feedback.resources.map(renderYoutubeResource));
  if (!feedback.resources.length) resources.textContent = 'No recommended practice lessons.';
}

function normalizePracticeWord(item) {
  if (!isBoundedText(item?.word, 80) || !isBoundedText(item?.reason, 300) || !isBoundedText(item?.pronunciation_tip, 300)) return null;
  return { word: item.word, reason: item.reason, pronunciationTip: item.pronunciation_tip };
}

function normalizeYoutubeResource(item) {
  if (!isBoundedText(item?.title, 200) || !youtubeEmbedUrl(item?.video_id)) return null;
  return { title: item.title, videoId: item.video_id };
}

function isBoundedText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function renderPracticeWord(item) {
  const card = document.createElement('div');
  card.className = 'practice-word-card';
  const heading = document.createElement('strong');
  heading.textContent = item.word;
  const reason = document.createElement('span');
  reason.className = 'word-reason';
  reason.textContent = item.reason;
  const tip = document.createElement('p');
  tip.className = 'word-tip';
  tip.textContent = `Tip: ${item.pronunciationTip}`;
  card.append(heading, reason, tip);
  return card;
}

function renderYoutubeResource(item) {
  const container = document.createElement('div');
  const title = document.createElement('p');
  title.textContent = item.title;
  const frame = document.createElement('iframe');
  frame.title = item.title;
  frame.src = youtubeEmbedUrl(item.videoId);
  frame.loading = 'lazy';
  frame.allowFullscreen = true;
  container.append(title, frame);
  return container;
}
