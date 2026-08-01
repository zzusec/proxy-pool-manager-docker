import { listTestJobsOverview, getImportQueue, getCronState, getTestJobRecentRate } from '../db.js';
import { trackProgress, getClassifyJob } from '../services/job-progress.js';

const TEST_JOB_TITLES = {
  full_inspection: '全库双来源检测',
  connectivity: '批量连通性检测',
};

const SCOPE_LABELS = {
  untested: '未检测代理',
  filtered: '当前筛选结果',
  selected: '手动勾选',
  all_current: '全库快照',
};

function testJobDetail(job) {
  const parts = [`存活 ${job.alive}`, `失效 ${job.failed}`, `无法检测 ${job.inconclusive}`];
  if (job.kind === 'full_inspection') {
    parts.push(`不支持协议 ${job.unsupported}`);
    parts.push(`TestISP 成功 ${job.testispSuccess}`);
    parts.push(`ipdata 成功 ${job.ipdataSuccess}`);
  }
  return parts.join(' · ');
}

function describeTestJob(job) {
  const running = job.status === 'pending' || job.status === 'running';
  // Rate is only meaningful while the counter is actually moving.
  const { ratePerSecond, etaSeconds } = running
    ? trackProgress(job.id, job.completed, job.total, { ratePerSecond: getTestJobRecentRate(job.id) })
    : { ratePerSecond: 0, etaSeconds: null };
  return {
    id: job.id,
    kind: job.kind === 'full_inspection' ? 'full_inspection' : 'connectivity',
    title: TEST_JOB_TITLES[job.kind] || '批量检测',
    scope: SCOPE_LABELS[job.scope] || '',
    status: job.status,
    total: job.total,
    completed: job.completed,
    detail: testJobDetail(job),
    error: job.error || null,
    ratePerMinute: ratePerSecond ? +(ratePerSecond * 60).toFixed(1) : 0,
    etaSeconds,
    canCancel: running,
    canResume: job.status === 'error' || job.status === 'canceled',
    updatedAt: job.updatedAt,
  };
}

function describeImportTask(task) {
  const running = task.status === 'processing';
  const id = `import:${task.taskId}`;
  const { ratePerSecond, etaSeconds } = running
    ? trackProgress(id, task.doneChunks, task.totalChunks)
    : { ratePerSecond: 0, etaSeconds: null };
  return {
    id,
    kind: 'import',
    title: '批量导入',
    scope: task.groupName || task.sourceRef || '',
    status: running ? 'running' : task.status,
    total: task.totalChunks,
    completed: task.doneChunks,
    detail: `已入库 ${task.imported} · 重复 ${task.duplicates} · 失败 ${task.errors}（共 ${task.totalLines} 行）`,
    error: null,
    ratePerMinute: ratePerSecond ? +(ratePerSecond * 60).toFixed(1) : 0,
    etaSeconds,
    canCancel: false,
    canResume: false,
    updatedAt: task.createdAt,
  };
}

function describeClassifyJob(job) {
  if (job.status === 'idle') return null;
  const running = job.status === 'running';
  const { ratePerSecond, etaSeconds } = running
    ? trackProgress('classify', job.completed, job.total)
    : { ratePerSecond: 0, etaSeconds: null };
  return {
    id: 'classify',
    kind: 'classify',
    title: 'IP 类型刷新',
    scope: '',
    status: job.status,
    total: job.total,
    completed: job.completed,
    detail: 'ipdata.co 机房 / ISP 判定',
    error: job.error,
    ratePerMinute: ratePerSecond ? +(ratePerSecond * 60).toFixed(1) : 0,
    etaSeconds,
    canCancel: false,
    canResume: false,
    updatedAt: job.finishedAt || job.startedAt,
  };
}

export function setupJobRoutes(app) {
  // GET /api/jobs — every background job in one place, with a live ETA, so the
  // dashboard does not have to know where each kind of work is tracked.
  app.get('/api/jobs', (req, res) => {
    try {
      const jobs = listTestJobsOverview(3).map(describeTestJob);
      const { tasks } = getImportQueue();
      for (const task of tasks.slice(0, 5)) jobs.push(describeImportTask(task));
      const classify = describeClassifyJob(getClassifyJob());
      if (classify) jobs.push(classify);

      const rank = job => (job.status === 'running' || job.status === 'pending' ? 0 : 1);
      jobs.sort((a, b) => rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

      const cron = getCronState();
      res.json({
        jobs,
        active: jobs.filter(job => job.status === 'running' || job.status === 'pending').length,
        cron: {
          status: cron.status,
          lastRunAt: cron.last_run_at,
          classifyCount: cron.classify_count,
          testCount: cron.test_count,
          error: cron.error,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error.message || '读取后台任务失败' });
    }
  });
}
