/**
 * 状态机测试（§9）。
 *
 * 覆盖 Phase 1 之后的核心约束：合法转移放行、非法转移抛错、终态无自动出边、
 * UNCERTAIN 只能走人工出口。
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidJobTransitionError,
  JOB_STATUS,
  assertTransition,
  canTransition,
  isJobStatus,
  isPublishSettled,
  isTerminalStatus,
  parseJobStatus,
  type JobStatus,
} from './job-status.js';

describe('isTerminalStatus', () => {
  it('SUCCESS / FAILED / UNCERTAIN / CANCELLED / FILTERED 为终态', () => {
    expect(isTerminalStatus(JOB_STATUS.success)).toBe(true);
    expect(isTerminalStatus(JOB_STATUS.failed)).toBe(true);
    expect(isTerminalStatus(JOB_STATUS.uncertain)).toBe(true);
    expect(isTerminalStatus(JOB_STATUS.cancelled)).toBe(true);
    expect(isTerminalStatus(JOB_STATUS.filtered)).toBe(true);
  });

  it('中间态不是终态', () => {
    expect(isTerminalStatus(JOB_STATUS.discovered)).toBe(false);
    expect(isTerminalStatus(JOB_STATUS.publishing)).toBe(false);
  });
});

describe('自动通道的合法转移（§9.1）', () => {
  const happyPath: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
    [JOB_STATUS.discovered, JOB_STATUS.queued],
    [JOB_STATUS.discovered, JOB_STATUS.filtered],
    [JOB_STATUS.queued, JOB_STATUS.processing],
    [JOB_STATUS.processing, JOB_STATUS.mediaProcessing],
    [JOB_STATUS.processing, JOB_STATUS.publishing],
    [JOB_STATUS.mediaProcessing, JOB_STATUS.publishing],
    [JOB_STATUS.publishing, JOB_STATUS.success],
    [JOB_STATUS.publishing, JOB_STATUS.failed],
    // §9.3：发布阶段的超时/504 → UNCERTAIN
    [JOB_STATUS.publishing, JOB_STATUS.uncertain],
  ];

  for (const [from, to] of happyPath) {
    it(`${from} → ${to} 放行`, () => {
      expect(canTransition(from, to, { manual: false })).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });
  }
});

describe('非法转移必须抛错（§9.2）', () => {
  it('DISCOVERED 不能直接跳到 PUBLISHING', () => {
    expect(() =>
      assertTransition(JOB_STATUS.discovered, JOB_STATUS.publishing),
    ).toThrow(InvalidJobTransitionError);
  });

  it('SUCCESS 是终态，自动通道无任何出边', () => {
    expect(() =>
      assertTransition(JOB_STATUS.success, JOB_STATUS.queued),
    ).toThrow(InvalidJobTransitionError);
  });

  it('UNCERTAIN 在自动通道下不能回到 QUEUED（禁止自动重试，§9.3）', () => {
    expect(
      canTransition(JOB_STATUS.uncertain, JOB_STATUS.queued, { manual: false }),
    ).toBe(false);
    expect(() =>
      assertTransition(JOB_STATUS.uncertain, JOB_STATUS.queued, { manual: false }),
    ).toThrow(InvalidJobTransitionError);
  });
});

describe('人工出口（§9.2 / §9.3）', () => {
  it('UNCERTAIN → QUEUED 仅在人工通道放行', () => {
    expect(
      canTransition(JOB_STATUS.uncertain, JOB_STATUS.queued, { manual: true }),
    ).toBe(true);
  });

  it('UNCERTAIN → SUCCESS 仅在人工通道放行', () => {
    expect(
      canTransition(JOB_STATUS.uncertain, JOB_STATUS.success, { manual: true }),
    ).toBe(true);
  });

  it('FAILED → QUEUED 人工重试仅在人工通道放行', () => {
    expect(
      canTransition(JOB_STATUS.failed, JOB_STATUS.queued, { manual: true }),
    ).toBe(true);
    expect(
      canTransition(JOB_STATUS.failed, JOB_STATUS.queued, { manual: false }),
    ).toBe(false);
  });
});

describe('parseJobStatus / isJobStatus', () => {
  it('接受合法状态字符串', () => {
    expect(parseJobStatus('PUBLISHING')).toBe(JOB_STATUS.publishing);
    expect(isJobStatus('UNCERTAIN')).toBe(true);
  });

  it('拒绝非法值', () => {
    expect(isJobStatus('NOT_A_STATUS')).toBe(false);
    expect(isJobStatus(123)).toBe(false);
    expect(() => parseJobStatus('')).toThrow(TypeError);
  });
});

describe('isPublishSettled（§10.4 崩溃恢复判断依据）', () => {
  it('SUCCESS 与 UNCERTAIN 视为已定局，处理器必须立即终止不得重发', () => {
    expect(isPublishSettled(JOB_STATUS.success)).toBe(true);
    expect(isPublishSettled(JOB_STATUS.uncertain)).toBe(true);
  });

  it('其他状态未定局', () => {
    expect(isPublishSettled(JOB_STATUS.publishing)).toBe(false);
    expect(isPublishSettled(JOB_STATUS.queued)).toBe(false);
  });
});
