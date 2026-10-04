const DECISIONS = [
  ['confirmed_transcript', 'Confirm transcript'],
  ['corrected_transcript', 'Correct transcript'],
  ['insufficient_evidence', 'Insufficient evidence'],
  ['out_of_scope_language', 'Out-of-scope language'],
];

export async function renderAnnotationQueue(api, container, announce = () => {}) {
  stopAnnotationAudio(container);
  container.setAttribute('aria-busy', 'true');
  try {
    const items = await api.annotationQueue();
    container.replaceChildren(...items.map(item => annotationCard(api, item, announce)));
    if (!items.length) container.append(emptyQueue());
    return items.length;
  } finally {
    container.setAttribute('aria-busy', 'false');
  }
}

export function stopAnnotationAudio(root) {
  for (const audio of root.querySelectorAll('audio')) {
    audio.pause();
    if (audio.currentTime > 0) audio.currentTime = 0;
  }
}

function annotationCard(api, item, announce) {
  const card = document.createElement('article');
  card.className = 'review-card';
  card.dataset.annotationId = item.id;

  const header = document.createElement('header');
  header.className = 'review-card-header';
  const title = document.createElement('div');
  const kicker = document.createElement('p');
  kicker.textContent = 'Sentence evidence';
  const heading = document.createElement('h2');
  heading.textContent = item.expected_text;
  title.append(kicker, heading);
  const duration = document.createElement('span');
  duration.textContent = formatRange(item.sentence_start_ms, item.sentence_end_ms);
  header.append(title, duration);

  const evidence = document.createElement('section');
  evidence.className = 'evidence-grid';
  const evidenceHeading = document.createElement('strong');
  evidenceHeading.className = 'panel-kicker';
  evidenceHeading.textContent = 'Transcript evidence';
  evidence.append(
    evidenceHeading,
    evidenceCell('Agora transcript', item.agora_text),
    evidenceCell('BuzzASR transcript', item.buzz_text),
  );

  const body = document.createElement('div');
  body.className = 'review-body';
  body.append(audioEvidence(api, item), evidence, decisionForm(api, item, card, announce));
  card.append(header, body);
  return card;
}

function audioEvidence(api, item) {
  const section = document.createElement('section');
  section.className = 'audio-evidence';
  const heading = document.createElement('strong');
  heading.textContent = 'Private sentence clip';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = api.annotationAudioUrl(item.id);
  const expected = document.createElement('div');
  expected.className = 'expected-phrase';
  const expectedLabel = document.createElement('strong');
  expectedLabel.textContent = 'Expected phrase';
  const expectedText = document.createElement('p');
  expectedText.textContent = item.expected_text;
  expected.append(expectedLabel, expectedText);
  const timing = document.createElement('p');
  timing.textContent = `Focus range: ${formatRange(item.focus_start_ms, item.focus_end_ms)}. Use the full sentence context before deciding.`;
  section.append(heading, audio, timing, expected);
  return section;
}

function decisionForm(api, item, card, announce) {
  const form = document.createElement('form');
  form.className = 'review-form';

  const decisionLabel = document.createElement('label');
  decisionLabel.htmlFor = `decision-${item.id}`;
  decisionLabel.textContent = 'Review decision';
  const decision = document.createElement('select');
  decision.id = `decision-${item.id}`;
  decision.name = 'decision';
  for (const [value, label] of DECISIONS) decision.append(new Option(label, value));

  const correctionLabel = document.createElement('label');
  correctionLabel.htmlFor = `correction-${item.id}`;
  correctionLabel.textContent = 'Corrected transcript';
  const correction = document.createElement('textarea');
  correction.id = `correction-${item.id}`;
  correction.name = 'corrected_text';
  correction.maxLength = 4_000;
  correction.placeholder = 'Enter the corrected sentence';
  correction.disabled = true;
  correctionLabel.hidden = true;
  correction.hidden = true;

  const notesLabel = document.createElement('label');
  notesLabel.htmlFor = `notes-${item.id}`;
  notesLabel.textContent = 'Reviewer notes (optional)';
  const notes = document.createElement('textarea');
  notes.id = `notes-${item.id}`;
  notes.name = 'notes';
  notes.maxLength = 2_000;
  notes.placeholder = 'Add bounded context for this decision';

  const help = document.createElement('p');
  help.className = 'field-help';
  help.textContent = 'Transcript disagreement alone does not prove a pronunciation error.';
  const actions = document.createElement('div');
  actions.className = 'review-form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button button-dark';
  submit.textContent = 'Save decision';
  actions.append(submit);

  decision.addEventListener('change', () => {
    const requiresCorrection = decision.value === 'corrected_transcript';
    correctionLabel.hidden = !requiresCorrection;
    correction.hidden = !requiresCorrection;
    correction.disabled = !requiresCorrection;
    correction.required = requiresCorrection;
    if (!requiresCorrection) correction.value = '';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      await api.decideAnnotation(item.id, {
        decision: decision.value,
        corrected_text: correction.value.trim() || null,
        notes: notes.value.trim() || null,
      });
      stopAnnotationAudio(card);
      card.remove();
      announce('The review decision was saved.');
    } catch (error) {
      announce(error.message, true);
      submit.disabled = false;
    } finally {
      form.setAttribute('aria-busy', 'false');
    }
  });

  form.append(decisionLabel, decision, correctionLabel, correction, notesLabel, notes, help, actions);
  return form;
}

function evidenceCell(label, value) {
  const cell = document.createElement('div');
  cell.className = 'evidence-cell';
  const heading = document.createElement('strong');
  heading.textContent = label;
  const text = document.createElement('p');
  text.textContent = value || 'No transcript evidence';
  cell.append(heading, text);
  return cell;
}

function emptyQueue() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const heading = document.createElement('strong');
  heading.textContent = 'Review queue is clear';
  const detail = document.createElement('p');
  detail.textContent = 'There is no phrase evidence waiting for review.';
  empty.append(heading, detail);
  return empty;
}

function formatRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Timing unavailable';
  return `${formatTime(start)}–${formatTime(end)}`;
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
