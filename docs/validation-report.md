# MPS · Core ML 비교 결과

작성일: 2026-11-06 (KST). 아래 수치는 기존 측정 JSON에서 확인했으며, 이 비교를 위해 카메라나 서버를 다시 실행하지 않았다.

## 비교 조건

- 장치: Apple M1 Pro, RAM 16 GiB, macOS 27.0, arm64 Python 3.11.18.
- 공통 가중치: YOLOv8n. 입력 640×640, batch 1, `rect=False`, NMS IoU 0.45, 최대 객체 100개.
- MPS: PyTorch 2.7.0 / torchvision 0.22.0 / Ultralytics 8.4.202.
- Core ML: coremltools 9.0, 정적 입력 FP16 `.mlpackage`, NMS 미포함 출력, `CPU_AND_NE` 명시. 두 경로 모두 Ultralytics의 NMS와 원본 좌표 복원 사용.
- 지연: 같은 순서의 COCO128 이미지를 반복, 각 백엔드 50회 워밍업 후 1,000회 처리. confidence 0.25.
- 정확도: COCO128 전체 128장, confidence 0.001, pycocotools COCOeval. 다른 임계값은 동일.

## 구조와 운영 비교

| 항목 | MPS | Core ML — 현재 프로젝트 설정 |
| --- | --- | --- |
| 실행 경로 | PyTorch의 MPS 백엔드 | 변환한 Core ML 모델을 Apple 런타임으로 실행 |
| 연산 장치 | Metal 기반 Apple GPU | `CPU_AND_NE`: CPU와 Neural Engine 사용 허용, GPU 제외 |
| 모델 파일 | `yolov8n.pt` | FP16 `yolov8n.mlpackage` |
| 준비 과정 | 원본 가중치를 바로 로드 | 원본 가중치에서 변환·출력 검증 필요 |
| 입력 크기 변경 | 서버 환경 변수로 변경 후 재시작 | 현재 모델은 640×640 고정이므로 다른 크기는 재변환 필요 |
| 개발 시 장점 | 원본 모델 교체와 디버깅이 간단 | 이 장비와 모델의 측정에서 처리 지연이 더 짧음 |
| 실행 위치 | Mac의 conda 환경 | Mac의 별도 conda 환경 |
| Docker 역할 | HTTP·MJPEG·WebSocket 중계 | 동일 |
| 통합 실행 | `bash scripts/stack.sh up mps` | `bash scripts/stack.sh up coreml` |

MPS의 GPU 실행 경로는 [PyTorch 공식 문서](https://docs.pytorch.org/docs/stable/notes/mps.html), Core ML의 허용 연산 장치 의미는 [Apple coremltools API 문서](https://apple.github.io/coremltools/source/coremltools.models.html)에 따른다. `CPU_AND_NE` 설정만으로 모든 연산이 Neural Engine에서 실행되었다고 판단할 수는 없다. 연산별 실제 배치는 별도 프로파일링하지 않았다.

## 실측 결과

| 지표 | MPS | Core ML | 해석 |
| --- | ---: | ---: | --- |
| 처리 지연 p50 | 30.142 ms | 7.598 ms | Core ML이 짧음 |
| 처리 지연 p95 | 53.602 ms | 9.051 ms | Core ML이 83.11% 감소 |
| 평균 처리 지연 | 32.981 ms | 7.793 ms | Core ML이 짧음 |
| 오프라인 처리량 — 이미지 디코딩 포함 | 29.30 FPS | 111.00 FPS | Core ML이 약 3.79배 |
| COCO128 mAP50–95 | 43.802% | 43.694% | Core ML이 0.108 percentage point 낮음 |
| COCO128 mAP50 | 60.034% | 60.341% | Core ML이 0.307 percentage point 높음 |

p50은 중앙값, p95는 측정값의 약 95%가 이 값 이하인 지연이다. 처리 지연은 `Detector.predict()` 전체를 측정하므로 전처리·모델 추론·NMS·좌표 복원과 CPU 탐지 결과 생성을 포함한다. 이미지 파일 읽기·디코딩은 지연에서 제외하고, 오프라인 FPS에는 포함한다. 카메라 캡처, JPEG 인코딩, 네트워크 전송, 브라우저 표시는 이 벤치마크에 포함되지 않는다.

이 수치로 Core ML 카메라 영상이 111 FPS라고 해석하면 안 된다. 카메라 입력은 30 FPS 요청, 웹 미리보기는 최대 15 FPS로 별도 제한된다. 서버 내부의 캡처→결과 게시 지연과 브라우저 표시 지연도 위 오프라인 지연과 다른 지표다.

## 권장 판단과 검증 한계

**현재 측정 조건에서는 Core ML을 성능 우선 실행 옵션으로 권장한다.** 사전에 정한 조건인 p95 지연 10% 이상 개선과 mAP50–95 감소 1 percentage point 이내를 모두 충족했다. 코드의 기본 백엔드는 기존 MPS를 유지한다. 원본 모델을 자주 바꾸는 개발 과정에는 MPS가 간단하고, 같은 모델을 반복 서빙할 때는 Core ML의 측정상 이점이 크다.

- 두 백엔드의 결과는 각각 한 번의 1,000회 측정이다. 반복 실험 간 분산이나 신뢰구간은 측정하지 않았다.
- [COCO128](https://docs.ultralytics.com/datasets/detect/coco128/)은 COCO 학습 데이터에서 추출한 작은 샘플이다. 위 정확도는 변환 전후 비교용이며 실제 카메라 환경의 일반화 정확도를 대표하지 않는다.
- MPS의 실제 카메라 및 브라우저 표시를 확인했지만, 두 백엔드의 동등 조건 카메라 비교와 각 30분 연속 실행 결과 파일은 아직 없다. 장시간 안정성 검증이 완료되었다고 판단하지 않는다.
- 전력 소비·발열·배터리 사용량과 브라우저 전체 표시 지연은 측정하지 않았다.

## 원본 기록

- [장치 및 카메라 확인](../artifacts/device-probe.json)
- [MPS 지연·처리량](../artifacts/mps-latency.json)
- [Core ML 지연·처리량](../artifacts/coreml-latency.json)
- [MPS 정확도](../artifacts/mps-accuracy.json)
- [Core ML 정확도](../artifacts/coreml-accuracy.json)
- [모델·데이터 해시 및 변환 옵션](../models/manifest.json)
- 측정 구현: `scripts/benchmark.py`; 실행 절차: [README](../README.md).
