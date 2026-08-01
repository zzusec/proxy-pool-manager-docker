/**
 * Live progress bookkeeping for the dashboard.
 *
 * Two things live here. The first is a rate tracker: durable jobs only store a
 * counter, so "how much longer" has to be derived from how fast that counter
 * actually moves right now — an average over the job's whole lifetime would be
 * meaningless for a job that sat interrupted for hours. Samples are per process
 * and deliberately not persisted; a restart simply re-measures.
 *
 * The second is the state of work that has no queue table at all (classification
 * runs), so it can still be reported instead of silently happening.
 */

const samples = new Map();
// Below this the measurement is noise, especially for slow jobs.
const MIN_SAMPLE_SECONDS = 20;
const MAX_SAMPLE_AGE_MS = 30 * 60 * 1000;

/**
 * Record where a job is now and return its current throughput.
 * @returns {{ratePerSecond: number, etaSeconds: number|null}}
 */
export function trackProgress(jobId, completed, total, fallback = null) {
  const now = Date.now();
  let sample = samples.get(jobId);
  // A counter that went backwards means the job was restarted or reset: measure
  // again from here rather than reporting a nonsense rate.
  if (!sample || completed < sample.firstCompleted || now - sample.firstAt > MAX_SAMPLE_AGE_MS) {
    sample = { firstAt: now, firstCompleted: completed };
    samples.set(jobId, sample);
  }
  const elapsed = (now - sample.firstAt) / 1000;
  const done = completed - sample.firstCompleted;
  const remaining = Math.max(0, (total || 0) - completed);
  if (elapsed < MIN_SAMPLE_SECONDS || done <= 0) {
    // Nothing measured in this process yet — use the rate the caller derived
    // from the job's own recent items, so a job that has been running for hours
    // shows a real estimate the moment the dashboard is opened.
    const rate = Number(fallback?.ratePerSecond) || 0;
    return rate > 0 ? { ratePerSecond: rate, etaSeconds: Math.round(remaining / rate) } : { ratePerSecond: 0, etaSeconds: null };
  }
  const ratePerSecond = done / elapsed;
  return { ratePerSecond, etaSeconds: Math.round(remaining / ratePerSecond) };
}


export function forgetProgress(jobId) {
  samples.delete(jobId);
}

let classifyState = { status: 'idle', total: 0, completed: 0, startedAt: null, finishedAt: null, error: null };

export function startClassifyJob(total) {
  classifyState = { status: 'running', total, completed: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
}

export function updateClassifyJob(completed) {
  if (classifyState.status === 'running') classifyState.completed = completed;
}

export function finishClassifyJob(error = null) {
  classifyState = {
    ...classifyState,
    status: error ? 'error' : 'done',
    completed: error ? classifyState.completed : classifyState.total,
    finishedAt: new Date().toISOString(),
    error: error ? String(error).slice(0, 240) : null,
  };
}

export function getClassifyJob() {
  return classifyState;
}
