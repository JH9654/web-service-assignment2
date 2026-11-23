import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  const db = repo.db;

  // fn 안의 모든 DB 작업을 하나의 트랜잭션으로 묶습니다.
  // 성공하면 COMMIT, 오류(검사 실패로 던진 AppError 포함)가 나면 ROLLBACK 후 오류를 다시 던집니다.
  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;   // 오류를 app.js로 넘겨서 400/403/409/500 응답이 나가게 합니다.
    }
  }
  return {
        apply(actor, eventId) {
      return inTransaction(() => {
        // ③ 존재: 행사가 없으면 404
        const event = repo.event(eventId);
        if (!event) throw missing('행사');

        // ④ 권한: 학생만 신청 가능
        if (actor.role !== 'STUDENT') throw forbidden();

        // ⑤ 중복: 상태와 관계없이 기존 신청이 있으면 409
        if (repo.existing(eventId, actor.id)) {
          throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
        }

        // 저장: 신청 + 이력 (inTransaction 안이므로 둘 중 하나라도 실패하면 모두 롤백)
        const application = repo.insert(eventId, actor.id);
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: 'APPLY',
          fromStatus: null,      // 신청 전에는 상태가 없음
          toStatus: 'PENDING'
        });
        return application;
      });
    },
        cancel(actor, applicationId) {
      return inTransaction(() => {
        // ③ 존재: 신청이 없으면 404
        const application = repo.application(applicationId);
        if (!application) throw missing('신청');

        // ④ 권한: 신청한 본인만 취소 가능 (다른 학생, 운영자 모두 403)
        if (application.userId !== actor.id) throw forbidden();

        // ⑤ 상태: PENDING만 취소 가능 (이미 취소됨, 승인됨, 승인 취소됨은 409)
        if (application.status !== 'PENDING') throw invalidState();

        // 저장: 상태 변경 + 이력
        const updated = repo.setStatus(applicationId, 'CANCELLED');
        repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED'
        });
        return updated;
      });
    },
        approve(actor, applicationId) {
      return inTransaction(() => {
        // ③ 존재: 신청이 없으면 404
        const application = repo.application(applicationId);
        if (!application) throw missing('신청');

        // ④ 권한: 운영자이면서 이 신청이 속한 행사의 담당자여야 함
        const event = repo.event(application.eventId);
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();

        // ⑤ 상태: PENDING만 승인 가능
        if (application.status !== 'PENDING') throw invalidState();

        // ⑥ 정원: 현재 APPROVED 인원이 정원 이상이면 거부
        const approvedCount = repo.approvedCount(event.id);
        if (approvedCount >= event.capacity) {
          throw new AppError(409, 'CAPACITY_FULL', '정원이 가득 찼습니다.');
        }

        // 저장: 상태 변경 + 이력
        const updated = repo.setStatus(applicationId, 'APPROVED');
        repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED'
        });
        return updated;
      });
    },
        revoke(actor, applicationId, reason) {
      return inTransaction(() => {
        // ③ 존재: 신청이 없으면 404
        const application = repo.application(applicationId);
        if (!application) throw missing('신청');

        // ④ 권한: 이 행사의 담당 운영자만 승인 취소 가능
        const event = repo.event(application.eventId);
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();

        // ⑤ 상태: APPROVED만 승인 취소 가능 (반복 승인 취소도 여기서 409)
        if (application.status !== 'APPROVED') throw invalidState();

        // [1] 대상 신청을 REVOKED로 변경
        const revoked = repo.setStatus(applicationId, 'REVOKED');

        // [2] REVOKE 이력 저장, 생성된 이력 ID를 자동 승급 이력의 원인으로 사용
        const revokeHistoryId = repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason: reason
        });

        // [3] 같은 행사의 다음 대기자 1명 찾기
        const next = repo.nextPending(event.id);

        // 대기자가 없으면 자리를 비워 둠
        let promoted = null;

        if (next) {
          // [4] 대기자를 APPROVED로 변경
          promoted = repo.setStatus(next.id, 'APPROVED');

          // [5] AUTO_APPROVE 이력: 행위자는 승인 취소한 운영자, 원인은 위의 REVOKE 이력
          repo.addHistory({
            applicationId: next.id,
            actorId: actor.id,
            action: 'AUTO_APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            causeHistoryId: revokeHistoryId
          });
        }

        return { revoked: revoked, promoted: promoted };
      });
    }
  };
}
