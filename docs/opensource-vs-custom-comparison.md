# Label Studio·BentoML 활용과 직접 구현 비교

작성일: 2026-11-06 (KST). 현재 Mac 단일 카메라와 [사용자 물체 학습 제안](custom-object-training-proposal.md)을 기준으로 비교한다. 도구를 설치하거나 기존 구조를 변경한 결과가 아니라 도입 검토 자료다.

## 비교 범위

여기서 직접 구현은 모델 학습 알고리즘을 처음부터 만드는 것이 아니라, 기존 Ultralytics·OpenCV·FastAPI를 사용하면서 촬영·검토·학습 작업·모델 버전 UI를 개발하는 방식이다. 도구 활용안은 Label Studio Community Edition과 오픈소스 BentoML을 기준으로 한다.

두 도구는 역할이 다르다. Label Studio는 데이터 라벨링 도구이며 기존 예측 박스를 가져와 사람이 확인·수정할 수 있다. BentoML은 모델을 API 서비스로 구성하고 모델 파일을 저장·버전 관리하는 도구다. 둘을 설치했다고 이 프로젝트의 촬영부터 새 버전 테스트까지 자동으로 연결되는 것은 아니다. [Label Studio 예측 가져오기](https://labelstud.io/guide/predictions), [BentoML 서비스 정의](https://docs.bentoml.com/en/latest/build-with-bentoml/services.html).

## 기능별 비교

| 비교 항목 | 제안안대로 직접 구현 | Label Studio + BentoML 활용 |
| --- | --- | --- |
| 중앙 물체 연속 촬영 | 기존 파이프라인에 촬영 조건·간격·중지 추가 | 두 도구의 기본 기능으로 완성되지 않으므로 같은 수집 코드가 필요 |
| 미검출 시 저장 중단 | 탐지 결과와 같은 프레임을 기준으로 제어 | 수집 서버에서 동일하게 구현 |
| 촬영 전 라벨 이름 입력 | 기존 UI에서 클래스 생성·선택 | UI 클래스와 Label Studio 라벨 설정 간 연결 필요 |
| 탐지 박스 자동 라벨 | 원본 좌표를 YOLO 형식으로 저장 | 기존 박스를 Label Studio prediction으로 변환·등록 |
| 사진·박스 검토 | 썸네일·승인·제외 화면 구현. 좌표 편집은 추가 개발 | Label Studio의 주석 편집·수동 검토 UI 활용 가능 |
| 데이터셋 생성 | 승인 샘플·클래스 매핑·분할 목록을 직접 고정 | 주석 내보내기를 활용하되 승인 샘플 선정·그룹 분할·학습 스냅샷은 별도 구현 |
| YOLOv8 학습 | Ultralytics 실행 작업자·진행률·취소 구현 | Label Studio ML backend의 학습 호출 연결점 활용 가능. 실제 YOLO 학습·작업 정책은 별도 구현 |
| 학습·추론 자원 충돌 | 단일 작업 관리자에서 제어 | 여러 서비스 사이에 별도 상호 배제·종료 정책 필요 |
| 모델 버전 보관 | 파일·해시·매니페스트·DB 직접 관리 | BentoML Model Store의 저장·태그·버전 기능 활용 |
| 실시간 UI의 버전 선택 | 선택·적용·전환 중 상태·복구 직접 구현 | Model Store를 조회·연결하되 UI·실행 중 교체·복구 정책은 직접 구현 |
| MPS·Core ML | 현재 검증한 어댑터 재사용 | 해당 어댑터를 서비스에 연결하고 실제 Mac 호환성 검증 필요 |
| 서비스 패키징 | 현재 FastAPI와 Docker 중계 유지 | BentoML 서비스·배포 패키징을 활용할 수 있으나 기존 수명 관리와 통합 필요 |
| 화면 경험 | 기존 한국어 화면 안에 흐름 통합 | 기본적으로 수집 UI·라벨링 UI가 나뉨. 단일 화면처럼 연결하려면 추가 작업 |
| 개발 부담 | 검토 UI·버전 저장소까지 직접 유지 | 범용 기능 개발을 줄이는 대신 데이터 변환·서비스 연결·업그레이드 대응 증가 |
| 운영 부담 | 서비스 수는 적지만 자체 코드 유지 책임이 큼 | 서비스·설정·영속 데이터 저장 위치가 늘어남. 소규모 로컬 구성에서는 부담이 될 수 있음 |
| 성능 | 기존 최신 프레임 처리 구조에 직접 연결 | 도구 도입 자체가 추론 속도 향상을 보장하지 않음. 서비스 분리 시 전달 비용을 측정해야 함 |

Label Studio의 예측 가져오기·YOLO 내보내기는 [가져오기 문서](https://labelstud.io/guide/predictions)와 [내보내기 문서](https://labelstud.io/guide/export)에 근거한다. 학습 연결점은 [`fit` 구현 문서](https://labelstud.io/guide/ml_create)를 참고한다. BentoML의 모델 저장·버전 기능은 [Model Store 문서](https://docs.bentoml.org/en/latest/build-with-bentoml/model-loading-and-management.html)에 근거한다. 개발 부담·운영 부담·적합성 판단은 이 프로젝트의 현재 구조에 대한 설계 판단이며 개발 일수나 성능을 실측한 비교가 아니다.

## 도입 시 남는 통합 작업

### Label Studio

이미 저장한 이미지와 자동 박스가 있으므로 초기에는 별도 ML backend를 추가하기보다 이를 pre-annotation으로 가져오는 연결부터 시작할 수 있다. 공식 문서도 정적 예측만 가져오는 경우 ML backend 없이 가져오기를 사용할 수 있다고 설명한다. [Label Studio ML 연동](https://labelstud.io/guide/ml.html).

연결 시 프로젝트의 `sample_id`, `class_uuid`, `dataset_version`과 Label Studio task·annotation ID를 매핑해야 한다. Label Studio 사각형 좌표는 이미지 크기에 대한 백분율이므로 픽셀 좌표 및 YOLO 정규화 좌표로 변환을 검증한다. 내보낸 클래스 순서도 기존 클래스 ID와 일치한다고 가정하지 않는다. [좌표 및 내보내기 형식](https://labelstud.io/guide/export).

현재 요구대로 탐지 박스를 그대로 사용하려면 원본 prediction을 보존하고 승인·제외를 우선 사용한다. 박스 편집 기능을 사용하기로 하면 수정본을 별도 annotation revision으로 기록하고, 학습에 원본과 수정본 중 무엇을 사용했는지 데이터셋 버전에 남긴다.

Community Edition에서 수동 검토와 역할 기반 승인 워크플로는 같은 기능이 아니다. 공식 비교표상 역할별 접근 권한, 리뷰어 할당, 자동 active learning 등은 에디션별 차이가 있으므로 무료판에 모두 포함된다고 가정하지 않는다. [에디션 비교](https://labelstud.io/guide/label_studio_compare).

### BentoML

Model Store로 모델 파일 저장을 맡겨도 `버전 ↔ 학습 데이터셋 ↔ 클래스 매핑 ↔ PT/Core ML 검증 결과 ↔ 현재 활성 버전`이라는 프로젝트의 관계와 정책은 구현해야 한다. 파일이 저장된 것과 해당 모델이 현재 서버에서 로드·실행 검증된 것은 구분한다.

공식 GPU 안내는 CUDA 중심 예제를 제공한다. 해당 설정을 MPS나 Neural Engine에 그대로 적용한다고 가정하지 않는다. 이 프로젝트에서는 우선 macOS 네이티브 서비스에서 기존 MPS/Core ML 호출을 감싸 실제 동작을 확인해야 한다. 이 비교에서는 BentoML과 Apple 백엔드의 연동을 실행 검증하지 않았다. [BentoML GPU 안내](https://docs.bentoml.com/en/latest/build-with-bentoml/gpu-inference.html).

도구를 추가해도 카메라·MPS 학습·Core ML 실행은 현재의 Mac 네이티브 경로를 유지하는 구성을 제안한다. 도입된 서비스와 기존 통합 종료 명령의 관계도 설계하여 카메라나 학습 프로세스가 남지 않도록 한다.

## 이 프로젝트에 권장하는 선택

현재처럼 단일 Mac·단일 카메라로 시작한다면, **촬영과 실시간 UI는 직접 구현하고 라벨 검토 도구는 필요에 따라 연결**하는 방식을 권장한다. BentoML은 모델을 여러 서비스에 배포하거나 서빙 운영을 표준화해야 할 때 도입 여부를 검토한다.

| 상황 | 우선 선택 | 판단 이유 |
| --- | --- | --- |
| 클래스가 적고 자동 박스 승인·제외만 필요 | 현재 직접 구현 제안 | 기존 UI와 처리 경로에 집중하고 서비스 수를 줄임 |
| 박스 수정·다중 객체 라벨링·자료 검토량 증가 | 수집·학습 UI + Label Studio | 범용 라벨 편집 화면을 재사용할 이점이 커짐 |
| 모델·서빙 서비스 수 증가, 배포 환경 확대 | 위 구성 + BentoML 검토 | 모델 저장과 서비스 패키징의 재사용 가치가 커짐 |

단계적으로 적용한다면 흐름은 다음과 같다.

```text
직접 구현한 중앙 물체 촬영
  → 원본 이미지 + 자동 박스
  → 간단한 자체 검토 또는 Label Studio
  → 승인 자료 스냅샷 + 그룹 단위 분할
  → Ultralytics MPS 학습 작업자
  → 자체 버전 저장소 또는 BentoML Model Store
  → 기존 실시간 UI에서 버전 선택·테스트
```

어떤 도구를 선택해도 수집 모델이 물체를 탐지하지 못하는 문제는 자동으로 해결되지 않는다. 또한 같은 장면의 연속 사진을 학습·검증으로 나누는 문제, 미완료 학습 모델의 등록 방지, 서버 종료 시 자식 작업 정리는 동일하게 필요하다.
