# 직접 실행 검증 및 추가 오류 수정

검증일: **2026-11-06 (KST)**. Apple M1 Pro / macOS 27.0 / arm64. 이전 보고서의 결과를 재인용하는 대신 현재 코드로 자동 테스트와 실제 서버·브라우저 검사를 다시 실행했다.

## 추가 발견 및 수정

**P2 — 모델 전환 실패 후 재시작 모델이 잘못 기억되는 문제**

새 모델의 로드·워밍업 후 선택 값을 DB에 저장하고, 작업의 완료 상태를 별도로 저장하던 구조였다. 두 번째 기록이 실패하면 실행 중 모델은 이전 버전으로 복구되지만 `selected-{backend}`는 새 버전으로 남았다. 이후 서버 재시작 시 실패했던 새 버전이 선택될 수 있었다.

SQLite 트리거로 작업 완료 기록만 실패하게 만들어 재현했다. 수정 전 테스트는 `현재 모델=이전 모델`, `기억된 모델=v2`로 실패했다. `app/runtime.py`에서 선택 값과 작업 완료를 하나의 트랜잭션으로 기록하고, 성공 후 메모리의 활성 모델을 갱신하도록 수정했다. 수정 후 실패 복구·선택 기억·정상 전환 검사를 모두 통과했다.

회귀 테스트: `tests/test_review_regressions.py::test_failed_switch_does_not_persist_new_selection`.

## 자동 검사 결과

| 검사 | 결과 |
| --- | --- |
| MPS 환경 전체 pytest | **69 passed**, 12.13초 |
| Core ML 환경 전체 pytest | **69 passed**, 11.62초 |
| 학습 환경 전체 pytest | **69 passed**, 11.74초 |
| JavaScript 비동기 UI 테스트 | **5 passed** |
| 세 환경 `pip check` | 모두 의존성 충돌 없음 |
| Python 컴파일·JavaScript 구문·diff 공백 검사 | 통과 |

같은 Python 검사 69개를 세 환경에서 각각 실행한 결과다. 환경별 임시 디렉터리를 분리하여 동시에 검사했다. 각 pytest 실행에 기존 Starlette TestClient의 httpx 지원 중단 예정 경고 1건이 남아 있다. 의존성 버전은 변경하지 않았다.

```bash
bash scripts/python.sh mps -m pytest -q
bash scripts/python.sh coreml -m pytest -q
bash scripts/python.sh train -m pytest -q
node --test tests/training_ui.test.cjs
```

Node는 UI 테스트에만 필요하며 서버 실행에는 필요하지 않다. 이 장비에서는 Codex에 포함된 Node를 사용했다.

## 실제 내장 카메라·브라우저

기존 프로젝트 서버가 없음을 확인하고 `127.0.0.1:8011`에 Core ML 서버를 실행했다. 실제 서비스의 `state/`와 별도인 테스트 저장소를 사용했다.

- 브라우저에서 클래스·환경 등록 → COCO 수집 모델 선택 → 사진 수집 시작 → 저장 중지 → 카메라 끄기를 직접 조작했다.
- 실제 카메라 입력 **1280×720**, 한 시점 탐지 **30.0 FPS**, JPEG **13.0 FPS**, 서버 내부 지연 p95 **28.174ms**를 확인했다. 장시간 성능 보장 수치가 아니다.
- 관측 장면에서는 중앙 조건을 만족하는 물체가 없었다. 낮은 confidence 411프레임, 중앙 이탈 128프레임을 생략하고 **저장 0장**을 유지했다.
- 사진 저장 중지 후 탐지와 미리보기는 유지됐다. 카메라 끄기 후 영상이 사라지고 `camera_off`, `/readyz` 및 `/api/detections/latest`의 **503**을 확인했다.
- 이 카메라 서버를 종료한 다음 공개 이미지 입력 검사를 진행했다.

## 양성 수집부터 새 모델 적용까지

카메라 입력만 공개 COCO128 이미지 두 장으로 대체한 서버를 실행했다. **탐지기·Core ML 추론·파이프라인·JPEG·사진 저장·DB·API·학습은 실제 구현**을 사용했다. 얼룩말과 비행기 이미지를 기능 확인용 단일 클래스로 라벨링했으므로 실제 물체 학습 자료로 사용할 수 없다.

| 직접 실행한 단계 | 확인 결과 |
| --- | --- |
| 브라우저에서 환경 A/B 수집 | 각각 19장·25장, 총 **44장** 저장 |
| 원본·박스 검사 | JPEG 품질 95로 인코딩한 원본과 저장 파일의 바이트 일치. YOLO 라벨을 픽셀 좌표로 복원한 오차 0.00001px 미만 |
| 중복·간격 | 세션 내 중복 frame_id 없음. 인접 저장 시각 간격 250ms 기준 충족 |
| 검토 | 일괄 승인 및 개별 제외. 최종 **43장 승인·1장 제외** |
| 환경 부족 | 첫 환경만 승인한 상태에서 데이터셋 생성 거부 및 추가 촬영 안내 |
| 데이터셋 | train **25장**, validation **18장**. 승인 자료만 포함. 환경 그룹·동일 이미지 해시가 양쪽에 섞이지 않음 |
| 실제 학습 취소 | 50 epoch 작업을 시작해 학습 중 취소. 자식 프로세스 종료, 새 모델 미등록, 이전 COCO 탐지 자동 재개 확인 |
| 실제 학습 완료 | 별도의 **MPS 1 epoch** 학습 → PT 평가 → FP16 Core ML 변환 → 동일 validation 평가 완료 |
| 자동 활성화 방지 | 완료 후에도 활성 모델은 COCO 유지, 사진 저장 재개 없음 |
| 모델 적용 | 브라우저에서 신규 Core ML 모델 선택·적용 후 기존 COCO 모델 복귀 성공 |
| 실제 WebSocket 두 연결 | `ready(COCO) → switching_model → ready(신규 모델)` 확인. 두 연결의 첫 새 결과가 같은 새 session_id와 frame_id를 사용 |
| 실제 HTTP·MJPEG | 최신 결과와 JPEG 헤더의 모델·세션 일치. Content-Length와 JPEG 디코딩 검사 통과 |
| 브라우저 로그 | 마지막 브라우저 검사에서 JS error/warn 로그 없음 |
| 최종 종료 | 카메라 끄기·503 확인 후 테스트 서버 종료. 해당 서버·학습 자식 프로세스 남지 않음 |

취소 작업: `job-d4bf98d2c5f24485b86d93dcb64ad53a`.

완료 작업: `job-15e4d8dcc8bc42eaa76ae255049d3bf7`.

생성 모델: `custom-5ec6183e1160452386c1d033c1ab2854`.

**완료 모델의 PT·Core ML mAP50–95는 모두 0이다.** 이번 검사는 기능 연결과 오류·취소·복구 동작을 확인한 것이다. 적은 독립 이미지와 의도적으로 서로 다른 물체를 합친 테스트 클래스로 실제 인식 품질이나 변환 정확도의 일반적인 보존을 주장할 수 없다. 사용자 물체의 충분한 자료·학습·독립 검증이 별도로 필요하다.

## 증거와 남은 범위

모든 테스트 데이터는 Git에서 제외된 `artifacts/direct-review-dj2t51ug/`에 저장했다. 실제 사용자 저장소·사진·선택 모델은 변경하지 않았다.

| 파일 | 내용 |
| --- | --- |
| `native-camera-check.json` | 실제 카메라 수집·중지 및 준비 상태 |
| `public-inputs.json`, `serve_public.py` | 공개 입력과 카메라 대체 검증 서버 |
| `public-collection-check.json` | 원본·라벨·간격·분할 검사, 학습 중 상태 |
| `cancel-check.json` | 학습 취소·자식 종료·이전 모델 재개 |
| `training-complete-check.json` | 완료 작업·모델별 평가·설정·환경·해시 |
| `websocket-switch-check.json` | 실제 두 WebSocket의 모델 전환 순서 |
| `model-application-check.json` | 새 모델의 HTTP·MJPEG 세션 일치 |
| `final-state.json`, `shutdown-check.json` | COCO 복귀·카메라 끄기·프로세스 종료 |
| `model-versions-camera-off.jpg` | 브라우저 검증 완료 화면 |

실물의 중앙 양성 탐지·실제 사진 저장·박스 일치, 30분 연속 실행, 실제 디스크 소진·전원 중단·메모리 부족은 이번에 확인하지 않았다. 공개 이미지 양성 수집을 실제 카메라 양성 수집으로 계산하지 않는다.

![모델 버전 등록 및 카메라 해제 확인](../artifacts/direct-review-dj2t51ug/model-versions-camera-off.jpg)
