"""Bounded local dialogue history, separate from command approval and execution."""
import copy
import json
import threading
from pathlib import Path
from uuid import uuid4

from .store import atomic_json,now


class ConversationHistory:
    limit=200

    def __init__(self,path):
        self.path=Path(path) if path is not None else None;self.lock=threading.RLock()
        data=json.loads(self.path.read_text()) if self.path and self.path.exists() else {}
        self.epoch=data.get('epoch') or uuid4().hex
        self.messages=data.get('messages',[])[-self.limit:]
        self.cursor=max(data.get('cursor',0),max((m['sequence'] for m in self.messages),default=0))

    def append(self,role,text,*,context,session_id=None,turn=None,source='voice',key=None,created_at=None):
        if not text:return
        with self.lock:
            if key and any(m.get('key')==key for m in self.messages):return
            self.cursor+=1
            message=dict(id=uuid4().hex,sequence=self.cursor,role=role,text=str(text)[:8000],context=context,
                         session_id=session_id,turn=turn,source=source,created_at=created_at or now())
            if key:message['key']=key
            self.messages=[*self.messages,message][-self.limit:]
            if self.path:atomic_json(self.path,dict(epoch=self.epoch,cursor=self.cursor,messages=self.messages))

    def snapshot(self,after=0):
        with self.lock:
            reset=after>self.cursor
            return dict(epoch=self.epoch,cursor=self.cursor,limit=self.limit,reset=reset,
                        messages=copy.deepcopy([m for m in self.messages if reset or m['sequence']>after]))
