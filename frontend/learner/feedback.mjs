const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function normalizeLearnerFeedback(payload) {
  if (!payload || payload.status !== 'ready') return null;
  if (!Array.isArray(payload.words_to_practice) || !Array.isArray(payload.youtube_resources)) return null;
  if (typeof payload.coach_message !== 'string' || payload.coach_message.length > 2000) return null;
  const words = payload.words_to_practice.map(normalizePracticeWord);
  const resources = payload.youtube_resources.map(normalizeYoutubeResource);
  if (words.length > 5 || resources.length > words.length || words.includes(null) || resources.includes(null)) return null;
  const practiceItems = words.map((word, index) => ({ word, resource: resources[index] ?? null }));
  return { words, coachMessage: payload.coach_message, resources, practiceItems };
}

export function youtubeEmbedUrl(videoId) {
  return YOUTUBE_VIDEO_ID.test(videoId) ? `https://www.youtube-nocookie.com/embed/${videoId}` : null;
}

export function renderLearnerFeedback(root, payload, transcript = '') {
  const feedback = normalizeLearnerFeedback(payload);
  const section = root.querySelector('#feedback-container');
  const loading = root.querySelector('#feedback-loading');
  const content = root.querySelector('#feedback-content');
  const practice = root.querySelector('#practice-items');
  const coach = root.querySelector('#ai-coach-response');
  section.hidden = !feedback;
  section.setAttribute('aria-busy', 'false');
  loading.hidden = true;
  content.hidden = !feedback;
  practice.replaceChildren();
  if (!feedback) {
    coach.textContent = '';
    renderLearnerTranscript(root, '');
    return;
  }
  renderLearnerTranscript(root, transcript);
  coach.textContent = feedback.coachMessage;
  practice.replaceChildren(...feedback.practiceItems.map(renderPracticeItem));
  if (!feedback.practiceItems.length) {
    practice.textContent = 'No additional focus word was identified for this reading.';
  }
}

export function renderPracticeVideo(root, payload) {
  const section = root.querySelector('#practice-video-container');
  const content = root.querySelector('#practice-video-content');
  const word = normalizePracticeWord(payload?.word);
  const resource = normalizeYoutubeResource(payload?.resource);
  section.hidden = !word || !resource;
  content.replaceChildren();
  if (word && resource) content.append(renderPracticeItem({ word, resource }));
}

export function renderPracticeVideoUnavailable(root, message) {
  root.querySelector('#practice-video-container').hidden = false;
  root.querySelector('#practice-video-content').textContent = message;
}

export function renderLearnerFeedbackPreview(root, words, detail, transcript = '') {
  const normalizedWords = normalizePracticeWords(words);
  const section = root.querySelector('#feedback-container');
  const practice = root.querySelector('#practice-items');
  section.hidden = false;
  section.setAttribute('aria-busy', 'true');
  root.querySelector('#feedback-loading').hidden = true;
  root.querySelector('#feedback-content').hidden = false;
  renderLearnerTranscript(root, transcript);
  root.querySelector('#ai-coach-response').textContent = detail;
  practice.replaceChildren(...normalizedWords.map(word => renderPracticeItem({ word, resource: null }, true)));
  if (!normalizedWords.length) {
    practice.textContent = 'No additional focus word was identified for this reading.';
  }
}

export function renderLearnerFeedbackLoading(root, title, detail) {
  const section = root.querySelector('#feedback-container');
  section.hidden = false;
  section.setAttribute('aria-busy', 'true');
  root.querySelector('#feedback-loading').hidden = false;
  root.querySelector('#feedback-spinner').hidden = false;
  root.querySelector('#feedback-content').hidden = true;
  root.querySelector('#feedback-loading-title').textContent = title;
  root.querySelector('#feedback-loading-detail').textContent = detail;
}

export function renderLearnerFeedbackError(root, message) {
  renderLearnerFeedbackLoading(root, 'Feedback is not available yet', message);
  root.querySelector('#feedback-container').setAttribute('aria-busy', 'false');
  root.querySelector('#feedback-spinner').hidden = true;
}

function normalizePracticeWord(item) {
  return isBoundedText(item, 80) ? item.trim() : null;
}

export function normalizePracticeWords(words) {
  if (!Array.isArray(words) || words.length > 5) return [];
  const normalized = words.map(normalizePracticeWord);
  return normalized.includes(null) ? [] : normalized;
}

function normalizeYoutubeResource(item) {
  if (!isBoundedText(item?.title, 300) || !youtubeEmbedUrl(item?.video_id)) return null;
  return { title: item.title.trim().slice(0, 200), videoId: item.video_id };
}

function isBoundedText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function renderLearnerTranscript(root, transcript) {
  const coach = root.querySelector('#ai-coach-response');
  const card = coach.closest('.coach-card');
  let note = card.querySelector('[data-learner-transcript]');
  if (!note) {
    note = (root.ownerDocument ?? root).createElement('p');
    note.className = 'coach-note';
    note.dataset.learnerTranscript = '';
    card.insertBefore(note, coach);
  }
  const normalized = isBoundedText(transcript, 4000) ? transcript.trim() : '';
  note.hidden = !normalized;
  note.textContent = normalized ? `Transcript: “${normalized}”` : '';
}

function renderPracticeItem(item, pending = false) {
  const container = document.createElement('article');
  container.className = 'practice-item-card';
  const heading = document.createElement('div');
  heading.className = 'practice-item-heading';
  const label = document.createElement('span');
  label.textContent = 'Focus word';
  const word = document.createElement('h3');
  word.textContent = item.word;
  heading.append(label, word);
  container.append(heading);
  if (!item.resource) {
    const unavailable = document.createElement('p');
    unavailable.textContent = pending
      ? 'Finding a safe pronunciation video…'
      : 'No safe video recommendation is available for this word.';
    container.append(unavailable);
    return container;
  }
  const title = document.createElement('p');
  title.textContent = item.resource.title;
  const frame = document.createElement('iframe');
  frame.title = `${item.word}: ${item.resource.title}`;
  frame.src = youtubeEmbedUrl(item.resource.videoId);
  frame.loading = 'lazy';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  container.append(title, frame);
  return container;
}
