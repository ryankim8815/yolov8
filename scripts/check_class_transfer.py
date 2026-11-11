"""CPU memory-only checks of the pinned YOLOv8 class-transfer implementation."""
from copy import deepcopy
from types import SimpleNamespace

import torch
from ultralytics import YOLO
from ultralytics.nn.tasks import DetectionModel

from app.class_transfer import prepare_transfer,verify_transfer
from app.config import ROOT
from app.store import sha256


def main():
    path=ROOT/'models/yolov8n.pt';before=sha256(path)
    source=YOLO(path,task='detect')
    cup=next(i for i,name in source.model.names.items() if name=='cup')
    person=next(i for i,name in source.model.names.items() if name=='person')
    rows=[dict(id=0,name='컵',source_class_id=cup,source_name='cup'),dict(id=1,name='사람',source_class_id=person,source_name='person'),dict(id=2,name='새 상품',source_class_id=None,source_name=None)]
    job=dict(class_plan=dict(classes=rows),dataset=dict(classes=rows))
    expected=prepare_transfer(source,job)
    target=DetectionModel(deepcopy(source.model.yaml),nc=3,verbose=False);target.names={r['id']:r['name'] for r in rows}
    target.load(source.model,verbose=False);verify_transfer(SimpleNamespace(model=target),expected)
    with torch.no_grad():target.model[-1].cv3[0][-1].weight[0]+=1
    try:verify_transfer(SimpleNamespace(model=target),expected)
    except ValueError:pass
    else:raise AssertionError('A mismatched source row must stop training')
    # An explicitly selected cup renamed to "person" must not copy the excluded person row.
    source=YOLO(path,task='detect');rows=[dict(id=0,name='person',source_class_id=cup,source_name='cup')]
    expected=prepare_transfer(source,dict(class_plan=dict(classes=rows),dataset=dict(classes=rows)))
    target=DetectionModel(deepcopy(source.model.yaml),nc=1,verbose=False);target.names={0:'person'}
    target.load(source.model,verbose=False);verify_transfer(SimpleNamespace(model=target),expected)
    source=YOLO(path,task='detect');previous=source.model.model[-1].cv3[0][-1].weight.detach().clone()
    rows=[dict(id=i,name='새 클래스 '+str(i),source_class_id=None,source_name=None) for i in range(80)]
    expected=prepare_transfer(source,dict(class_plan=dict(classes=rows),dataset=dict(classes=rows)))
    assert not torch.equal(previous,source.model.model[-1].cv3[0][-1].weight)
    target=DetectionModel(deepcopy(source.model.yaml),nc=80,verbose=False);target.names={r['id']:r['name'] for r in rows}
    target.load(source.model,verbose=False);verify_transfer(SimpleNamespace(model=target),expected)
    assert sha256(path)==before
    print('PASS: explicit English→Korean class IDs, new output class, excluded-name collision, fail-closed row verification, unchanged checkpoint. CPU memory only; no training or saved weights.')


if __name__=='__main__':main()
