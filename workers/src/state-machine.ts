/**
 * 状态机转移服务（§9.2）。
 *
 * SyncJob.status 的任何变更都必须经过这里：非法转移在代码层面抛错
 * （shared/job-status.ts 的 assertTransition），并同事务写入 SyncJobEvent 审计记录。
 * 「状态转移 + 审计记录必须同事务」是 §6.4/§9.2 的硬约束——拆开会让详情页的
 * 「完整任务历史」出现缺失或与实际状态矛盾的记录。
 */

import type { JobStatus } from '@x-square/shared';
import { assertTransition, JOB_STATUS } from '@x-square/shared';
import { prisma, withTransaction, type PrismaTransactionClient } from '@x-square/database';

/** 转移附带的上下文，写入 SyncJobEvent.detail 供详情页展示（§17.4）。 */
export interface TransitionDetail {
  filterReason?: string;
  errorCode?: string;
  errorMessage?: string;
  uncertainReason?: string;
  attempt?: number;
  [key: string]: unknown;
}

/**
 * 执行一次合法的状态转移。
 *
 * @param options.manual 仅后台 API 的人工操作传 true（UNCERTAIN→QUEUED/SUCCESS、
 *   FAILED→QUEUED 重试）；Worker 内部一律 false，防止自动逻辑绕过人工确认（§9.3）。
 *
 * @throws InvalidJobTransitionError 非法转移（终态被改写、跳跃等）
 */
export async function transitionJob(
  syncJobId: string,
  to: JobStatus,
  detail: TransitionDetail = {},
  options: { manual?: boolean } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const job = await tx.syncJob.findUniqueOrThrow({ where: { id: syncJobId } });
    // 运行时校验：TS 联合类型只防编译期，队列里的旧载荷可能带任意字符串
    assertTransition(job.status as JobStatus, to, { manual: options.manual === true });

    const data: Record<string, unknown> = { status: to };
    if (detail.filterReason !== undefined) data.filterReason = detail.filterReason;
    if (detail.errorCode !== undefined) data.errorCode = detail.errorCode;
    if (detail.errorMessage !== undefined) data.errorMessage = detail.errorMessage;
    if (detail.uncertainReason !== undefined) data.uncertainReason = detail.uncertainReason;
    if (to === JOB_STATUS.processing && job.startedAt === null) data.startedAt = new Date();
    if (isSettled(to)) data.finishedAt = new Date();

    await tx.syncJob.update({ where: { id: syncJobId }, data });
    await tx.syncJobEvent.create({
      data: {
        syncJobId,
        fromStatus: job.status,
        toStatus: to,
        ...(Object.keys(detail).length > 0 ? { detail: detail as object } : {}),
      },
    });
  });
}

/**
 * 人工出口转移（§9.2 / §12）：UNCERTAIN → QUEUED / SUCCESS、FAILED → QUEUED、取消。
 *
 * operator 进审计事件 detail，满足「谁点的按钮」可追溯（§20.3）。
 */
export async function manualTransition(
  syncJobId: string,
  to: JobStatus,
  operator: string,
  detail: TransitionDetail = {},
): Promise<void> {
  await transitionJob(syncJobId, to, { ...detail, manual: true, operator }, { manual: true });
}

/** 是否进入终态（需要写 finishedAt）。 */
function isSettled(status: JobStatus): boolean {
  return (
    status === JOB_STATUS.success ||
    status === JOB_STATUS.failed ||
    status === JOB_STATUS.uncertain ||
    status === JOB_STATUS.cancelled ||
    status === JOB_STATUS.filtered
  );
}

/** 读取当前权威状态（§10.4：处理器第一步永远是读库校验，而非直接发请求）。 */
export async function getJobStatus(syncJobId: string): Promise<JobStatus | null> {
  const job = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
  return job ? (job.status as JobStatus) : null;
}
